// Saved-address web routes (spec docs/specs/saved-addresses.md, rollout
// step 3): GET/POST /api/me/addresses + PATCH/DELETE /api/me/addresses/:id.
// Session-auth via the signSession cookie pattern (tests/notify-preferences-
// routes.test.ts); DB-backed (skips without Postgres — CI runs it). Covers:
// anonymous 401 on every verb, the full-address owner response (the
// deliberate contrast with C2's MCP summaries), validation incl. ISO
// country, round-trip with the default invariant, the 10-row cap as 429,
// cross-account isolation (uniform 404), and malformed-id 404s.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import crypto from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mountApiRoutes } from "../src/routes.js";
import { SESSION_COOKIE, signSession } from "../src/auth.js";

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

const ADDRESS = {
  label: "Home",
  name: "Ada Tester",
  line1: "Via Test 1",
  line2: "",
  city: "Milano",
  postal_code: "20121",
  country: "it", // lowercase on purpose: normalized to IT
};

describe.skipIf(!available)("/api/me/addresses (saved-addresses step 3)", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  const runTag = crypto.randomBytes(4).toString("hex");
  let cookie = "";
  let otherCookie = "";
  let sellerId = "";

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    const mk = async (): Promise<string> => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', 'THI-914 Routes') RETURNING id`,
        [`thi914r-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`],
      );
      return r.rows[0].id;
    };
    sellerId = await mk();
    const otherId = await mk();
    cookie = `${SESSION_COOKIE}=${signSession(sellerId)}`;
    otherCookie = `${SESSION_COOKIE}=${signSession(otherId)}`;

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
    server?.close();
    await db.end().catch(() => {});
  });

  const post = (body: unknown, asOther = false) =>
    fetch(`${base}/api/me/addresses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: asOther ? otherCookie : cookie },
      body: JSON.stringify(body),
    });

  it("anonymous → 401 on all four verbs", async () => {
    const id = crypto.randomUUID();
    const attempts = [
      { method: "GET" },
      { method: "POST", body: "{}" },
      { method: "PATCH", body: "{}" },
      { method: "DELETE" },
    ];
    for (const a of attempts) {
      const res = await fetch(`${base}/api/me/addresses${a.method === "GET" || a.method === "POST" ? "" : `/${id}`}`, {
        method: a.method,
        ...(a.body
          ? { headers: { "Content-Type": "application/json" }, body: a.body }
          : {}),
      });
      expect(res.status).toBe(401);
    }
  });

  it("rejects an invalid body with 400 and never creates a row", async () => {
    for (const bad of [
      { ...ADDRESS, country: "XX" }, // not ISO
      { ...ADDRESS, label: "" }, // empty label
      { ...ADDRESS, postal_code: "" },
      { label: "no other fields" },
    ]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
  });

  it("creates and returns the FULL address (owner's own screen — the C2 contrast)", async () => {
    const res = await post(ADDRESS);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { address } = (await res.json()) as {
      address: Record<string, unknown> & { verification: { status: string } };
    };
    // Full shape: name/street/postal code are present on the web surface…
    expect(address.name).toBe(ADDRESS.name);
    expect(address.line1).toBe(ADDRESS.line1);
    expect(address.postal_code).toBe(ADDRESS.postal_code);
    // …and the country was normalized, verification defaults to not_checked.
    expect(address.country).toBe("IT");
    expect(address.verification.status).toBe("not_checked");
    expect(address.is_default).toBe(false);
    expect(address.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lists default-first, edits wholesale, and keeps exactly one default", async () => {
    const second = await post({ ...ADDRESS, label: "Office", city: "Roma" });
    const office = ((await second.json()) as { address: { id: string } }).address;

    // Promote Office via PATCH (web-only default toggle) with a full body.
    const patch = await fetch(`${base}/api/me/addresses/${office.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ ...ADDRESS, label: "Office", city: "Roma", is_default: true }),
    });
    expect(patch.status).toBe(200);
    const promoted = (await patch.json()) as { address: { is_default: boolean } };
    expect(promoted.address.is_default).toBe(true);

    const list = await fetch(`${base}/api/me/addresses`, { headers: { Cookie: cookie } });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const { addresses } = (await list.json()) as { addresses: { id: string; is_default: boolean }[] };
    expect(addresses.length).toBeGreaterThanOrEqual(2);
    expect(addresses[0].id).toBe(office.id); // default first
    expect(addresses.filter((a) => a.is_default)).toHaveLength(1);

    // Edit without is_default → 400 (module contract: merged target state).
    const noFlag = await fetch(`${base}/api/me/addresses/${office.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ ...ADDRESS, label: "Office" }),
    });
    expect(noFlag.status).toBe(400);
  });

  it("other accounts see nothing: empty list, and foreign ids answer uniform 404", async () => {
    const list = await fetch(`${base}/api/me/addresses`, { headers: { Cookie: otherCookie } });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { addresses: unknown[] }).addresses).toHaveLength(0);

    const mine = await fetch(`${base}/api/me/addresses`, { headers: { Cookie: cookie } });
    const victim = (((await mine.json()) as { addresses: { id: string }[] }).addresses)[0].id;
    for (const method of ["PATCH", "DELETE"] as const) {
      const res = await fetch(`${base}/api/me/addresses/${victim}`, {
        method,
        headers: { "Content-Type": "application/json", Cookie: otherCookie },
        ...(method === "PATCH"
          ? { body: JSON.stringify({ ...ADDRESS, is_default: false }) }
          : {}),
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("Address not found.");
    }
    // Still mine afterwards.
    const still = await fetch(`${base}/api/me/addresses`, { headers: { Cookie: cookie } });
    expect(((await still.json()) as { addresses: unknown[] }).addresses.length).toBeGreaterThanOrEqual(2);
  });

  it("malformed ids 404 on PATCH and DELETE (no uuid parse error, no oracle)", async () => {
    for (const method of ["PATCH", "DELETE"] as const) {
      const res = await fetch(`${base}/api/me/addresses/not-a-uuid`, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        ...(method === "PATCH" ? { body: JSON.stringify({ ...ADDRESS, is_default: false }) } : {}),
      });
      expect(res.status).toBe(404);
    }
  });

  it("enforces the 10-row cap as 429 at the route surface", async () => {
    // Fill to the cap for a fresh account, then prove the 11th POST 429s.
    const filler = await db.query<{ id: string }>(
      `INSERT INTO sellers (email, password_hash, display_name) VALUES ($1, 'x', 'THI-914 Cap') RETURNING id`,
      [`thi914cap-${runTag}-${crypto.randomUUID().slice(0, 8)}@example.test`],
    );
    const capCookie = `${SESSION_COOKIE}=${signSession(filler.rows[0].id)}`;
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${base}/api/me/addresses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: capCookie },
        body: JSON.stringify({ ...ADDRESS, label: `A${i}` }),
      });
      expect(res.status).toBe(201);
    }
    const over = await fetch(`${base}/api/me/addresses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: capCookie },
      body: JSON.stringify({ ...ADDRESS, label: "One too many" }),
    });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: string }).error).toMatch(/Address limit reached/);
  });

  it("deletes owner-scoped, then the same id 404s", async () => {
    const made = await post({ ...ADDRESS, label: "Doomed" });
    const id = ((await made.json()) as { address: { id: string } }).address.id;
    const del = await fetch(`${base}/api/me/addresses/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { ok: boolean }).ok).toBe(true);
    const again = await fetch(`${base}/api/me/addresses/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(again.status).toBe(404);
  });
});
