// GET /api/me `payouts`: read-only payout state for the session owner, so a
// client can render payout setup without calling get_payout_setup (which
// creates the Stripe account). Session-auth via the signSession cookie pattern
// of tests/notify-routes.test.ts; DB-backed (skips without Postgres).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

type MeBody = { seller: null | { payouts?: { configured: boolean; onboarded: boolean } } & Record<string, unknown> };

describe.skipIf(!available)("/api/me payouts state", () => {
  let db: pg.Client;
  let server: Server;
  let base = "";
  let onboardedCookie = "";
  let newCookie = "";
  const savedKey = process.env.STRIPE_SECRET_KEY;

  async function me(cookie?: string): Promise<MeBody> {
    const res = await fetch(`${base}/api/me`, cookie ? { headers: { cookie } } : {});
    expect(res.status).toBe(200);
    return (await res.json()) as MeBody;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));

    const tag = crypto.randomBytes(4).toString("hex");
    const mk = async (name: string, onboarded: boolean): Promise<string> => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO sellers (email, password_hash, display_name, stripe_account_id, stripe_onboarded_at)
         VALUES ($1, 'x', $2, $3, $4) RETURNING id`,
        [
          `mepayouts-${tag}-${crypto.randomUUID().slice(0, 8)}@example.test`,
          name,
          onboarded ? `acct_test_${tag}` : null,
          onboarded ? new Date() : null,
        ],
      );
      return r.rows[0].id;
    };
    onboardedCookie = `${SESSION_COOKIE}=${signSession(await mk("Onboarded", true))}`;
    newCookie = `${SESSION_COOKIE}=${signSession(await mk("New", false))}`;

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

  afterEach(() => {
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
  });

  afterAll(async () => {
    server.close();
    await db.end().catch(() => {});
  });

  it("anonymous shape is unchanged", async () => {
    expect(await me()).toEqual({ seller: null });
  });

  it.each([
    { stripe: false, who: "new", expected: { configured: false, onboarded: false } },
    { stripe: false, who: "onboarded", expected: { configured: false, onboarded: true } },
    { stripe: true, who: "new", expected: { configured: true, onboarded: false } },
    { stripe: true, who: "onboarded", expected: { configured: true, onboarded: true } },
  ])("payments configured=$stripe, $who seller → $expected", async ({ stripe, who, expected }) => {
    if (stripe) process.env.STRIPE_SECRET_KEY = "sk_test_me_payouts";
    else delete process.env.STRIPE_SECRET_KEY;
    const body = await me(who === "onboarded" ? onboardedCookie : newCookie);
    expect(body.seller?.payouts).toEqual(expected);
  });

  it("never exposes Stripe identifiers", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_me_payouts";
    const raw = JSON.stringify(await me(onboardedCookie));
    expect(raw).not.toMatch(/acct_/);
    expect(raw).not.toMatch(/stripe/i);
  });
});
