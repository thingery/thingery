// THI-111 (security doc §6 H3, URL-allowlist bullet): create_listing image
// URLs are scheme-allowlisted to http(s). z.string().url() validates URL
// *shape* only — javascript:, data: and file: URLs passed it on main and were
// stored on items (buyer-IP leak via tracking pixels on third-party hosts,
// indirect-content/script-scheme footgun for naive clients).
//
// Also locks the effective /mcp body limits that the add_item_image docs
// state (same H3 bullet, doc-alignment sub-item): the gate's 8 MiB cap — not
// the SDK's 4 MiB default — is the binding request limit, because the gate
// pre-parses the body and hands it to the transport, which then skips
// readRequestBody entirely. A full 5 MB image (~6.7 MB base64+JSON) must go
// through; an over-gate body must 413. The third block needs Postgres; the
// first two are in-process only.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { apiKeyHash } from "../src/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/tools.js";
import { buildServer } from "../src/server.js";
import { mcpRoutes, MCP_MAX_BODY_BYTES } from "../src/mcp-gate.js";
import { RateLimiter } from "../src/rate-limit.js";

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

// ---------------------------------------------------------------- schema

interface Captured {
  config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
}

describe("create_listing images: http(s) scheme allowlist (schema)", () => {
  const registered = new Map<string, Captured>();

  registerTools(
    {
      registerTool(name: string, config: Captured["config"]) {
        registered.set(name, { config });
      },
    } as never,
    { seller: null },
  );

  const schema = z.object(registered.get("create_listing")!.config.inputSchema!);
  const base = { title: "Valid title", price_cents: 12500 };
  const parseImages = (images: unknown) => schema.safeParse({ ...base, images });

  it("accepts https and http image URLs (incl. uppercase scheme)", () => {
    expect(parseImages(["https://example.com/a.jpg"]).success).toBe(true);
    expect(parseImages(["http://example.com/a.jpg"]).success).toBe(true);
    expect(parseImages(["HTTPS://EXAMPLE.COM/A.JPG"]).success).toBe(true);
  });

  it("still defaults to [] and keeps the 12-image cap", () => {
    const r = schema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.images).toEqual([]);
    expect(parseImages(Array.from({ length: 12 }, () => "https://e.com/x.jpg")).success).toBe(true);
    expect(parseImages(Array.from({ length: 13 }, () => "https://e.com/x.jpg")).success).toBe(false);
  });

  it("rejects javascript:, data: and file: URLs with the http(s) message", () => {
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,iVBORw0KGgo=", "file:///etc/passwd"]) {
      const r = parseImages([bad]);
      expect(r.success, bad).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toContain("http(s)");
    }
  });

  it("rejects a mixed array containing one non-http(s) URL", () => {
    const r = parseImages(["https://example.com/a.jpg", "javascript:alert(1)"]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain("http(s)");
  });

  it("bounds each image URL to 2048 characters (THI-130)", () => {
    // Before THI-130 the only bound was the 8 MiB /mcp body gate, so a single
    // listing could carry ~7 MiB of URL text across its 12 images.
    const atLimit = `https://e.com/${"a".repeat(2048 - "https://e.com/".length)}`;
    expect(atLimit.length).toBe(2048);
    expect(parseImages([atLimit]).success).toBe(true);
    const overLimit = `${atLimit}x`;
    const r = parseImages([overLimit]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain("2048");
  });
});

// ------------------------------------------------- MCP transport (SDK layer)

describe("create_listing images: scheme allowlist through the MCP transport", () => {
  it("a javascript: URL fails input validation before the handler (typed error)", async () => {
    const server = buildServer({ seller: null });
    const client = new Client({ name: "thi111-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      // The SDK renders the InvalidParams (-32602) McpError from its zod parse
      // as a typed isError result — never reaching our handler.
      const res = (await client.callTool({
        name: "create_listing",
        arguments: { title: "Valid title", price_cents: 12500, images: ["javascript:alert(1)"] },
      })) as { isError?: boolean; content?: { text?: string }[] };
      expect(res.isError).toBe(true);
      const text = res.content?.[0]?.text ?? "";
      expect(text).toContain("-32602");
      expect(text).toContain("http(s)");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("an https URL passes validation and reaches the handler", async () => {
    const server = buildServer({ seller: null });
    const client = new Client({ name: "thi111-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      // No seller in the context, so the handler itself answers with its typed
      // `unauthorized` error — proof the images array cleared the schema.
      const res = (await client.callTool({
        name: "create_listing",
        arguments: { title: "Valid title", price_cents: 12500, images: ["https://example.com/a.jpg"] },
      })) as { isError?: boolean; content?: { text?: string }[] };
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content?.[0]?.text ?? "{}") as { code?: string };
      expect(body.code).toBe("unauthorized");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ------------------------------------------- /mcp body limits (HTTP, gate)

describe.skipIf(!available)("/mcp body limits for add_item_image (HTTP)", () => {
  let server: Server;
  let baseUrl: string;
  let db: pg.Client;
  let apiKey: string;

  beforeAll(async () => {
    const app = express();
    app.use(
      mcpRoutes({ authedLimiter: new RateLimiter(10, 60_000), anonLimiter: new RateLimiter(10, 60_000) }),
    );
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
    db = new pg.Client({ connectionString });
    await db.connect();
    apiKey = `thg_thi111_${crypto.randomBytes(4).toString("hex")}`;
    await db.query(
      `INSERT INTO sellers (api_key_hash, display_name, email, password_hash)
       VALUES ($1, $2, $3, 'x')`,
      [apiKeyHash(apiKey), "THI-111 Body Cap", `thi111-${Date.now()}@example.com`],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM sellers WHERE api_key_hash = $1`, [apiKeyHash(apiKey)]);
    await db.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (body: string): Promise<Response> =>
    fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${apiKey}`,
      },
      body,
    });

  const call = (imageBase64: string): string =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "add_item_image",
        arguments: { item_id: crypto.randomUUID(), image_base64: imageBase64, media_type: "image/png" },
      },
    });

  it("the gate cap stays 8 MiB (drift lock for the documented ceiling)", () => {
    expect(MCP_MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
  });

  it("a full 5 MB image (~6.7 MB base64+JSON) passes the gate and reaches the tool", async () => {
    const fiveMb = Buffer.alloc(5 * 1024 * 1024, 7);
    // THI-110: add_item_image now magic-byte-validates before the ownership
    // read, so the fixture must carry a real PNG signature (rest of the buffer
    // is filler — signature-level check by design) to still reach the tool's
    // owner check, which is what this test proves.
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fiveMb);
    const body = call(fiveMb.toString("base64"));
    expect(body.length).toBeGreaterThan(6 * 1024 * 1024); // over the SDK's 4 MiB default
    expect(body.length).toBeLessThan(MCP_MAX_BODY_BYTES);
    const res = await post(body);
    expect(res.status).toBe(200); // not 413: neither the SDK's 4 MiB default nor the gate
    const text = await res.text();
    // The tool itself executed and answered with its owner-check error (the
    // item id is random) — proof the payload cleared gate + parse + validation.
    expect(text).toContain("item not found or not owned by this seller");
  });

  it("an over-gate body is rejected 413 by the gate with its limit", async () => {
    const big = Buffer.alloc(Math.ceil(8.5 * 1024 * 1024), 7);
    const res = await post(call(big.toString("base64")));
    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).toContain("payload too large");
    expect(text).toContain(String(MCP_MAX_BODY_BYTES));
  });
});
