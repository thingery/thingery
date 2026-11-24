// THI-1197 (THI-1196 Security finding F1): the /api/draft-listing body-cap
// envelope. Photo drafts travel as base64+JSON — a 5 MB photo ≈ 6.7 MB — so
// the route gets a scoped 8 MiB parser mounted BEFORE the global 256kb one
// (src/body-parsers.ts, called verbatim by src/index.ts). This suite mounts
// the exact production stack; the bug shipped because the route tests built
// their own app with a smaller parser, so production mount drift was
// invisible to CI.
//
// Regression contract (Security THI-1196):
//   - unauthenticated >256kb draft POST → 401, never 413 (auth precedes any
//     parser rejection the envelope admits)
//   - session-authenticated full-size photo draft reaches the handler — a
//     draft or a typed error (here the typed 503 not-configured), never 413
//   - the 8 MiB cap still 413s (DoS bound unchanged)
//   - every other /api route keeps the global 256kb cap
//
// THI-1360 adds the pre-auth cost bound on top: the anon gate
// (draftListingAnonBodyGate, mounted first in body-parsers.ts) answers the
// unauthenticated in-envelope case 401 BEFORE the body is read or parsed —
// so the >256kb anonymous tests below also pin "parse cost never paid"
// (their bodies are deliberately invalid JSON: a parse would 400).
//
// No database required except the authenticated full-size case (a real
// seller row + signed session cookie), which skips cleanly without one.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Server } from "node:http";
import express from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { mountApiRoutes } from "../src/routes.js";
import {
  DRAFT_LISTING_BODY_LIMIT,
  GLOBAL_JSON_BODY_LIMIT,
  mountBodyParsers,
} from "../src/body-parsers.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";
import { extractionBudget, extractionSellerLimiter } from "../src/extraction.js";

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
const dbUp = await dbAvailable();

/** Production mount order, verbatim — this is the point of the suite. */
function buildApp(): Server {
  const app = express();
  app.set("trust proxy", 1);
  mountBodyParsers(app);
  mountApiRoutes(app);
  return app.listen(0);
}

// The client-side fetch must bypass any global stub elsewhere: keep the real
// one captured. draftPort is (re)bound by each server this suite starts.
const realFetch = globalThis.fetch;
let draftPort = 0;

function postDraft(body: string, cookie: string | null): Promise<Response> {
  return realFetch(`http://127.0.0.1:${draftPort}/api/draft-listing`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body,
  });
}

function postLogin(body: string): Promise<Response> {
  return realFetch(`http://127.0.0.1:${draftPort}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("POST /api/draft-listing body-cap envelope (THI-1197)", () => {
  beforeEach(() => {
    extractionBudget.reset();
    extractionSellerLimiter.reset();
  });

  it("unauthenticated >256kb JSON → 401, never 413 (auth precedes the parser's rejection)", async () => {
    const server = buildApp();
    try {
      draftPort = (server.address() as { port: number }).port;
      const big = JSON.stringify({ text: "a".repeat(GLOBAL_JSON_BODY_LIMIT + 64 * 1024) });
      const res = await postDraft(big, null);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "Sign in to draft a listing." });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // THI-1360: the gate must answer 401 BEFORE any parse. Differential: the
  // body is deliberately NOT JSON — if the scoped parser ran first it would
  // 400 (entity.parse.failed); the gate answering 401 proves the 8 MiB
  // buffer + JSON.parse cost was never paid for an anonymous caller. Fails
  // against the pre-gate code (400).
  it("anonymous in-envelope non-JSON body → 401 before parse (THI-1360: no anonymous parse cost)", async () => {
    const server = buildApp();
    try {
      draftPort = (server.address() as { port: number }).port;
      const big = "x".repeat(GLOBAL_JSON_BODY_LIMIT + 64 * 1024);
      const res = await postDraft(big, null);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "Sign in to draft a listing." });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // THI-1360: cookie presence must not buy the parse — a structurally
  // invalid session value resolves anonymous with zero DB work, so the gate
  // must still 401 pre-parse. (No database needed: splitSessionToken rejects
  // before any SELECT.) Fails against the pre-gate code (400).
  it("garbage session cookie + in-envelope non-JSON body → 401 before parse (gate trusts no cookie shape)", async () => {
    const server = buildApp();
    try {
      draftPort = (server.address() as { port: number }).port;
      const big = "x".repeat(GLOBAL_JSON_BODY_LIMIT + 64 * 1024);
      const res = await postDraft(big, `${SESSION_COOKIE}=not-a-session`);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "Sign in to draft a listing." });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the global 256kb cap on every other /api route (login still 413s)", async () => {
    const server = buildApp();
    try {
      draftPort = (server.address() as { port: number }).port;
      const big = JSON.stringify({ email: "a".repeat(GLOBAL_JSON_BODY_LIMIT) });
      const res = await postLogin(big);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: "Request body too large." });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("still 413s above the scoped cap (8 MiB DoS bound unchanged)", async () => {
    const server = buildApp();
    try {
      draftPort = (server.address() as { port: number }).port;
      const huge = JSON.stringify({ text: "a".repeat(DRAFT_LISTING_BODY_LIMIT + 512 * 1024) });
      const res = await postDraft(huge, null);
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ error: "Request body too large." });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.skipIf(!dbUp)(
    "authenticated full-size photo draft (≈6.7 MB envelope) reaches the handler — typed 503, never 413",
    async () => {
      const db = new pg.Client({ connectionString });
      await db.connect();
      let server: Server | undefined;
      try {
        await db.query(readFileSync(schemaPath, "utf8"));
        // Deterministic typed error: no LLM key → the route answers its
        // 503 extraction_not_configured contract AFTER accepting the body.
        delete process.env.LLM_API_KEY;
        const tag = `draft-cap-${Date.now()}`;
        const seller = await db.query<{ id: string }>(
          "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, 'draft-cap', $2) RETURNING id",
          [`thg_${tag}`, tag],
        );
        const sellerCookie = `${SESSION_COOKIE}=${signSession(seller.rows[0].id as string)}`;
        server = buildApp();
        draftPort = (server.address() as { port: number }).port;
        // 5 MB of bytes ≈ 6.7 MB base64 — the exact envelope the zod schema
        // documents, far above the global 256kb parser.
        const photo = { image_base64: "A".repeat(5 * 1024 * 1024), media_type: "image/jpeg" };
        const res = await postDraft(JSON.stringify({ photos: [photo] }), sellerCookie);
        expect(res.status).not.toBe(413);
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ code: "extraction_not_configured" });
      } finally {
        await db.query(`DELETE FROM sellers WHERE email LIKE 'draft-cap-%'`).catch(() => {});
        await db.end();
        server?.close();
      }
    },
  );
});

// Mount-wiring drift pin (the discoverability-drift.test.ts pattern): the
// suite above proves the shared mount behaves, and this pin keeps the
// production entrypoint actually wired to it — index.ts reverting to an
// inline parser (the exact THI-1196 F1 drift) fails CI, as does any future
// inline express.json that bypasses the shared mount list.
const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("production wiring pin (THI-1197)", () => {
  it("src/index.ts mounts the shared parsers and keeps no inline JSON parser", () => {
    expect(indexSrc).toContain("mountBodyParsers(app);");
    expect(indexSrc).not.toMatch(/app\.use\(express\.json/);
  });
});
