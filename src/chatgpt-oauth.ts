// "Sign in with ChatGPT" plan-usage token store (spec THI-193 §3.3/§4, rev
// fa3288ff; accepted THI-187 plan Steps 1–2). One llm_credentials row per
// seller with kind='chatgpt_oauth': the existing ciphertext column holds ONE
// AES-256-GCM-encrypted JSON bundle {access_token, refresh_token, id_token,
// scopes, access_expires_at, earliest_refresh_at, sub}, reusing the THI-189
// primitives unchanged (encryptSecret/decryptSecret, AAD = sellerId:kind;
// keyFingerprint over the stable provider subject). OpenAI rotates the
// refresh token on EVERY refresh, so a refresh rewrites the whole bundle and
// lands via DB compare-and-swap (a concurrent rotation is never clobbered).
//
// HARD RULES (docs/security.md, same as llm-credentials.ts): plaintext tokens
// exist only inside request-scoped function locals (resolveChatgptCredential
// / refreshChatgptTokens) — never cached module-level, never in a returned
// metadata type, never logged, never sent to the browser. Provider error text
// is sanitized (bounded, token-stripping); only fixed slugs are logged
// (chatgpt_oauth_error). Flag (§3.1, fail closed): CHATGPT_OAUTH_ENABLED="1"
// AND CHATGPT_OAUTH_CLIENT_ID set — off ⇒ resolve returns null even with a
// stored row (dormant rows never consulted; resolution falls through to
// user-key → company unchanged).

import { envValue } from "./config.js";
import { pool } from "./db.js";
import { byoMasterKeyConfigured, decryptSecret, encryptSecret, keyFingerprint } from "./llm-credentials.js";
import { logSecurityEvent, type ChatgptOauthErrorReason } from "./security-events.js";

export const CHATGPT_OAUTH_KIND = "chatgpt_oauth";
/** §2 (pinned 2026-10-15): commercial-lane token endpoint. */
export const CHATGPT_OAUTH_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
/** RFC 8707 resource parameter every grant/refresh repeats (§2). */
const CHATGPT_OAUTH_RESOURCE = "https://api.openai.com/v1";
/** Plan-usage gate (§2): granted scopes must include this before inference. */
export const CHATGPT_PLAN_USAGE_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_OAUTH_LABEL = "ChatGPT plan";

/** Feature flag (§3.1, fail closed): unset/≠"1" or missing client id ⇒ off. */
export function chatgptOauthEnabled(): boolean {
  return envValue("CHATGPT_OAUTH_ENABLED") === "1" && envValue("CHATGPT_OAUTH_CLIENT_ID") !== undefined;
}

/** The stored bundle's JSON shape (§3.3 field names, dates as ISO strings). */
interface StoredBundle {
  access_token: string;
  refresh_token: string;
  id_token: string;
  scopes: string;
  access_expires_at: string;
  earliest_refresh_at: string;
  sub: string;
}

/** Bundle input (connect callback / refresh output) with real Dates. */
export interface ChatgptTokenBundle {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** Space-separated granted-scope string exactly as issued. */
  scopes: string;
  accessExpiresAt: Date;
  earliestRefreshAt: Date;
  sub: string;
}

function serializeBundle(b: ChatgptTokenBundle): string {
  return JSON.stringify({
    access_token: b.accessToken, refresh_token: b.refreshToken, id_token: b.idToken, scopes: b.scopes,
    access_expires_at: b.accessExpiresAt.toISOString(), earliest_refresh_at: b.earliestRefreshAt.toISOString(),
    sub: b.sub,
  } satisfies StoredBundle);
}

function parseBundle(json: string): ChatgptTokenBundle {
  const raw = JSON.parse(json) as Partial<StoredBundle>;
  const str = (v: unknown): string => {
    if (typeof v !== "string") throw new Error("chatgpt_bundle_corrupt");
    return v;
  };
  return {
    accessToken: str(raw.access_token),
    refreshToken: str(raw.refresh_token),
    idToken: str(raw.id_token),
    scopes: str(raw.scopes),
    accessExpiresAt: new Date(str(raw.access_expires_at)),
    earliestRefreshAt: new Date(str(raw.earliest_refresh_at)),
    sub: str(raw.sub),
  };
}

/** Connection metadata — everything the status route/UI may see. Never
 *  tokens (the decrypted bundle lives only in resolve/refresh locals). */
export interface ChatgptConnectionMeta {
  connected: true;
  fingerprint: string;
  model: string;
  access_expires_at: Date | null;
  oauth_sub: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Decrypted credential for one chat turn. Request-scoped: never cache,
 *  never log, never put in a response. */
export interface ResolvedChatgptCredential {
  accessToken: string;
  model: string;
}

interface DbRow {
  model: string;
  ciphertext: string;
  key_fingerprint: string;
  access_expires_at: Date | null;
  oauth_sub: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `model, ciphertext, key_fingerprint, access_expires_at, oauth_sub, created_at, updated_at`;

async function loadRow(sellerId: string): Promise<DbRow | null> {
  const { rows } = await pool.query<DbRow>(
    `SELECT ${SELECT_COLUMNS} FROM llm_credentials WHERE seller_id = $1 AND kind = 'chatgpt_oauth'`,
    [sellerId],
  );
  return rows[0] ?? null;
}

function metaOf(row: DbRow): ChatgptConnectionMeta {
  return {
    connected: true,
    fingerprint: row.key_fingerprint,
    model: row.model,
    access_expires_at: row.access_expires_at,
    oauth_sub: row.oauth_sub,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Metadata-only read: null = not connected. No decryption, no tokens. */
export async function getChatgptConnection(sellerId: string): Promise<ChatgptConnectionMeta | null> {
  const row = await loadRow(sellerId);
  return row ? metaOf(row) : null;
}

/** Stores (first connect) or replaces (re-connect) the seller's ONE OAuth
 *  connection. Whole-bundle write: every rotation replaces access+refresh
 *  together (OpenAI rotates the refresh token on each refresh, §2). */
export async function upsertChatgptConnection(
  sellerId: string,
  bundle: ChatgptTokenBundle,
  model: string,
): Promise<ChatgptConnectionMeta> {
  const ciphertext = encryptSecret(sellerId, CHATGPT_OAUTH_KIND, serializeBundle(bundle));
  const fingerprint = keyFingerprint(bundle.sub); // stable across rotations (sub never changes)
  const { rows } = await pool.query<DbRow>(
    `INSERT INTO llm_credentials (seller_id, kind, label, base_url, model, ciphertext, key_fingerprint, access_expires_at, oauth_sub)
     VALUES ($1, 'chatgpt_oauth', $2, NULL, $3, $4, $5, $6, $7)
     ON CONFLICT (seller_id) WHERE kind = 'chatgpt_oauth'
     DO UPDATE SET model = EXCLUDED.model, ciphertext = EXCLUDED.ciphertext,
                   key_fingerprint = EXCLUDED.key_fingerprint,
                   access_expires_at = EXCLUDED.access_expires_at, oauth_sub = EXCLUDED.oauth_sub,
                   updated_at = now()
     RETURNING ${SELECT_COLUMNS}`,
    [sellerId, CHATGPT_OAUTH_LABEL, model, ciphertext, fingerprint, bundle.accessExpiresAt, bundle.sub],
  );
  return metaOf(rows[0]);
}

/** Removes the connection (disconnect). Idempotent. */
export async function deleteChatgptConnection(sellerId: string): Promise<void> {
  await pool.query(`DELETE FROM llm_credentials WHERE seller_id = $1 AND kind = 'chatgpt_oauth'`, [sellerId]);
}

/** Loads ONLY the refresh token, for the disconnect route's best-effort
 *  revocation (spec §3.2 PR-2). null = no connection. Throws on tamper /
 *  unreadable bundle (incl. unset master key) — the caller deletes the row
 *  anyway and reports the revocation as unconfirmed. */
export async function getChatgptRefreshToken(sellerId: string): Promise<string | null> {
  const row = await loadRow(sellerId);
  if (!row) return null;
  return parseBundle(decryptSecret(sellerId, CHATGPT_OAUTH_KIND, row.ciphertext)).refreshToken;
}

// --- refresh (§3.3): single-flight, compare-and-swap, terminal-error kill ---

/** Bounds + token-strips provider error text (an echoing endpoint must never
 *  bounce token material back through a message) — same contract as
 *  llm-credentials.ts's private sanitizeProviderMessage. */
function sanitizeProviderMessage(message: string, secrets: string[]): string {
  let safe = message;
  for (const s of secrets) {
    if (s.length > 0) safe = safe.split(s).join("«redacted»");
  }
  safe = safe.replace(/\s+/g, " ").trim().slice(0, 300);
  return safe.length > 0 ? safe : "provider_error";
}

/** §2/§3.3: any of these means the stored bundle is dead — delete the row
 *  (fail closed → user-key → company) and log the chatgpt_oauth_error slug. */
const TERMINAL_REFRESH_ERRORS: ReadonlySet<string> = new Set([
  "invalid_grant", "token_expired", "refresh_token_invalidated", "refresh_token_reused", "invalid_client",
]);

export type RefreshChatgptTokensResult =
  | { ok: true; accessToken: string }
  | {
      ok: false;
      reason: ChatgptOauthErrorReason | "not_connected" | "network_error" | "provider_error";
      /** Sanitized, bounded — never token material; never logged by us. */
      message?: string;
    };

/** Token-endpoint response helpers (everything but these fields is ignored). */
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

async function doRefresh(sellerId: string): Promise<RefreshChatgptTokensResult> {
  const row = await loadRow(sellerId);
  if (!row) return { ok: false, reason: "not_connected" };
  const old = parseBundle(decryptSecret(sellerId, CHATGPT_OAUTH_KIND, row.ciphertext));
  const clientId = envValue("CHATGPT_OAUTH_CLIENT_ID");
  if (!clientId) return { ok: false, reason: "provider_error", message: "chatgpt oauth not configured" };
  // §2 refresh grant: grant_type/client_id/refresh_token/resource; scope
  // deliberately OMITTED (repeating it can silently narrow the grant).
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: old.refreshToken,
    resource: CHATGPT_OAUTH_RESOURCE,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const clientSecret = envValue("CHATGPT_OAUTH_CLIENT_SECRET");
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`; // confidential client
  let res: Response;
  try {
    res = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
      method: "POST",
      headers,
      body: form.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const message = sanitizeProviderMessage((err as Error).message ?? "", [old.refreshToken, old.accessToken]);
    return { ok: false, reason: "network_error", message };
  }
  // Pinned first-party endpoint (not user-controlled, unlike THI-189's
  // verify probe) — still bound the parse input as cheap defense in depth.
  let json: Record<string, unknown>;
  try {
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > 64 * 1024) throw new Error("oversized");
    json = JSON.parse((await res.text()).slice(0, 64 * 1024)) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "provider_error", message: "malformed token response" };
  }
  if (!res.ok) {
    const code = optStr(json.error) ?? "";
    if (TERMINAL_REFRESH_ERRORS.has(code)) {
      await deleteChatgptConnection(sellerId);
      logSecurityEvent({ type: "chatgpt_oauth_error", reason: code as ChatgptOauthErrorReason }, { sellerId });
      return { ok: false, reason: code as ChatgptOauthErrorReason };
    }
    const description = sanitizeProviderMessage(optStr(json.error_description) ?? "", [
      old.refreshToken,
      old.accessToken,
    ]);
    return { ok: false, reason: "provider_error", message: description };
  }
  const accessToken = optStr(json.access_token);
  if (!accessToken) return { ok: false, reason: "provider_error", message: "malformed token response" };
  const earliest = Date.parse(optStr(json.earliest_refresh_at) ?? "");
  const expiresIn = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  const next: ChatgptTokenBundle = {
    accessToken,
    refreshToken: optStr(json.refresh_token) ?? old.refreshToken,
    idToken: optStr(json.id_token) ?? old.idToken,
    scopes: optStr(json.scope) ?? old.scopes,
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000),
    earliestRefreshAt: Number.isNaN(earliest) ? new Date() : new Date(earliest),
    sub: old.sub, // stable provider identity — never changes on refresh
  };
  // Compare-and-swap (§3.3): another in-flight turn may have rotated the
  // bundle between our read and this write. Landing only when the ciphertext
  // is still the one we refreshed from means a concurrent winner is never
  // clobbered (its refresh token would be destroyed — the reuse hazard the
  // CAS exists for). 0 rows ⇒ we lost ⇒ re-read once and use the winner's
  // token (at least as fresh as ours) instead of issuing another refresh.
  const { rowCount } = await pool.query(
    `UPDATE llm_credentials SET ciphertext = $2, access_expires_at = $3, updated_at = now()
     WHERE seller_id = $1 AND kind = 'chatgpt_oauth' AND ciphertext = $4`,
    [sellerId, encryptSecret(sellerId, CHATGPT_OAUTH_KIND, serializeBundle(next)), next.accessExpiresAt, row.ciphertext],
  );
  if ((rowCount ?? 0) > 0) return { ok: true, accessToken: next.accessToken };
  const winner = await loadRow(sellerId);
  if (!winner) return { ok: false, reason: "not_connected" };
  return { ok: true, accessToken: parseBundle(decryptSecret(sellerId, CHATGPT_OAUTH_KIND, winner.ciphertext)).accessToken };
}

/** Single-flight per seller (§3.3): concurrent turns share ONE token-endpoint
 *  call — two parallel refreshes would race the rotation (the second would
 *  present an already-consumed refresh token). In-process map only; the DB
 *  CAS above is the cross-process guard. */
const refreshInFlight = new Map<string, Promise<RefreshChatgptTokensResult>>();

export function refreshChatgptTokens(sellerId: string): Promise<RefreshChatgptTokensResult> {
  const existing = refreshInFlight.get(sellerId);
  if (existing) return existing;
  const flight = doRefresh(sellerId).finally(() => refreshInFlight.delete(sellerId));
  refreshInFlight.set(sellerId, flight);
  return flight;
}

/**
 * Loads + decrypts the seller's OAuth credential for one chat turn (§3.3/§3.4).
 * Returns null — never throws for state reasons — when the flag/config is off
 * (dormant row), the master key is unavailable (fail closed, THI-191 N2
 * pattern), no row exists, the plan-usage scope is missing, or the access
 * token is expired and cannot be refreshed yet. An expired-but-refreshable
 * token triggers exactly one single-flight refresh first. Throws only on
 * tamper/corruption (GCM auth / malformed bundle) — callers log a slug and
 * fall back to the next credential in the resolution order (THI-197 pattern).
 */
export async function resolveChatgptCredential(sellerId: string): Promise<ResolvedChatgptCredential | null> {
  if (!chatgptOauthEnabled()) return null;
  if (!byoMasterKeyConfigured()) return null;
  const row = await loadRow(sellerId);
  if (!row) return null;
  const b = parseBundle(decryptSecret(sellerId, CHATGPT_OAUTH_KIND, row.ciphertext));
  if (!b.scopes.split(/\s+/).includes(CHATGPT_PLAN_USAGE_SCOPE)) return null;
  const now = Date.now();
  if (b.accessExpiresAt.getTime() > now) return { accessToken: b.accessToken, model: row.model };
  if (b.earliestRefreshAt.getTime() > now) return null; // not refreshable yet → fall through this turn
  const refreshed = await refreshChatgptTokens(sellerId);
  return refreshed.ok ? { accessToken: refreshed.accessToken, model: row.model } : null;
}
