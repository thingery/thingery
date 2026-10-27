// THI-308 PR 4 (spec rev 2, Security THI-314 F4–F7): DELETE
// /api/items/:id/images/:filename and PUT /api/items/:id/images/order —
// exact-member removal with traversal rejection and unified 404s (F4/F7),
// atomic array_remove / optimistic-guard order writes (F5), external-URL
// members removable, and imageMutationLimiter bucket isolation from the
// upload limiters (F6). DB-backed over real HTTP, following the
// image-upload-route test pattern.

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import http from "node:http";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  mountApiRoutes,
  imageMutationLimiter,
  imageUploadLimiter,
  imageUploadIpLimiter,
} from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { MAX_IMAGES_PER_ITEM } from "../src/images.js";

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

const NOT_FOUND_OR_OWNED = "Item not found or not owned by this seller.";
const INVALID_REF = "Invalid photo reference.";

describe.skipIf(!available)("item image mutation routes (DB + HTTP)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let uploadsTmp: string;
  let n = 0;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query("TRUNCATE items, sellers, seller_upload_quota RESTART IDENTITY CASCADE");
    uploadsTmp = await mkdtemp(path.join(os.tmpdir(), "thi308-mut-"));
    process.env.UPLOADS_DIR = uploadsTmp;
    const app = express();
    app.use(express.json({ limit: "256kb" }));
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
    imageMutationLimiter.reset();
    imageUploadLimiter.reset();
    imageUploadIpLimiter.reset();
  });

  /** Seeds one seller (+ session cookie) and one item with the given images. */
  async function seed(
    images: string[] = [],
    photoRequired = true,
  ): Promise<{ sellerId: string; itemId: string; cookie: string }> {
    n += 1;
    const tag = `thi308m-${n}`;
    const seller = await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, $2, $3) RETURNING id",
      [`thg_${tag}`, tag, `${tag}@t.dev`],
    );
    const sellerId = seller.rows[0].id as string;
    const item = await db.query(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, images, photo_required) VALUES ($1, $2, 10000, 500, $3, $4) RETURNING id",
      [sellerId, `Mutation item ${n}`, images, photoRequired],
    );
    const itemId = item.rows[0].id as string;
    return {
      sellerId,
      itemId,
      cookie: `${SESSION_COOKIE}=${signSession(sellerId)}`,
    };
  }

  /** Writes a fake stored file under uploads/items/ and returns its member URL. */
  async function storedFile(itemId: string, suffix = "abc123.jpg"): Promise<string> {
    const name = `${itemId}-${suffix}`;
    await mkdir(path.join(uploadsTmp, "items"), { recursive: true });
    await writeFile(path.join(uploadsTmp, "items", name), Buffer.from("fake image bytes"));
    return `/img/items/${name}`;
  }

  const del = (itemId: string, ref: string, cookie: string | null) =>
    fetch(`${base}/api/items/${itemId}/images/${encodeURIComponent(ref)}`, {
      method: "DELETE",
      ...(cookie ? { headers: { cookie } } : {}),
    });

  const putOrder = (itemId: string, images: string[], cookie: string | null) =>
    fetch(`${base}/api/items/${itemId}/images/order`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ images }),
    });

  const dbImages = async (itemId: string) =>
    (await db.query("SELECT images FROM items WHERE id = $1", [itemId])).rows[0].images as string[];

  /** Raw-socket DELETE that bypasses WHATWG URL dot-segment normalization
   *  (fetch/undici rewrite `%2E%2E` before the request ever leaves) — the
   *  server-side gate must reject such references on its own. */
  function rawDelete(itemId: string, encodedRef: string, cookie: string): Promise<{ status: number; body: { error: string } }> {
    const { request } = http;
    const url = new URL(base);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          path: `/api/items/${itemId}/images/${encodedRef}`,
          method: "DELETE",
          headers: { cookie },
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  // --- DELETE: auth, exact-member match, ownership (F4/F7) ------------------

  it("401 without a session", async () => {
    const { itemId } = await seed(["/img/items/x-1.jpg"]);
    const res = await del(itemId, "x-1.jpg", null);
    expect(res.status).toBe(401);
  });

  it("removes an exact member of the seller's own item and unlinks the stored file", async () => {
    const { itemId, cookie, stored } = await seed([]);
    const member = await storedFile(itemId);
    await db.query("UPDATE items SET images = $2 WHERE id = $1", [itemId, [member]]);
    const res = await del(itemId, member.slice("/img/items/".length), cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: string[]; visible: boolean };
    expect(body.images).toEqual([]);
    expect(body.visible).toBe(false); // photo_required + now zero photos
    expect(body).toHaveProperty("warning");
    expect(await dbImages(itemId)).toEqual([]);
    expect(existsSync(path.join(uploadsTmp, "items", member.slice("/img/items/".length)))).toBe(false);
  });

  it("rejects traversal-shaped references with 400 + the fixed string (no echo)", async () => {
    const { itemId, cookie } = await seed([]);
    // `del` percent-encodes, so `../` travels the wire as `..%2F` — Express
    // decodes path params AFTER routing, exercising the in-handler gate.
    for (const bad of ["a/b.jpg", "../", "a\\b.jpg", "../../etc/passwd", "x\u0000.jpg"]) {
      const res = await del(itemId, bad, cookie);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(INVALID_REF); // fixed string — the reference is never echoed
    }
    // A single non-dot segment can still smuggle separators once decoded:
    // `%2e%2e%2f…` arrives as `../../…` at the handler and must die there.
    for (const encoded of ["%2e%2e%2f%2e%2e%2fsecret", "img.jpg%2f..%2f..%2fsecret"]) {
      const res = await fetch(`${base}/api/items/${itemId}/images/${encoded}`, { method: "DELETE", headers: { cookie } });
      expect(res.status, encoded).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(INVALID_REF);
    }
    // Pure dot segments (`..`, `.`) are normalized away by spec-compliant
    // clients (WHATWG URL), so prove the in-handler gate with a raw socket
    // client that sends the path verbatim — defense-in-depth for hostile
    // non-browser clients (curl sends these untouched).
    for (const encoded of ["%2E%2E", "%2E", ".%2e", "%2e."]) {
      const res = await rawDelete(itemId, encoded, cookie);
      expect(res.status, encoded).toBe(400);
      expect(res.body.error).toBe(INVALID_REF);
    }
    expect(await dbImages(itemId)).toEqual([]);
  });

  it("answers the unified 404 for a foreign item, a missing item and a non-member — identical bodies (F7)", async () => {
    const mine = await seed(["/img/items/mine-1.jpg"]);
    const foreign = await seed(["/img/items/foreign-1.jpg"]);
    const cases = [
      ["foreign item, own-looking member", await del(foreign.itemId, "foreign-1.jpg", mine.cookie)],
      ["random item id", await del("00000000-0000-4000-8000-000000000000", "mine-1.jpg", mine.cookie)],
      ["own item, not a member", await del(mine.itemId, "ghost-9.jpg", mine.cookie)],
    ] as const;
    for (const [label, res] of cases) {
      expect(res.status, label).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(NOT_FOUND_OR_OWNED); // one fixed string — no enumeration oracle
    }
    expect(await dbImages(mine.itemId)).toEqual(["/img/items/mine-1.jpg"]); // nothing was removed
  });

  it("removes an external-URL member (F4-secondary) without touching the filesystem", async () => {
    const external = "https://cdn.example.com/pics/a.jpg";
    const { itemId, cookie } = await seed([external, "/img/items/keep-1.jpg"]);
    const res = await del(itemId, external, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: string[]; visible: boolean };
    expect(body.images).toEqual(["/img/items/keep-1.jpg"]); // append survives (atomic array_remove)
    expect(body.visible).toBe(true);
    expect(await dbImages(itemId)).toEqual(["/img/items/keep-1.jpg"]);
  });

  it("never unlinks another item's file even when its URL is a member here (F4: own-prefix only)", async () => {
    const { itemId, cookie } = await seed([]);
    const other = await seed([]);
    const foreignMember = await storedFile(other.itemId); // real file, other item's prefix
    await db.query("UPDATE items SET images = $2 WHERE id = $1", [itemId, [foreignMember]]);
    const res = await del(itemId, foreignMember.slice("/img/items/".length), cookie);
    expect(res.status).toBe(200);
    expect(await dbImages(itemId)).toEqual([]);
    // The file belongs to the other item — it must still be on disk.
    expect(existsSync(path.join(uploadsTmp, "items", foreignMember.slice("/img/items/".length)))).toBe(true);
  });

  it("returns visible:true without a warning for non-last deletes and grandfathered items", async () => {
    const two = await seed(["/img/items/a-1.jpg", "/img/items/a-2.jpg"]);
    let res = await del(two.itemId, "a-1.jpg", two.cookie);
    let body = (await res.json()) as { images: string[]; visible: boolean; warning?: string };
    expect(res.status).toBe(200);
    expect(body.visible).toBe(true);
    expect(body).not.toHaveProperty("warning");

    const grandfathered = await seed(["/img/items/g-1.jpg"], false);
    res = await del(grandfathered.itemId, "g-1.jpg", grandfathered.cookie);
    body = (await res.json()) as { images: string[]; visible: boolean; warning?: string };
    expect(res.status).toBe(200);
    expect(body.images).toEqual([]);
    expect(body.visible).toBe(true); // photo_required=false stays live with zero photos
    expect(body).not.toHaveProperty("warning");
  });

  it("does not lose a photo appended concurrently with the delete (F5 atomic statement)", async () => {
    const { itemId, cookie } = await seed(["/img/items/race-1.jpg"]);
    const appended = "/img/items/race-2.jpg";
    // Both orderings must converge on [appended]: array_remove never
    // overwrites the array with a stale read (the F5 read-modify-write bug).
    await Promise.all([
      db.query("UPDATE items SET images = images || $2 WHERE id = $1", [itemId, [appended]]),
      del(itemId, "race-1.jpg", cookie),
    ]);
    expect(await dbImages(itemId)).toEqual([appended]);
  });

  // --- PUT order: permutation + optimistic-concurrency guard (F5) ----------

  it("401 without a session (PUT)", async () => {
    const { itemId } = await seed(["/img/items/a-1.jpg"]);
    const res = await putOrder(itemId, ["/img/items/a-1.jpg"], null);
    expect(res.status).toBe(401);
  });

  it("accepts an exact permutation and is replay-safe on the same body", async () => {
    const a = "/img/items/a-1.jpg";
    const b = "/img/items/a-2.jpg";
    const c = "/img/items/a-3.jpg";
    const { itemId, cookie } = await seed([a, b, c]);
    const res = await putOrder(itemId, [c, a, b], cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { images: string[] }).images).toEqual([c, a, b]);
    // Replay: the write still matches (images is already $next) → 200 no-op.
    const replay = await putOrder(itemId, [c, a, b], cookie);
    expect(replay.status).toBe(200);
    expect(await dbImages(itemId)).toEqual([c, a, b]);
  });

  it("rejects partial, duplicate, foreign and malformed sets with 400", async () => {
    const a = "/img/items/p-1.jpg";
    const b = "/img/items/p-2.jpg";
    const c = "/img/items/p-3.jpg";
    const { itemId, cookie } = await seed([a, b, c]);
    const badSets = [
      [a, b], // partial
      [a, a, c], // duplicate
      [a, b, "/img/items/ghost-1.jpg"], // foreign reference
      [a, b, c, c], // longer than current
      [], // empty is not a permutation of a non-empty set
    ];
    for (const set of badSets) {
      const res = await putOrder(itemId, set, cookie);
      expect(res.status, JSON.stringify(set)).toBe(400);
    }
    expect(await dbImages(itemId)).toEqual([a, b, c]); // nothing changed
    // zod shape failures (non-array / >12 elements) share the 400 fixed string.
    const shapeRes = await fetch(`${base}/api/items/${itemId}/images/order`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ images: "nope" }),
    });
    expect(shapeRes.status).toBe(400);
    const overRes = await putOrder(itemId, Array<string>(MAX_IMAGES_PER_ITEM + 1).fill(a), cookie);
    expect(overRes.status).toBe(400);
  });

  it("answers the unified 404 for a foreign item (PUT)", async () => {
    const mine = await seed(["/img/items/m-1.jpg"]);
    const foreign = await seed(["/img/items/f-1.jpg"]);
    const res = await putOrder(foreign.itemId, ["/img/items/f-1.jpg"], mine.cookie);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(NOT_FOUND_OR_OWNED);
  });

  it("409s with a re-read when the array changed between read and write (F5 optimistic guard)", async () => {
    const a = "/img/items/o-1.jpg";
    const b = "/img/items/o-2.jpg";
    const { itemId, cookie } = await seed([a, b]);
    // Hold a row lock with an uncommitted reorder; the route's SELECT still
    // sees [a,b] (read committed), validates the permutation, then its
    // guarded UPDATE either blocks on the lock or re-checks after commit —
    // either way zero rows → 409 + the committed array.
    const lock = new pg.Client({ connectionString });
    await lock.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("UPDATE items SET images = $2 WHERE id = $1", [itemId, [b, a]]);
      const inFlight = putOrder(itemId, [b, a], cookie); // valid permutation of [a,b]
      await new Promise((r) => setTimeout(r, 300)); // let the route read first
      await lock.query("COMMIT");
      const res = await inFlight;
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; images: string[] };
      expect(body.images).toEqual([b, a]); // re-read carries the current set
      expect(await dbImages(itemId)).toEqual([b, a]); // the stale write did not land
    } finally {
      await lock.end();
    }
  });

  // --- limiter bucket isolation (F6) ----------------------------------------

  it("mutation churn 429s without consuming the upload quota", async () => {
    const { sellerId, itemId, cookie, stored } = await seed([]);
    const member = await storedFile(itemId);
    await db.query("UPDATE items SET images = $2 WHERE id = $1", [itemId, [member]]);
    for (let i = 0; i < 60; i++) {
      expect(imageMutationLimiter.allow(`seller:${sellerId}`)).toBe(true);
    }
    const blocked = await del(itemId, member.slice("/img/items/".length), cookie);
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/Too many photo changes/i);
    // The upload limiter is a different bucket — an upload is not affected.
    expect(imageUploadLimiter.allow(`seller:${sellerId}`)).toBe(true);
    expect(await dbImages(itemId)).toEqual([member]); // the delete did not go through
  });

  it("an exhausted upload quota does not block mutations", async () => {
    const { sellerId, itemId, cookie, stored } = await seed([]);
    const member = await storedFile(itemId);
    await db.query("UPDATE items SET images = $2 WHERE id = $1", [itemId, [member]]);
    for (let i = 0; i < 30; i++) {
      expect(imageUploadLimiter.allow(`seller:${sellerId}`)).toBe(true);
    }
    const res = await del(itemId, member.slice("/img/items/".length), cookie);
    expect(res.status).toBe(200);
    expect(await dbImages(itemId)).toEqual([]);
  });
});
