import type { Request } from "express";
import crypto from "node:crypto";
import { pool, type SellerRow } from "./db.js";

export function newApiKey(): string {
  return `thg_${crypto.randomBytes(24).toString("base64url")}`;
}

export async function createSeller(displayName: string, apiKey: string): Promise<SellerRow> {
  const { rows } = await pool.query<SellerRow>(
    `INSERT INTO sellers (api_key, display_name) VALUES ($1, $2) RETURNING id, api_key, display_name`,
    [apiKey, displayName],
  );
  return rows[0];
}

/** Resolves a seller by API key. */
export async function sellerFromApiKey(key: string): Promise<SellerRow | null> {
  if (!key.startsWith("thg_")) return null;
  const { rows } = await pool.query<SellerRow>(
    `SELECT id, api_key, display_name FROM sellers WHERE api_key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

/**
 * Resolves a seller from an OAuth access token (spec THI-11 §2.10a).
 * Opaque DB-backed token: one indexed lookup on token_hash joining the grant
 * (revoked grants kill their tokens) — no fallback chain, no second query.
 *
 * On success, fires the spec THI-11 rev 2 throttled `last_used_at` update
 * (the /apps "last used" trust signal): only when the row is older than
 * 10 minutes (`NULL` counts as stale — first use stamps the row), so the
 * hottest path pays at most one tiny UPDATE per token per 10 min instead of
 * a write per request. Fire-and-forget: the UPDATE never blocks or fails
 * the request (errors are logged and swallowed).
 */
export async function sellerFromAccessToken(token: string): Promise<SellerRow | null> {
  if (!token.startsWith("thgo_")) return null;
  const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const { rows } = await pool.query<SellerRow & { token_id: string }>(
    `SELECT s.id, s.api_key, s.display_name, t.id AS token_id
       FROM oauth_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id
       JOIN sellers s ON s.id = g.seller_id
      WHERE t.token_hash = $1
        AND t.kind = 'access'
        AND t.expires_at > now()
        AND t.revoked_at IS NULL
        AND g.revoked_at IS NULL`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  void pool
    .query(
      `UPDATE oauth_tokens SET last_used_at = now()
        WHERE id = $1
          AND (last_used_at IS NULL OR last_used_at < now() - interval '10 minutes')`,
      [row.token_id],
    )
    .catch((err: unknown) => {
      console.error("oauth: last_used_at touch failed (ignored):", err);
    });
  return { id: row.id, api_key: row.api_key, display_name: row.display_name };
}

/** /mcp auth outcome (spec THI-11 §2.10a–b). */
export type AuthResult = {
  seller: SellerRow | null;
  /** "none": no credential presented (anonymous). "invalid_token": a
   * credential WAS presented (unknown key, expired/revoked token, or an
   * unrecognized format) — the server must 401, never silently downgrade. */
  failure: "none" | "invalid_token";
};

/** OAUTH_DISABLED kill switch (spec THI-11 §4.4): read per call so it can be
 * toggled without restart tooling in tests; production toggles restart via
 * deploy. When set, OAuth routes 404 and `thgo_` becomes an unrecognized
 * credential format → 401 → hosts fall back to API keys. */
export function oauthDisabled(): boolean {
  const flag = process.env.OAUTH_DISABLED;
  return flag === "1" || flag === "true";
}

/**
 * Dual-token dispatch on the Authorization: Bearer header (spec THI-11
 * §2.10): `thg_` → API key, `thgo_` → OAuth access token. Anything else that
 * arrives as a Bearer credential is present-but-invalid.
 */
export async function authenticateRequest(req: Request): Promise<AuthResult> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return { seller: null, failure: "none" };
  const token = header.slice("Bearer ".length).trim();
  if (token.startsWith("thg_")) {
    const seller = await sellerFromApiKey(token);
    return { seller, failure: seller ? "none" : "invalid_token" };
  }
  if (token.startsWith("thgo_")) {
    if (oauthDisabled()) return { seller: null, failure: "invalid_token" }; // kill switch (§4.4)
    const seller = await sellerFromAccessToken(token);
    return { seller, failure: seller ? "none" : "invalid_token" };
  }
  return { seller: null, failure: "invalid_token" };
}

// ---------------------------------------------------------------------------
// Accounts (v0.2): email + password signup, HMAC-signed session cookies.
// Passwords use scrypt from node:crypto — no extra dependency.

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(candidate, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Ephemeral fallback: sessions reset on restart when SESSION_SECRET is unset
 * in development. In production the missing secret is fatal instead of silent
 * — see `assertSecretConfigured` (docs/security.md §6 H2, fix 3).
 */
export const SESSION_SECRET =
  process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString("hex");

/**
 * Boot guard (spec THI-115 §2, docs/security.md §6 H2 fix 3): without
 * SESSION_SECRET the fallback secret is regenerated on every restart, so all
 * sessions silently reset — and an unset secret in prod means the operator
 * never made a deployment decision about it. When NODE_ENV=production (baked
 * into the Dockerfile — a more reliable prod signal than an https
 * PUBLIC_BASE_URL, which dev setups can also set) refuse to start with
 * exit(1) and a clear message; otherwise keep the soft dev warning.
 * Extracted as a function so tests can drive both branches without forking
 * a real process.
 */
export function assertSecretConfigured(env: NodeJS.ProcessEnv = process.env): void {
  // Empty string counts as unset: docker-compose passes `${SESSION_SECRET:-}`.
  if ((env.SESSION_SECRET ?? "").length > 0) return;
  if (env.NODE_ENV === "production") {
    console.error(
      "FATAL: SESSION_SECRET is not set but NODE_ENV=production — refusing to start. " +
        "Generate one with `openssl rand -hex 32`, set SESSION_SECRET in the environment " +
        "(see docker-compose.prod.yml), and restart. Without it every restart silently " +
        "invalidates all sessions.",
    );
    process.exit(1);
  }
  console.error("Warning: SESSION_SECRET not set — sessions will not survive restarts.");
}

assertSecretConfigured();

export const SESSION_COOKIE = "thingery_session";
/** Canonical sellers.id shape (used to gate untrusted cookie segments before
 *  they reach the UUID-typed SELECT — see sellerFromSession). */
const UUID_RE = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
/** Server-side session lifetime (spec THI-115 §1): tokens older than this are
 * rejected even when the browser still holds the cookie — the cookie maxAge
 * alone never expires the HMAC (docs/security.md §6 H2, fix 4). */
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;

/**
 * Session MAC input (spec THI-115 §1+§3). "session:" = HMAC domain separation
 * (spec THI-11 §2.5(5), F8): the shared SESSION_SECRET also signs OAuth
 * consent CSRF tokens ("csrf:" prefix in oauth.ts); the prefixes keep purposes
 * distinct. The issue timestamp (`iat`, unix seconds) makes the token expire
 * server-side after SESSION_MAX_AGE_S; the seller's `session_epoch`
 * (sellers.session_epoch — bumped by the future key-regeneration endpoint,
 * the first revocation trigger) kills every outstanding cookie for one seller
 * at once. Cookie format: `${sellerId}.${iat}.${mac}`. One-time effect on
 * deploy: cookies in the old `sellerId.mac` format stop validating — every
 * existing session logs in again once (same accepted trade-off as the THI-11
 * `session:` prefix rollout).
 */
function sessionMac(sellerId: string, iat: number, epoch: number): string {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(`session:${sellerId}:${iat}:${epoch}`)
    .digest("base64url");
}

/** Structurally parsed session cookie — authenticated by `verifySessionToken`. */
export interface SessionToken {
  sellerId: string;
  /** Issue time, unix seconds. */
  iat: number;
  mac: string;
}

/** Splits `${sellerId}.${iat}.${mac}` into parts without verifying anything. */
export function splitSessionToken(cookieValue: string | undefined): SessionToken | null {
  if (!cookieValue) return null;
  // Split from the right: the mac (base64url) and iat (digits) never contain
  // dots, so a hostile dot-riddled sellerId still parses deterministically.
  const macDot = cookieValue.lastIndexOf(".");
  if (macDot <= 0) return null;
  const head = cookieValue.slice(0, macDot);
  const iatDot = head.lastIndexOf(".");
  if (iatDot <= 0) return null;
  const iat = Number(head.slice(iatDot + 1));
  if (!Number.isInteger(iat) || iat < 0) return null;
  return { sellerId: head.slice(0, iatDot), iat, mac: cookieValue.slice(macDot + 1) };
}

/** Freshness + constant-time MAC check against the seller's *current* epoch. */
function verifySessionToken(token: SessionToken, epoch: number, nowMs: number = Date.now()): boolean {
  if (nowMs / 1000 - token.iat > SESSION_MAX_AGE_S) return false;
  const expected = sessionMac(token.sellerId, token.iat, epoch);
  const a = Buffer.from(token.mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Signs a session cookie for `sellerId`. `epoch` must be the seller's current
 * `sellers.session_epoch` (0 until the regeneration endpoint exists) — a
 * cookie signed at a stale epoch fails verification immediately. `nowMs` is
 * injectable for tests.
 */
export function signSession(sellerId: string, epoch = 0, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  return `${sellerId}.${iat}.${sessionMac(sellerId, iat, epoch)}`;
}

/** Verifies structure, 30-day freshness, and the MAC for the given epoch. */
export function parseSession(
  cookieValue: string | undefined,
  epoch = 0,
  nowMs = Date.now(),
): string | null {
  const token = splitSessionToken(cookieValue);
  if (!token) return null;
  return verifySessionToken(token, epoch, nowMs) ? token.sellerId : null;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

/** Resolves the logged-in seller from the session cookie (browser clients). */
export async function sellerFromSession(req: Request): Promise<SellerRow | null> {
  const token = splitSessionToken(readCookie(req, SESSION_COOKIE));
  if (!token) return null;
  // Trust-boundary format gate (THI-122 review, finding 1): sellers.id is a
  // UUID, and this SELECT runs before the MAC verifies — a non-UUID segment
  // would make Postgres throw 22P02 ("invalid input syntax for type uuid"),
  // turning a free HMAC rejection into a 500 + security_event on the OAuth
  // surface. Reject at the boundary instead; splitSessionToken/parseSession
  // stay format-agnostic (they are MAC-gated).
  if (!UUID_RE.test(token.sellerId)) return null;
  // One indexed SELECT as before — `session_epoch` rides along so a bumped
  // epoch (revocation) kills outstanding cookies with no extra query (spec
  // THI-115 §3). The cookie's sellerId is untrusted until the MAC verifies,
  // but it is only used as a parameterized lookup key; nothing from this row
  // is returned before `verifySessionToken` passes.
  const { rows } = await pool.query<SellerRow & { session_epoch: number }>(
    `SELECT id, api_key, display_name, session_epoch FROM sellers WHERE id = $1`,
    [token.sellerId],
  );
  const seller = rows[0];
  if (!seller) return null;
  return verifySessionToken(token, seller.session_epoch) ? seller : null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: (process.env.PUBLIC_BASE_URL ?? "").startsWith("https://"),
    maxAge: SESSION_MAX_AGE_S * 1000,
    path: "/",
  };
}

export interface AccountRow extends SellerRow {
  email: string;
  /** Sign-in must mint cookies at the seller's live epoch (spec THI-115 §3). */
  session_epoch: number;
}

export async function createAccount(
  email: string,
  password: string,
  displayName: string,
): Promise<AccountRow> {
  const { rows } = await pool.query<AccountRow>(
    `INSERT INTO sellers (api_key, display_name, email, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, api_key, display_name, email, session_epoch`,
    [newApiKey(), displayName, email, hashPassword(password)],
  );
  return rows[0];
}

export async function accountByEmail(email: string): Promise<AccountRow | null> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT id, api_key, display_name, email, password_hash, session_epoch FROM sellers WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}
