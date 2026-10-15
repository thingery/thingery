// "Sign in with ChatGPT" browser-flow mechanics (spec THI-193 §2–§4, rev
// fa3288ff, PR-2): the connect redirect, the one-time transaction cookie,
// the authorization-code exchange, ID-token verification against the remote
// JWKS (jose), the default-model pick, and best-effort revocation. The route
// handlers live in src/routes.ts (protected path, THI-36) and stay thin;
// this module is the flow layer they call.
//
// Endpoints are PINNED to the provider facts verified 2026-10-15 (spec §2):
// no env var can redirect a token exchange, a JWKS fetch, a models call or a
// revocation at another host. The JWKS is fetched through global fetch
// (cached 10 min, one forced refresh on an unknown kid — provider key roll)
// and handed to jose as a local key set, so jose's own transport never
// bypasses the pinned URL.
//
// Transaction cookie (§3.2): {v,state,nonce,verifier,exp} is HMAC-signed
// with SESSION_SECRET under a "chatgpt_tx:" domain-separation prefix (spec
// THI-11 §2.5(5) — the shared secret also signs sessions "session:" and
// OAuth CSRF tokens "csrf:", the prefixes keep purposes distinct),
// HttpOnly Secure SameSite=Lax, Path=/api/me/chatgpt, Max-Age 600. Single
// use is enforced SERVER-side: every valid cookie presented to the callback
// is burned in a bounded TTL registry before any exchange — clearing the
// browser cookie alone cannot stop a client that kept a copy.

import crypto from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { envValue } from "./config.js";
import { SESSION_SECRET } from "./auth.js";
import { CHATGPT_OAUTH_TOKEN_URL } from "./chatgpt-oauth.js";

/** §2 (pinned 2026-10-15): authorize / revocation / JWKS endpoints, issuer,
 *  and the account model catalog. */
export const CHATGPT_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_OAUTH_REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
export const CHATGPT_OAUTH_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
export const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";
export const CHATGPT_OAUTH_MODELS_URL = "https://api.openai.com/v1/models";
/** §2/§3.1: identity + plan-usage scopes requested at authorize time. */
export const CHATGPT_OAUTH_SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/** RFC 8705/8707 resource parameter every grant repeats (§2). */
const CHATGPT_OAUTH_RESOURCE = "https://api.openai.com/v1";

export const CHATGPT_TX_COOKIE = "thg_chatgpt_tx";
const CHATGPT_TX_MAX_AGE_S = 600;

/** Redirect URI (§3.1): CHATGPT_OAUTH_REDIRECT_URI (must match the
 *  registered URI exactly) else the PUBLIC_BASE_URL default. Undefined =
 *  the deployment cannot run the flow. */
export function chatgptOauthRedirectUri(): string | undefined {
  const explicit = envValue("CHATGPT_OAUTH_REDIRECT_URI");
  if (explicit) return explicit;
  const base = envValue("PUBLIC_BASE_URL")?.replace(/\/+$/, "");
  return base ? `${base}/api/me/chatgpt/callback` : undefined;
}

export function chatgptTxCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: true, // §3.2 pins Secure unconditionally — the flag ships off in dev
    path: "/api/me/chatgpt",
    maxAge: CHATGPT_TX_MAX_AGE_S * 1000,
  };
}

/** Clearing needs the same name+path but NO maxAge — Express 4 would let a
 *  maxAge override the 1970 expiry and re-issue the cookie instead. */
export function chatgptTxCookieClearOptions() {
  return { ...chatgptTxCookieOptions(), maxAge: undefined };
}

// --- transaction cookie (§3.2) -----------------------------------------------

export interface ChatgptTx {
  v: 1;
  state: string;
  nonce: string;
  verifier: string;
  /** Expiry, unix ms. */
  exp: number;
}

const b64u = (buf: Buffer): string => buf.toString("base64url");

function txMac(payload: string): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(`chatgpt_tx:${payload}`).digest("base64url");
}

export function signChatgptTx(tx: ChatgptTx): string {
  const payload = b64u(Buffer.from(JSON.stringify(tx), "utf8"));
  return `${payload}.${txMac(payload)}`;
}

function parseChatgptTx(value: string): ChatgptTx | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const mac = Buffer.from(value.slice(dot + 1), "utf8");
  const expected = Buffer.from(txMac(payload), "utf8");
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  try {
    const tx = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<ChatgptTx>;
    if (tx.v !== 1 || typeof tx.exp !== "number" || !Number.isFinite(tx.exp)) return null;
    for (const field of [tx.state, tx.nonce, tx.verifier]) {
      if (typeof field !== "string" || field.length === 0 || field.length > 256) return null;
    }
    return { v: 1, state: tx.state!, nonce: tx.nonce!, verifier: tx.verifier!, exp: tx.exp };
  } catch {
    return null;
  }
}

/** Server-side single-use burn list, keyed by the cookie MAC (unique per
 *  issued tx), TTL = the cookie window, bounded at 10k entries with
 *  expired-entry pruning so a stampede of connects cannot grow it forever. */
const burnedTx = new Map<string, number>();

/** Verify + burn in one step (§3.2 "consume ONCE"): a signature-valid,
 *  unexpired, never-before-seen cookie returns its tx and is burned; every
 *  other outcome is null (expired/reused/tampered look identical). */
export function consumeChatgptTx(value: string | undefined, nowMs = Date.now()): ChatgptTx | null {
  if (!value) return null;
  const tx = parseChatgptTx(value);
  if (!tx || tx.exp <= nowMs) return null;
  const key = value.slice(value.lastIndexOf(".") + 1);
  if (burnedTx.has(key)) return null;
  if (burnedTx.size >= 10_000) {
    for (const [k, exp] of burnedTx) {
      if (exp <= nowMs) burnedTx.delete(k);
    }
    if (burnedTx.size >= 10_000) burnedTx.clear(); // pathological fallback — drop, never grow
  }
  burnedTx.set(key, tx.exp);
  return tx;
}

/** Generates state / nonce / PKCE verifier + S256 challenge and builds the
 *  §3.2 authorize redirect. The returned cookie value is already signed. */
export function buildChatgptConnect(redirectUri: string, clientId: string): { url: string; cookie: string } {
  const state = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
  const url = new URL(CHATGPT_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", CHATGPT_OAUTH_SCOPES);
  url.searchParams.set("resource", CHATGPT_OAUTH_RESOURCE);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), cookie: signChatgptTx({ v: 1, state, nonce, verifier, exp: Date.now() + CHATGPT_TX_MAX_AGE_S * 1000 }) };
}

// --- provider calls (all fail to null/false — callers redirect to a fixed
//     slug; provider text never reaches the browser or a log) ----------------

const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** POSTs a form with optional confidential-client Basic auth (the secret is
 *  never a form field or URL component). Bounded response read. */
async function postForm(
  url: string,
  form: URLSearchParams,
  clientId: string,
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const clientSecret = envValue("CHATGPT_OAUTH_CLIENT_SECRET");
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > 64 * 1024) return null;
    return JSON.parse((await res.text()).slice(0, 64 * 1024)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface ChatgptTokenExchange {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Space-separated granted-scope string exactly as issued. */
  scopes: string;
  accessExpiresAt: Date;
  earliestRefreshAt: Date;
}

/** §3.2 step 2: the authorization_code exchange (public client — PKCE only;
 *  confidential adds Basic auth inside postForm). Null on any network /
 *  non-200 / malformed outcome. */
export async function exchangeChatgptAuthorizationCode(o: {
  code: string;
  redirectUri: string;
  clientId: string;
  verifier: string;
}): Promise<ChatgptTokenExchange | null> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirectUri,
    client_id: o.clientId,
    code_verifier: o.verifier,
    resource: CHATGPT_OAUTH_RESOURCE,
  });
  const json = await postForm(CHATGPT_OAUTH_TOKEN_URL, form, o.clientId);
  if (!json) return null;
  const accessToken = optStr(json.access_token);
  const refreshToken = optStr(json.refresh_token);
  const idToken = optStr(json.id_token);
  const scopes = optStr(json.scope);
  if (!accessToken || !refreshToken || !idToken || !scopes) return null;
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  const earliest = Date.parse(optStr(json.earliest_refresh_at) ?? "");
  return {
    accessToken,
    refreshToken,
    idToken,
    scopes,
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000),
    earliestRefreshAt: Number.isNaN(earliest) ? new Date() : new Date(earliest),
  };
}

// --- ID-token verification (jose, §2: RS256 against the remote JWKS, cached) -

type JwksResolver = ReturnType<typeof createLocalJWKSet>;

let jwksCache: { resolver: JwksResolver; kids: Set<string>; at: number } | null = null;
const JWKS_CACHE_MS = 10 * 60_000;

async function fetchJwksResolver(): Promise<{ resolver: JwksResolver; kids: Set<string> } | null> {
  let res: Response;
  try {
    res = await fetch(CHATGPT_OAUTH_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: { keys?: unknown };
  try {
    json = JSON.parse((await res.text()).slice(0, 256 * 1024)) as { keys?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(json.keys) || json.keys.length === 0) return null;
  const kids = new Set(
    json.keys
      .map((k) => (k && typeof k === "object" ? (k as { kid?: unknown }).kid : undefined))
      .filter((kid): kid is string => typeof kid === "string"),
  );
  try {
    return { resolver: createLocalJWKSet(json as Parameters<typeof createLocalJWKSet>[0]), kids };
  } catch {
    return null;
  }
}

/**
 * §2 ID-token verification: RS256 against the cached remote JWKS, issuer
 * `https://auth.openai.com`, audience = our client id, exp/nbf via jose and
 * iat via a manual 5 s future-tolerance check, nonce echo, string sub.
 * Returns the verified `sub` (the stable provider identity that feeds the
 * row's fingerprint) or null on ANY rejection — never throws.
 */
export async function verifyChatgptIdToken(idToken: string, expectedNonce: string, clientId: string): Promise<string | null> {
  let header: { kid?: unknown };
  try {
    header = JSON.parse(Buffer.from(idToken.split(".")[0] ?? "", "base64url").toString("utf8")) as { kid?: unknown };
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!jwksCache || Date.now() - jwksCache.at > JWKS_CACHE_MS) {
      const fresh = await fetchJwksResolver();
      if (fresh) jwksCache = { ...fresh, at: Date.now() };
    }
    if (!jwksCache) return null;
    // Cached set lacks the token's kid ⇒ one forced refresh (key roll), then
    // give up — a kid the provider never published cannot be trusted.
    if (typeof header.kid === "string" && jwksCache.kids.size > 0 && !jwksCache.kids.has(header.kid)) {
      if (attempt === 1) return null;
      const fresh = await fetchJwksResolver();
      if (!fresh) return null;
      jwksCache = { ...fresh, at: Date.now() };
    }
    try {
      const { payload } = await jwtVerify(idToken, jwksCache.resolver, {
        issuer: CHATGPT_OAUTH_ISSUER,
        audience: clientId,
        algorithms: ["RS256"],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
      if (payload.nonce !== expectedNonce) return null;
      if (typeof payload.iat !== "number" || payload.iat > Math.floor(Date.now() / 1000) + 5) return null;
      return payload.sub;
    } catch (err) {
      if (attempt === 0 && (err as { code?: string }).code === "ERR_JWKS_NO_MATCHING_KEY") continue;
      return null;
    }
  }
  return null;
}

// --- default model + revocation ----------------------------------------------

/** §3.2 step 4: fetch the account catalog once; the pinned
 *  CHATGPT_OAUTH_DEFAULT_MODEL wins when set, else the first
 *  visibility=="list" entry's slug. Null (catalog unusable / no list entry)
 *  ⇒ the connect fails — never store a row without a usable model. */
export async function fetchChatgptDefaultModel(accessToken: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(CHATGPT_OAUTH_MODELS_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: { data?: unknown };
  try {
    json = JSON.parse((await res.text()).slice(0, 512 * 1024)) as { data?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(json.data)) return null;
  const pinned = envValue("CHATGPT_OAUTH_DEFAULT_MODEL");
  if (pinned) return pinned;
  for (const entry of json.data) {
    if (!entry || typeof entry !== "object" || (entry as { visibility?: unknown }).visibility !== "list") continue;
    const slug = (entry as { slug?: unknown }).slug;
    if (typeof slug === "string" && slug.length > 0 && slug.length <= 100) return slug;
  }
  return null;
}

/** §3.2 disconnect: best-effort RFC 7009 revocation — 1 try + 2 bounded
 *  retries on network faults/5xx; a 4xx is definitive (retrying cannot
 *  change it). True only when the provider confirmed (2xx — which per RFC
 *  7009 includes already-invalid tokens). */
export async function revokeChatgptRefreshToken(refreshToken: string, clientId: string): Promise<boolean> {
  const form = new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: clientId });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const clientSecret = envValue("CHATGPT_OAUTH_CLIENT_SECRET");
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(CHATGPT_OAUTH_REVOKE_URL, {
        method: "POST",
        headers,
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      if (res.status < 500) return false;
    } catch {
      // network fault — one more bounded retry
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
  return false;
}
