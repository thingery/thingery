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
 */
export async function sellerFromAccessToken(token: string): Promise<SellerRow | null> {
  if (!token.startsWith("thgo_")) return null;
  const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const { rows } = await pool.query<SellerRow>(
    `SELECT s.id, s.api_key, s.display_name
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
  return rows[0] ?? null;
}

/** /mcp auth outcome (spec THI-11 §2.10a–b). */
export type AuthResult = {
  seller: SellerRow | null;
  /** "none": no credential presented (anonymous). "invalid_token": a
   * credential WAS presented (unknown key, expired/revoked token, or an
   * unrecognized format) — the server must 401, never silently downgrade. */
  failure: "none" | "invalid_token";
};

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

/** Ephemeral fallback: sessions reset on restart when SESSION_SECRET is unset. */
export const SESSION_SECRET =
  process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.error("Warning: SESSION_SECRET not set — sessions will not survive restarts.");
}

export const SESSION_COOKIE = "thingery_session";
const SESSION_MAX_AGE_S = 30 * 24 * 3600;

export function signSession(sellerId: string): string {
  // "session:" prefix = HMAC domain separation (spec THI-11 §2.5(5), F8): the
  // shared SESSION_SECRET signs both session cookies and OAuth consent CSRF
  // tokens ("csrf:" prefix in oauth.ts); the prefixes keep purposes distinct.
  // One-time effect on deploy: cookies signed without the prefix stop validating
  // (existing users log in again once).
  const mac = crypto.createHmac("sha256", SESSION_SECRET).update(`session:${sellerId}`).digest("base64url");
  return `${sellerId}.${mac}`;
}

export function parseSession(cookieValue: string | undefined): string | null {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const sellerId = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(`session:${sellerId}`).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? sellerId : null;
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
  const sellerId = parseSession(readCookie(req, SESSION_COOKIE));
  if (!sellerId) return null;
  const { rows } = await pool.query<SellerRow>(
    `SELECT id, api_key, display_name FROM sellers WHERE id = $1`,
    [sellerId],
  );
  return rows[0] ?? null;
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
}

export async function createAccount(
  email: string,
  password: string,
  displayName: string,
): Promise<AccountRow> {
  const { rows } = await pool.query<AccountRow>(
    `INSERT INTO sellers (api_key, display_name, email, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, api_key, display_name, email`,
    [newApiKey(), displayName, email, hashPassword(password)],
  );
  return rows[0];
}

export async function accountByEmail(email: string): Promise<AccountRow | null> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT id, api_key, display_name, email, password_hash FROM sellers WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}
