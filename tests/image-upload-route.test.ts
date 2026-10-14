// THI-110 (docs/security.md §6 H3): upload abuse controls on
// POST /api/items/:id/images — route rate limit (429, keyed by seller),
// per-item cap 12, per-seller daily quota (count + bytes), and magic-byte
// validation cross-checked against the declared Content-Type.
// DB-backed over real HTTP, following the admin-route test pattern.

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import sharp from "sharp";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mountApiRoutes, imageUploadLimiter, imageUploadIpLimiter } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import {
  MAX_IMAGES_PER_ITEM,
  MAX_UPLOADS_PER_SELLER_PER_DAY,
  MAX_UPLOAD_BYTES_PER_SELLER_PER_DAY,
} from "../src/images.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}
const available = await dbAvailable();

// Real image fixtures generated at test time with sharp (THI-156): the
// re-encode pipeline decodes every stored upload, so signature-padded junk
// no longer passes — only tests rejected before decode keep using hand-made
// buffers. No binary fixtures live in the repo.
const PNG_BYTES = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 80, g: 120, b: 160 } } })
  .png()
  .toBuffer();
const JPEG_BYTES = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 80, b: 40 } } })
  .jpeg()
  .toBuffer();

describe.skipIf(!available)("item image upload route (DB + HTTP)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let uploadsTmp: string;
  let n = 0;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    // Applies the schema including the new seller_upload_quota block (THI-110).
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE items, sellers, seller_upload_quota RESTART IDENTITY CASCADE");
    // Keep test uploads out of the repo working tree.
    uploadsTmp = await mkdtemp(path.join(os.tmpdir(), "thi110-uploads-"));
    process.env.UPLOADS_DIR = uploadsTmp;
    const app = express();
    app.use(express.json({ limit: "100kb" }));
    mountApiRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    server.close();
    await db.end();
    delete process.env.UPLOADS_DIR;
    await rm(uploadsTmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    imageUploadLimiter.reset();
    imageUploadIpLimiter.reset();
  });

  /** Seeds one seller with one empty-images item; returns ids + session cookie. */
  async function seed(): Promise<{ sellerId: string; itemId: string; cookie: string }> {
    n += 1;
    const tag = `thi110-${n}`;
    const seller = await db.query(
      "INSERT INTO sellers (api_key, display_name, email) VALUES ($1, $2, $3) RETURNING id",
      [`thg_${tag}`, tag, `${tag}@t.dev`],
    );
    const sellerId = seller.rows[0].id as string;
    const item = await db.query(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents) VALUES ($1, $2, 10000, 500) RETURNING id",
      [sellerId, `Upload item ${n}`],
    );
    return { sellerId, itemId: item.rows[0].id as string, cookie: `${SESSION_COOKIE}=${signSession(sellerId)}` };
  }

  const post = (itemId: string, body: Buffer, cookie: string | null, contentType = "image/png") =>
    fetch(`${base}/api/items/${itemId}/images`, {
      method: "POST",
      headers: { "content-type": contentType, ...(cookie ? { cookie } : {}) },
      body: new Uint8Array(body),
    });

  it("401 without a session", async () => {
    const { itemId } = await seed();
    const res = await post(itemId, PNG_BYTES, null);
    expect(res.status).toBe(401);
  });

  it("accepts a real PNG: 200, URL appended, quota row incremented, file on disk", async () => {
    const { sellerId, itemId, cookie } = await seed();
    const res = await post(itemId, PNG_BYTES, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/^\/img\/items\//);

    const images = await db.query("SELECT images FROM items WHERE id = $1", [itemId]);
    expect(images.rows[0].images).toEqual([body.url]);

    const quota = await db.query(
      "SELECT uploads, bytes FROM seller_upload_quota WHERE seller_id = $1 AND day = CURRENT_DATE",
      [sellerId],
    );
    expect(quota.rows[0].uploads).toBe(1);
    expect(Number(quota.rows[0].bytes)).toBe(PNG_BYTES.length);

    const name = body.url.split("/").pop() as string;
    expect(existsSync(path.join(uploadsTmp, "items", name))).toBe(true);
  });

  it("rejects the 13th image with 400 (per-item cap 12)", async () => {
    const { itemId, cookie } = await seed();
    await db.query(
      `UPDATE items SET images = (SELECT array_agg('/img/items/old' || i || '.jpg') FROM generate_series(1, ${MAX_IMAGES_PER_ITEM}) i) WHERE id = $1`,
      [itemId],
    );
    const res = await post(itemId, PNG_BYTES, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/image limit reached/i);
    // No file was written and this seller's quota row was not created on rejection.
    const quota = await db.query(
      "SELECT count(*)::int AS c FROM seller_upload_quota WHERE seller_id = $1",
      [(await db.query("SELECT seller_id FROM items WHERE id = $1", [itemId])).rows[0].seller_id],
    );
    expect(quota.rows[0].c).toBe(0);
  });

  it("rejects a declared jpeg that is actually PNG bytes (signature mismatch)", async () => {
    const { itemId, cookie } = await seed();
    const res = await post(itemId, PNG_BYTES, cookie, "image/jpeg");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/does not match the actual image format \(image\/png\)/i);
  });

  it("rejects non-image bytes with an image content type", async () => {
    const { itemId, cookie } = await seed();
    const res = await post(itemId, Buffer.from("<?php echo 'pwned'; ?>\n" + "A".repeat(4000)), cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unrecognized image data/i);
  });

  it("answers 400, not 500, when a non-image content type leaves a parsed body", async () => {
    const { itemId, cookie } = await seed();
    // Content-Type application/json (< the parser limit) means express.json
    // hands the handler a parsed object, not bytes (THI-123 obs 1 / THI-140).
    const res = await post(itemId, Buffer.from(JSON.stringify({ hello: "world" })), cookie, "application/json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/raw request body/i);
  });

  it("rate-limits a seller past the burst with 429, without touching other sellers", async () => {
    const { sellerId, itemId, cookie } = await seed();
    for (let i = 0; i < 30; i++) {
      expect(imageUploadLimiter.allow(`seller:${sellerId}`)).toBe(true);
    }
    const limited = await post(itemId, JPEG_BYTES, cookie, "image/jpeg");
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: string };
    expect(body.error).toMatch(/Too many uploads/i);

    // Buckets are keyed per seller (H1 lesson: not per IP) — a fresh seller is unaffected.
    const other = await seed();
    const fine = await post(other.itemId, JPEG_BYTES, other.cookie, "image/jpeg");
    expect(fine.status).toBe(200);
  });

  it("429s an anonymous flood at the pre-auth IP gate, before any session lookup", async () => {
    // Pre-drain the shared bucket in-process (same pattern as the seller 429
    // test) instead of a 120-request loop: the contract under test is that the
    // gate answers 429 for an unauthenticated request — no cookie at all.
    const { itemId } = await seed();
    for (let i = 0; i < 120; i++) {
      expect(imageUploadIpLimiter.allow("ip:127.0.0.1")).toBe(true);
    }
    const res = await post(itemId, JPEG_BYTES, null, "image/jpeg");
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Too many uploads/i);
  });

  it("rejects with 400 when the daily upload count quota is exhausted", async () => {
    const { sellerId, itemId, cookie } = await seed();
    await db.query(
      "INSERT INTO seller_upload_quota (seller_id, day, uploads, bytes) VALUES ($1, CURRENT_DATE, $2, 0)",
      [sellerId, MAX_UPLOADS_PER_SELLER_PER_DAY],
    );
    const res = await post(itemId, PNG_BYTES, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/daily upload quota exceeded/i);
    // The rejected upload did not increment the quota.
    const quota = await db.query("SELECT uploads FROM seller_upload_quota WHERE seller_id = $1", [sellerId]);
    expect(quota.rows[0].uploads).toBe(MAX_UPLOADS_PER_SELLER_PER_DAY);
  });

  it("rejects with 400 when the daily byte quota is exhausted", async () => {
    const { sellerId, itemId, cookie } = await seed();
    await db.query(
      "INSERT INTO seller_upload_quota (seller_id, day, uploads, bytes) VALUES ($1, CURRENT_DATE, $2, $3)",
      [sellerId, MAX_UPLOADS_PER_SELLER_PER_DAY - 1, String(MAX_UPLOAD_BYTES_PER_SELLER_PER_DAY)],
    );
    const res = await post(itemId, PNG_BYTES, cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/daily upload quota exceeded/i);
  });

  it("still accepts uploads while the byte quota has room (boundary)", async () => {
    const { sellerId, itemId, cookie } = await seed();
    // Exactly full for one more upload: remaining bytes == upload size.
    const remaining = MAX_UPLOAD_BYTES_PER_SELLER_PER_DAY - PNG_BYTES.length;
    await db.query(
      "INSERT INTO seller_upload_quota (seller_id, day, uploads, bytes) VALUES ($1, CURRENT_DATE, $2, $3)",
      [sellerId, MAX_UPLOADS_PER_SELLER_PER_DAY - 1, String(remaining)],
    );
    const res = await post(itemId, PNG_BYTES, cookie);
    expect(res.status).toBe(200);
    const quota = await db.query("SELECT uploads, bytes FROM seller_upload_quota WHERE seller_id = $1", [sellerId]);
    expect(quota.rows[0].uploads).toBe(MAX_UPLOADS_PER_SELLER_PER_DAY);
    expect(Number(quota.rows[0].bytes)).toBe(MAX_UPLOAD_BYTES_PER_SELLER_PER_DAY);
  });
});
