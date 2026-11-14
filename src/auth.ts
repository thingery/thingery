import type { Request } from "express";
import crypto from "node:crypto";
import { pool, type SellerRow } from "./db.js";

export function newApiKey(): string {
  return `thg_${crypto.randomBytes(24).toString("base64url")}`;
}

/** sha256 hex of a `thg_` key — the at-rest form in sellers.api_key_hash
 * (THI-114, security doc §6 H2.1). A fast unsalted hash is appropriate for
 * 192-bit random tokens; lookup stays a single indexed equality. */
export function apiKeyHash(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

/** Characters of a key kept for display: "thg_" plus 4 base64url characters.
 * Those 4 reveal 24 of the key's 192 random bits — enough to tell keys apart
 * at a glance, while the 168 hidden bits keep guessing the rest infeasible. */
export const API_KEY_PREFIX_LENGTH = 8;

/** The non-secret display form of a key, stored in sellers.api_key_prefix. */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_PREFIX_LENGTH);
}

export async function createSeller(displayName: string, apiKey: string): Promise<SellerRow> {
  // THI-158 contract: hash-only insert — the plaintext column is gone.
  const { rows } = await pool.query<SellerRow>(
    `INSERT INTO sellers (api_key_hash, api_key_prefix, api_key_created_at, display_name)
     VALUES ($1, $2, now(), $3) RETURNING id, display_name`,
    [apiKeyHash(apiKey), apiKeyPrefix(apiKey), displayName],
  );
  return rows[0];
}

/** Resolves a seller by API key — hash-only lookup (THI-114 expand, THI-158
 * contract). The expand-phase plaintext fallback was removed together with
 * the column: a key that has no hash match never authenticates.
 *
 * On success, fires a throttled `api_key_last_used_at` stamp for the web
 * Settings page: only when the stamp is older than an hour (NULL counts as
 * stale), so the hot path pays at most one tiny UPDATE per key per hour.
 * The UPDATE re-checks the hash so a use racing a rotation never stamps the
 * new key. Fire-and-forget, like the OAuth token touch: it never blocks or
 * fails the request. */
export async function sellerFromApiKey(key: string): Promise<SellerRow | null> {
  if (!key.startsWith("thg_")) return null;
  const hash = apiKeyHash(key);
  const { rows } = await pool.query<SellerRow>(
    `SELECT id, display_name FROM sellers WHERE api_key_hash = $1`,
    [hash],
  );
  const seller = rows[0];
  if (!seller) return null;
  void Promise.resolve()
    .then(() =>
      pool.query(
        `UPDATE sellers SET api_key_last_used_at = now()
          WHERE id = $1
            AND api_key_hash = $2
            AND (api_key_last_used_at IS NULL OR api_key_last_used_at < now() - interval '1 hour')`,
        [seller.id, hash],
      ),
    )
    .catch((err: unknown) => {
      console.error("auth: api_key_last_used_at touch failed (ignored):", err);
    });
  return seller;
}

/** What the web Settings page shows about the seller's active key — never
 * the secret or its hash. Keys issued before the display columns existed
 * have NULL prefix and created_at; `has_key` still reports them. */
export interface ApiKeyInfo {
  has_key: boolean;
  prefix: string | null;
  created_at: Date | null;
  last_used_at: Date | null;
}

export async function apiKeyInfo(sellerId: string): Promise<ApiKeyInfo | null> {
  const { rows } = await pool.query<ApiKeyInfo>(
    `SELECT api_key_hash IS NOT NULL AS has_key,
            api_key_prefix AS prefix,
            api_key_created_at AS created_at,
            api_key_last_used_at AS last_used_at
       FROM sellers WHERE id = $1`,
    [sellerId],
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
    `SELECT s.id, s.display_name, t.id AS token_id
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
  // THI-114: the resolved seller carries no plaintext key — auth paths never
  // need it and it must not ride along in response objects.
  return { id: row.id, display_name: row.display_name };
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

/** Bearer prefix for a login session presented by a first-party web client:
 * `thgs_` + the exact `thingery_session` cookie value. */
const SESSION_BEARER_PREFIX = "thgs_";

/**
 * Token dispatch on the Authorization: Bearer header (spec THI-11 §2.10):
 * `thg_` → API key, `thgo_` → OAuth access token, `thgs_` → login session.
 * Anything else that arrives as a Bearer credential is present-but-invalid.
 *
 * Deliberately header-only: browsers attach cookies to cross-site requests on
 * their own but never an Authorization header, so reading the session cookie
 * here would open /mcp to CSRF. The session must be presented explicitly.
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
  if (token.startsWith(SESSION_BEARER_PREFIX)) {
    const seller = await sellerFromSessionValue(token.slice(SESSION_BEARER_PREFIX.length));
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
 * (sellers.session_epoch — bumped by the key-regeneration endpoint POST
 * /api/me/api-key, THI-114 spec item 3, the first revocation trigger) kills
 * every outstanding cookie for one seller at once. Cookie format: `${sellerId}.${iat}.${mac}`. One-time effect on
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
/** What a resolved login session carries (THI-762): the account row plus the
 * email verification state /api/me reports — never credentials of any kind. */
export interface SessionSeller extends SellerRow {
  email: string | null;
  email_verified_at: Date | null;
}

export async function sellerFromSession(req: Request): Promise<SessionSeller | null> {
  return sellerFromSessionValue(readCookie(req, SESSION_COOKIE));
}

/** Verifies a raw session value (MAC, 30-day expiry, live `session_epoch`) —
 * the single check behind both the cookie and the `thgs_` bearer.
 * THI-114: no plaintext key selected — /api/me must not carry it. THI-762:
 * email + email_verified_at ride along (additive, same one query) so /api/me
 * can report verification state without a second roundtrip. */
async function sellerFromSessionValue(sessionValue: string | undefined): Promise<SessionSeller | null> {
  const token = splitSessionToken(sessionValue);
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
  // is returned before `verifySessionToken` passes. THI-114: no plaintext key
  // selected — /api/me must not carry it.
  const { rows } = await pool.query<SessionSeller & { session_epoch: number }>(
    `SELECT id, display_name, session_epoch, email, email_verified_at FROM sellers WHERE id = $1`, [
    token.sellerId,
  ]);
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
  password_hash: string | null;
  /** Sign-in must mint cookies at the seller's live epoch (spec THI-115 §3). */
  session_epoch: number;
}

/** Signup result: the account row plus the freshly generated key — the one
 * show-once moment where the plaintext exists (in memory, never in the DB;
 * THI-114 + THI-158 contract). `email_verification_token` follows the same
 * show-once rule (THI-762 / THI-760 Phase 0): only its sha256 hash is stored. */
export type SignupRow = AccountRow & { api_key: string; email_verification_token: string };

// ---------------------------------------------------------------------------
// Email verification (THI-760 plan Phase 0 / THI-762): signup mints a
// single-use, expiring, 256-bit token; the database stores only its sha256
// hash (same at-rest reasoning as apiKeyHash — an unsalted hash is fine for a
// high-entropy random token, and lookup stays one indexed equality). No email
// is sent in Phase 0: the plaintext surfaces only in non-production responses
// (dev/testing) until the mailer arrives in PR 2. Legacy and NULL-email
// accounts are simply "not verified" — email_verified_at stays NULL until a
// token is consumed; nothing else about the account changes.

/** Bearer-style prefix for email verification tokens (dispatch convention:
 * thg_ key / thgo_ oauth / thgs_ session — this one never rides the
 * Authorization header; the prefix exists for boundary format-gating). */
export const EMAIL_VERIFICATION_TOKEN_PREFIX = "thge_";

/** Token lifetime: 48h (THI-760 Phase 0; long enough for a weekly check-in,
 * short enough that an abandoned link dies quickly). Resend replaces the
 * outstanding token wholesale (PR 2). */
export const EMAIL_VERIFICATION_TTL_S = 48 * 3600;

/** At-rest form of a `thge_` token (sellers.email_verification_token_hash). */
export function emailVerificationTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export interface EmailVerificationToken {
  /** Plaintext `thge_...` — show-once, same rule as the signup API key. */
  token: string;
  /** sha256 hex — what sellers.email_verification_token_hash stores. */
  tokenHash: string;
  /** now + EMAIL_VERIFICATION_TTL_S — email_verification_expires_at. */
  expiresAt: Date;
}

export function newEmailVerificationToken(nowMs = Date.now()): EmailVerificationToken {
  const token = `${EMAIL_VERIFICATION_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
  return {
    token,
    tokenHash: emailVerificationTokenHash(token),
    expiresAt: new Date(nowMs + EMAIL_VERIFICATION_TTL_S * 1000),
  };
}

export async function createAccount(
  email: string,
  password: string,
  displayName: string,
): Promise<SignupRow> {
  // THI-114/THI-158: the key is generated here and handed back exactly once
  // from this variable — the database stores only its hash.
  const apiKey = newApiKey();
  // THI-762: same show-once contract for the verification token. Emitted at
  // signup for every new account (legacy accounts verify via resend, PR 2).
  const verification = newEmailVerificationToken();
  const { rows } = await pool.query<SellerRow & { email: string; session_epoch: number }>(
    `INSERT INTO sellers (api_key_hash, api_key_prefix, api_key_created_at, display_name, email, password_hash,
                          email_verification_token_hash, email_verification_expires_at)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7)
     RETURNING id, display_name, email, session_epoch`,
    [
      apiKeyHash(apiKey),
      apiKeyPrefix(apiKey),
      displayName,
      email,
      hashPassword(password),
      verification.tokenHash,
      verification.expiresAt,
    ],
  );
  return { ...rows[0], api_key: apiKey, password_hash: null, email_verification_token: verification.token };
}

/** Login path. THI-158 contract: hash-only schema — login no longer returns
 * the key (THI-125 verdict; show-once is signup + regenerate only), so this
 * row never carries or needs the credential. */
export async function accountByEmail(email: string): Promise<AccountRow | null> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT id, display_name, email, password_hash, session_epoch FROM sellers WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

/** Structural gate for a presented verification token: `thge_` + exactly 43
 * base64url chars (sha256-strength randomness). Anything else never reaches
 * the database (boundary format-gating, same posture as the thg_/thgo_/thgs_
 * dispatch). Exported for route-level pre-validation and tests. */
export const EMAIL_VERIFICATION_TOKEN_RE = /^thge_[A-Za-z0-9_-]{43}$/;

/** Consumes a verification token (THI-762 / THI-760 Phase 0): one atomic
 * conditional UPDATE — success stamps `email_verified_at` and CLEARS the
 * token columns in the same statement, which is what makes the token
 * single-use (a replay finds no hash: same null as any unknown token —
 * uniform, no oracle) and the account state-machine transition explicit:
 * unverified → verified, once, ever. Expiry is checked in the WHERE clause,
 * so an expired token fails identically. Returns the verified seller id, or
 * null for unknown/expired/reused/malformed tokens. */
export async function verifyEmailToken(token: string): Promise<string | null> {
  if (!EMAIL_VERIFICATION_TOKEN_RE.test(token)) return null;
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE sellers
        SET email_verified_at = now(),
            email_verification_token_hash = NULL,
            email_verification_expires_at = NULL
      WHERE email_verification_token_hash = $1
        AND email_verification_expires_at > now()
        AND email_verified_at IS NULL
      RETURNING id`,
    [emailVerificationTokenHash(token)],
  );
  return rows[0]?.id ?? null;
}

/** Resend/late-verification issuance (THI-762): mints a fresh token for an
 * EXISTING account and atomically replaces any outstanding one (one live
 * token per account, enforced by the single column — the previous link dies
 * the moment this commits). Issuing is allowed only while unverified, with
 * an email on file, and not bounce-suppressed (email_bounced_at, Phase 1
 * groundwork — already honored here so a suppressed address can never be
 * re-armed by resend). The 0-row diagnostic read is display-only; the UPDATE
 * above remains the authority under concurrency. */
export type EmailVerificationIssue =
  | { status: "issued"; token: string; email: string }
  | { status: "already_verified" }
  | { status: "no_email" }
  | { status: "suppressed" };

export async function issueEmailVerification(
  sellerId: string,
): Promise<EmailVerificationIssue | null> {
  const verification = newEmailVerificationToken();
  const { rows } = await pool.query<{ email: string }>(
    `UPDATE sellers
        SET email_verification_token_hash = $2,
            email_verification_expires_at = $3
      WHERE id = $1
        AND email IS NOT NULL
        AND email_verified_at IS NULL
        AND email_bounced_at IS NULL
      RETURNING email`,
    [sellerId, verification.tokenHash, verification.expiresAt],
  );
  if (rows.length === 1) {
    return { status: "issued", token: verification.token, email: rows[0].email };
  }
  const state = await pool.query<{
    email: string | null;
    email_verified_at: Date | null;
    email_bounced_at: Date | null;
  }>(`SELECT email, email_verified_at, email_bounced_at FROM sellers WHERE id = $1`, [sellerId]);
  if (state.rows.length === 0) return null; // unknown seller
  const row = state.rows[0];
  if (row.email_verified_at) return { status: "already_verified" };
  if (!row.email) return { status: "no_email" };
  return { status: "suppressed" };
}

/** Rotates a seller's API key (THI-114) and revokes every outstanding
 * session cookie (THI-115 §3): one atomic UPDATE replaces the hash and bumps
 * `session_epoch`, which invalidates all cookies signed at earlier epochs —
 * the old key stops authenticating the instant the row commits. The
 * regenerate endpoint immediately re-signs the acting session at the
 * returned epoch, so the seller rotating their own key stays logged in while
 * every other session is revoked. Returns the new key (show-once) plus the
 * epoch it was signed at. THI-158: hash-only — there is no plaintext column
 * to rotate anymore. The display prefix and created_at move with the hash,
 * and last_used_at resets: the new key has not been used yet. */
export async function regenerateApiKey(
  sellerId: string,
): Promise<{ apiKey: string; sessionEpoch: number } | null> {
  const apiKey = newApiKey();
  const { rows } = await pool.query<{ session_epoch: number }>(
    `UPDATE sellers
       SET api_key_hash = $2,
           api_key_prefix = $3,
           api_key_created_at = now(),
           api_key_last_used_at = NULL,
           session_epoch = session_epoch + 1
     WHERE id = $1
     RETURNING session_epoch`,
    [sellerId, apiKeyHash(apiKey), apiKeyPrefix(apiKey)],
  );
  return rows[0] ? { apiKey, sessionEpoch: rows[0].session_epoch } : null;
}
