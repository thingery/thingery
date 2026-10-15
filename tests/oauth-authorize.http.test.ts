// HTTP integration tests for GET/POST /oauth/authorize (spec THI-11 §2.5):
// login hop with the safe `next` filter, consent page hardening, the §2.5
// validation order (400 page vs error= redirect), CSRF enforcement, and the
// F5 one-live-grant transaction. Requires Postgres; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { mountOauthRoutes } from "../src/oauth.js";
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

const CHALLENGE = crypto.createHash("sha256").update("correct-horse-battery").digest("base64url");
const REDIRECT_URI = "http://localhost:51717/callback";

function authorizeUrl(overrides: Record<string, string | undefined> = {}): string {
  const entries = Object.entries({
    client_id: "thgc_authtest",
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st-123456",
    ...overrides,
  }).filter(([, v]) => v !== undefined) as [string, string][];
  return `/oauth/authorize?${new URLSearchParams(entries).toString()}`;
}

/** Parses the hidden inputs out of the rendered consent form (HTML-unescaped). */
function parseConsentForm(html: string): Record<string, string> {
  const form: Record<string, string> = {};
  const re = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    form[m[1]] = m[2]
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'");
  }
  return form;
}

describe.skipIf(!available)("oauth authorize endpoint (HTTP)", () => {
  let server: Server;
  let baseUrl: string;
  let db: pg.Client;
  let cookie: string;
  let sellerId: string;
  const runTag = crypto.randomBytes(4).toString("hex"); // unique per run: a crashed prior run can't poison the next
  const email = `authorize-test-${runTag}@example.com`;

  beforeAll(async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json({ limit: "256kb" }));
    mountOauthRoutes(app);
    server = app.listen(0);
    const address = server.address();
    if (typeof address === "object" && address) baseUrl = `http://127.0.0.1:${address.port}`;
    db = new pg.Client({ connectionString });
    await db.connect();

    const seller = await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`thg_test_${runTag}`, "Authorize Tester", email, "x"],
    );
    sellerId = seller.rows[0].id;
    cookie = `${SESSION_COOKIE}=${encodeURIComponent(signSession(sellerId))}`;

    await db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)
       ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris`,
      ["thgc_authtest", "Test Inspector", [REDIRECT_URI]],
    );
    await db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)
       ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris`,
      ["thgc_xss", `<script>alert("x")</script>`, [REDIRECT_URI]],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM oauth_codes WHERE client_id IN ('thgc_authtest', 'thgc_xss')`);
    await db.query(`DELETE FROM oauth_grants WHERE client_id IN ('thgc_authtest', 'thgc_xss')`);
    await db.query(`DELETE FROM oauth_clients WHERE client_id IN ('thgc_authtest', 'thgc_xss')`);
    await db.query(`DELETE FROM sellers WHERE id = $1 OR email = $2`, [sellerId, email]);
    await db.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("redirects anonymous users to /login.html with the authorize URL as filtered next", async () => {
    const res = await fetch(`${baseUrl}${authorizeUrl()}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") as string, baseUrl);
    expect(location.pathname).toBe("/login.html");
    expect(location.searchParams.get("next")).toBe(authorizeUrl());
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("renders the consent page for a logged-in seller (hardened, escaped)", async () => {
    const res = await fetch(`${baseUrl}${authorizeUrl()}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    const html = await res.text();
    expect(html).toContain("Authorize Test Inspector");
    expect(html).toContain(email);
    expect(html).toContain("read and manage your listings and orders");
    expect(html).toContain('action="/oauth/authorize"');
    const form = parseConsentForm(html);
    expect(form.client_id).toBe("thgc_authtest");
    expect(form.csrf).toBeTruthy();
    expect(form.nonce).toBeTruthy();
  });

  it("HTML-escapes attacker-supplied client names (DCR text)", async () => {
    const res = await fetch(`${baseUrl}${authorizeUrl({ client_id: "thgc_xss" })}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("issues a code on Allow, rotating grants so only one stays live (F5)", async () => {
    const consent = await fetch(`${baseUrl}${authorizeUrl()}`, { headers: { cookie } });
    const form = { ...parseConsentForm(await consent.text()), action: "allow" };
    const allow = async () =>
      fetch(`${baseUrl}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: new URLSearchParams(form).toString(),
        redirect: "manual",
      });

    const first = await allow();
    expect(first.status).toBe(302);
    const firstLoc = new URL(first.headers.get("location") as string);
    expect(firstLoc.origin + firstLoc.pathname).toBe(REDIRECT_URI);
    const code1 = firstLoc.searchParams.get("code") as string;
    expect(code1).toMatch(/^thga_[A-Za-z0-9_-]{43}$/);
    expect(firstLoc.searchParams.get("state")).toBe("st-123456");
    expect(firstLoc.searchParams.get("iss")).toBe(baseUrl); // RFC 9207

    // F5: second Allow revokes the first grant; codes of BOTH grants are bound to their grants.
    const second = await allow();
    expect(second.status).toBe(302);
    const code2 = (new URL(second.headers.get("location") as string)).searchParams.get("code") as string;

    const grants = await db.query<{ id: string; revoked_at: Date | null }>(
      `SELECT id, revoked_at FROM oauth_grants WHERE seller_id = $1 AND client_id = 'thgc_authtest' ORDER BY created_at`,
      [sellerId],
    );
    expect(grants.rows.length).toBe(2);
    expect(grants.rows[0].revoked_at).not.toBeNull();
    expect(grants.rows[1].revoked_at).toBeNull();

    for (const [code, grant] of [
      [code1, grants.rows[0].id],
      [code2, grants.rows[1].id],
    ] as const) {
      const row = await db.query(
        `SELECT grant_id, redirect_uri, code_challenge, expires_at FROM oauth_codes WHERE code_hash = $1`,
        [crypto.createHash("sha256").update(code).digest("hex")],
      );
      expect(row.rows.length).toBe(1);
      expect(row.rows[0].grant_id).toBe(grant);
      expect(row.rows[0].redirect_uri).toBe(REDIRECT_URI);
      expect(row.rows[0].code_challenge).toBe(CHALLENGE);
      const ttlS = (new Date(row.rows[0].expires_at as string).getTime() - Date.now()) / 1000;
      expect(ttlS).toBeGreaterThan(30);
      expect(ttlS).toBeLessThanOrEqual(60);
    }
  });

  it("redirects error=access_denied on Deny", async () => {
    const consent = await fetch(`${baseUrl}${authorizeUrl()}`, { headers: { cookie } });
    const form = { ...parseConsentForm(await consent.text()), action: "deny" };
    const res = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams(form).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location") as string);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("st-123456");
  });

  it("rejects a consent POST with a wrong CSRF token (400, no code issued)", async () => {
    const consent = await fetch(`${baseUrl}${authorizeUrl()}`, { headers: { cookie } });
    const form = { ...parseConsentForm(await consent.text()), action: "allow", csrf: "forged" };
    const res = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams(form).toString(),
    });
    expect(res.status).toBe(400);
    await res.text();
  });

  it("returns a 400 page (never a redirect) for unknown client or unregistered redirect", async () => {
    const unknown = await fetch(`${baseUrl}${authorizeUrl({ client_id: "thgc_missing" })}`);
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();

    const wrongRedirect = await fetch(`${baseUrl}${authorizeUrl({ redirect_uri: "http://localhost:51717/evil" })}`, {
      headers: { cookie },
    });
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.headers.get("location")).toBeNull();
    await wrongRedirect.text();
  });

  it("returns 400 (not 500) for repeated query/form params (arrays, not strings)", async () => {
    // ?client_id=a&client_id=b parses to an array — must hit the 400 error
    // page, never reach the DB layer and 500. Same for a repeated redirect_uri.
    const repeatedId = `/oauth/authorize?client_id=thgc_authtest&client_id=thgc_authtest&redirect_uri=${encodeURIComponent(
      REDIRECT_URI,
    )}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=st-123456`;
    const res = await fetch(`${baseUrl}${repeatedId}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    // error page carries the hardened page CSP (default-src 'none' rider)
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    await res.text();

    const repeatedRedirect = `/oauth/authorize?client_id=thgc_authtest&redirect_uri=${encodeURIComponent(
      REDIRECT_URI,
    )}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256`;
    const res2 = await fetch(`${baseUrl}${repeatedRedirect}`);
    expect(res2.status).toBe(400);
    expect(res2.headers.get("location")).toBeNull();
    await res2.text();
  });

  const errorRedirectCases: Array<[string, Record<string, string | undefined>, string]> = [
    ["unsupported_response_type for response_type=token", { response_type: "token" }, "unsupported_response_type"],
    ["invalid_request for missing PKCE", { code_challenge: undefined, code_challenge_method: undefined }, "invalid_request"],
    ["invalid_request for plain-method PKCE", { code_challenge_method: "plain" }, "invalid_request"],
    ["invalid_request for malformed challenge", { code_challenge: "A".repeat(42) }, "invalid_request"],
    ["invalid_scope for non-mcp scope", { scope: "read write" }, "invalid_scope"],
    ["invalid_target for a foreign resource", { resource: "https://api.evil.com/mcp" }, "invalid_target"],
    ["invalid_request for oversized state", { state: "s".repeat(2049) }, "invalid_request"],
  ];

  for (const [name, overrides, expectedError] of errorRedirectCases) {
    it(`redirects error=${expectedError} — ${name}`, async () => {
      const res = await fetch(`${baseUrl}${authorizeUrl(overrides)}`, { headers: { cookie }, redirect: "manual" });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") as string);
      expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
      expect(loc.searchParams.get("error")).toBe(expectedError);
      expect(loc.searchParams.get("iss")).toContain(baseUrl);
    });
  }

  it("accepts a loopback port variation on GET when registered hostname matches (F3)", async () => {
    const res = await fetch(`${baseUrl}${authorizeUrl({ redirect_uri: "http://localhost:49152/callback" })}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302); // passed validation; anonymous → login hop
    const loc = new URL(res.headers.get("location") as string, baseUrl);
    expect(loc.pathname).toBe("/login.html");
  });

  it("returns 400 (not a hang) for a repeated state param with a logged-in session (THI-45 R1)", async () => {
    // F1 vector: state=["a","b"] passed every equality/length check and was
    // rendered into the consent form → TypeError in htmlEscape → unhandled
    // rejection → request hang / process kill. Must now hit the 400 error page.
    const url = `/oauth/authorize?client_id=thgc_authtest&redirect_uri=${encodeURIComponent(
      REDIRECT_URI,
    )}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=a&state=b`;
    const res = await fetch(`${baseUrl}${url}`, { headers: { cookie } });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Malformed request");
  });

  it("re-validates on POST: tampered redirect_uri in the form is rejected with 400", async () => {
    const consent = await fetch(`${baseUrl}${authorizeUrl()}`, { headers: { cookie } });
    const form = { ...parseConsentForm(await consent.text()), action: "allow", redirect_uri: "http://localhost:51717/evil" };
    const res = await fetch(`${baseUrl}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams(form).toString(),
    });
    expect(res.status).toBe(400);
    await res.text();
  });
});
