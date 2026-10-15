// Bring-your-own LLM credential store (spec THI-186 Phase 1 / THI-189 §1–§4).
//
// The server must PRESENT these secrets to an LLM provider (unlike thg_
// seller keys, which are hash-only — THI-114), so they are stored encrypted
// at rest: AES-256-GCM under a DEDICATED master-key env var
// LLM_CREDENTIALS_MASTER_KEY (64 hex chars = 32 bytes). Deliberately not
// derived from SESSION_SECRET: rotation independence — a leaked session
// secret must not expose LLM keys and vice versa. Unset or malformed ⇒ the
// BYO feature is disabled (fail closed, see byoMasterKeyConfigured); boot is
// NOT fatal because the feature is optional.
//
// HARD RULES (docs/security.md, same as chat-usage.ts):
// - The plaintext key exists only inside request-scoped function locals:
//   resolveLlmCredential (chat turn) and verifyLlmCredential (save). It is
//   never cached module-level, never a field of a returned row type that
//   reaches a response, and never logged — every log line in this codebase
//   is built field-by-field from fixed whitelists.
// - Error messages that may carry provider text are sanitized through
//   sanitizeProviderMessage before they can reach a response.

import crypto from "node:crypto";
import { pool } from "./db.js";

/** env name, kept in one place for .env.example / compose / docs alignment. */
export const LLM_CREDENTIALS_MASTER_KEY_ENV = "LLM_CREDENTIALS_MASTER_KEY";

/**
 * Parses LLM_CREDENTIALS_MASTER_KEY. Returns null when unset or not exactly
 * 64 hex chars (32 bytes) — read per call so tests can stub the env and an
 * operator-set bad value fails closed at every use, not just at boot.
 */
export function byoMasterKey(): Buffer | null {
  const raw = (process.env[LLM_CREDENTIALS_MASTER_KEY_ENV] ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(raw)) return null;
  return Buffer.from(raw, "hex");
}

/** Feature flag derived from the master key: no key configured ⇒ no BYO. */
export function byoMasterKeyConfigured(): boolean {
  return byoMasterKey() !== null;
}

/** AAD (spec §1): binds every ciphertext to its owner and kind — a row
 *  swapped between sellers fails GCM authentication. */
function aadFor(sellerId: string, kind: string): Buffer {
  return Buffer.from(`${sellerId}:${kind}`, "utf8");
}

/** Encrypts `plaintext` for `sellerId`/`kind`: 'v1.' + base64url(iv|tag|ct).
 *  Fresh 12-byte IV per call; version prefix leaves room for master-key
 *  rotation later (decrypt by version). Throws when the master key is
 *  unset/malformed — callers gate on byoMasterKeyConfigured() first. */
export function encryptSecret(sellerId: string, kind: string, plaintext: string): string {
  const master = byoMasterKey();
  if (!master) throw new Error("byo_master_key_unconfigured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", master, iv);
  cipher.setAAD(aadFor(sellerId, kind));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${Buffer.concat([iv, tag, ct]).toString("base64url")}`;
}

/** Inverse of encryptSecret. Throws on tamper, wrong master key, wrong
 *  sellerId/kind (AAD mismatch), or unknown version — never returns
 *  attacker-influenced plaintext. */
export function decryptSecret(sellerId: string, kind: string, stored: string): string {
  const master = byoMasterKey();
  if (!master) throw new Error("byo_master_key_unconfigured");
  if (!stored.startsWith("v1.")) throw new Error("ciphertext_version_unknown");
  const blob = Buffer.from(stored.slice(3), "base64url");
  if (blob.length < 12 + 16) throw new Error("ciphertext_truncated");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", master, iv);
  decipher.setAAD(aadFor(sellerId, kind));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Display-only fingerprint (spec §1): first 12 hex of HMAC-SHA256(master,
 *  apiKey). Lets a user confirm WHICH of their keys is stored without the
 *  key being recoverable or usable as a lookup. */
export function keyFingerprint(apiKey: string): string {
  const master = byoMasterKey();
  if (!master) throw new Error("byo_master_key_unconfigured");
  return crypto.createHmac("sha256", master).update(apiKey, "utf8").digest("hex").slice(0, 12);
}

// --- model allow-gate (spec §4) ----------------------------------------------

/** Tool-calling-capable model families (OpenAI-compatible endpoints).
 *  Substring match, case-insensitive. Env-overridable via
 *  LLM_BYO_ALLOWED_MODELS (comma-separated). A denied model fails the PUT
 *  (never a silent runtime swap at save time); at runtime a stored model
 *  that stopped matching falls back to the company key with telemetry
 *  showing credential_source "company". */
const DEFAULT_ALLOWED_MODELS = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-4-turbo",
  "gpt-4.5",
  "gpt-5",
  "o3",
  "o4-mini",
  "claude",
  "gemini",
  "qwen",
  "llama",
  "mistral",
  "deepseek",
  "grok",
  "kimi",
];

export function modelAllowedForByo(model: string): boolean {
  const raw = process.env.LLM_BYO_ALLOWED_MODELS;
  const tokens = (raw && raw.trim().length > 0 ? raw : DEFAULT_ALLOWED_MODELS.join(","))
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const m = model.trim().toLowerCase();
  return tokens.some((t) => m.includes(t));
}

// --- base URL handling (spec §3) ----------------------------------------------

export const DEFAULT_BYO_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

/** G1 (Security review THI-191, R1 per THI-194): private/loopback IPv4 and
 *  IPv6 literals — rejected as BYO endpoints unless local endpoints are
 *  explicitly enabled (an internal-scanner primitive otherwise). The IPv6
 *  pattern anchors on a leading `::`, which covers `::`, `::1`, and the
 *  IPv4-mapped `::ffff:a.b.c.d` forms that otherwise bypass the check
 *  (THI-194 PoC); public v6 addresses (e.g. 2600:…) do not start with `::`.
 *  Literal check only; DNS rebinding to a private IP is a documented
 *  residual, not covered here. */
const PRIVATE_IP_V4 =
  /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const PRIVATE_IP_V6 = /^\[?(::|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || PRIVATE_IP_V4.test(host) || PRIVATE_IP_V6.test(host);
}

/** G1: local endpoints (plain http / localhost / loopback IPs) are opt-in —
 *  `LLM_BYO_ALLOW_LOCAL_ENDPOINTS=1` (dev/self-host troubleshooting); off in
 *  prod by default so the verify probe and chat turns never target them. */
export function localEndpointsAllowed(): boolean {
  const v = process.env.LLM_BYO_ALLOW_LOCAL_ENDPOINTS;
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * Normalizes a user-supplied endpoint. Accepts a full `…/chat/completions`
 * URL (used as-is) or a base such as `https://api.openai.com/v1` (append
 * `/chat/completions`). https only, except plain http for localhost/
 * 127.0.0.1/[::1] when LLM_BYO_ALLOW_LOCAL_ENDPOINTS is set (G1). Private-IP
 * literals (v4, v6 incl. `::`/loopback/ULA/mapped forms) and the name
 * `localhost` itself are rejected regardless of scheme unless that flag is
 */
export function normalizeBaseUrl(input: string | undefined | null): string | null {
  const trimmed = (input ?? "").trim();
  let url: URL;
  try {
    url = new URL(trimmed.length === 0 ? DEFAULT_BYO_COMPLETIONS_URL : trimmed);
  } catch {
    return null;
  }
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1" ||
    /^127\./.test(url.hostname);
  if (isPrivateHost(url.hostname) && !localEndpointsAllowed()) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal && localEndpointsAllowed())) return null;
  let full: URL;
  try {
    full = url.pathname.endsWith("/chat/completions")
      ? url
      : new URL(url.pathname.replace(/\/+$/, "") + "/chat/completions", url);
  } catch {
    return null;
  }
  return full.toString();
}

// --- save-time verify (spec §3): 1-token test call with tools attached -------

export interface VerifyLlmCredentialInput {
  apiKey: string;
  /** Already-normalized full completions URL. */
  completionsUrl: string;
  model: string;
}

export type VerifyLlmCredentialResult =
  | { ok: true }
  | { ok: false; reason: "unauthorized" | "model_rejected" | "bad_endpoint" | "timeout" | "unknown"; message: string };

/** The one tool definition used by the verify probe (spec §3): including
 *  `tools` makes endpoints/models without tool-calling support reject at
 *  SAVE time instead of silently degrading chat later. */
const VERIFY_TOOL = {
  type: "function" as const,
  function: {
    name: "verify_probe",
    description: "Probe tool used only to verify endpoint capability.",
    parameters: { type: "object" as const, properties: {} },
  },
};

/** Strips anything containing the API key out of a provider error message
 *  (a hostile custom endpoint could echo request data back), then bounds the
 *  length. Never lets key material ride into a response or log. */
function sanitizeProviderMessage(message: string, apiKey: string): string {
  let safe = message;
  if (apiKey.length > 0) safe = safe.split(apiKey).join("«redacted»");
  safe = safe.replace(/\s+/g, " ").trim().slice(0, 300);
  return safe.length > 0 ? safe : "provider_error";
}

/** G2 (Security review THI-191): the 10s timeout bounds time, not bytes — a
 *  hostile endpoint can stream an unbounded error body into app memory. Read
 *  at most 64 KB of it (honoring content-length when declared) and cancel the
 *  stream past that; null ⇒ oversized, callers use a fixed slug. */
const MAX_VERIFY_BODY_BYTES = 64 * 1024;

async function readBoundedBody(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_VERIFY_BODY_BYTES) return null;
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_VERIFY_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** One-token test call against the user's endpoint+key+model. 200 ⇒ usable.
 *  401/403 ⇒ bad key; 404 / model_not_found ⇒ model rejected; timeouts and
 *  fetch-level failures are bad_endpoint/timeout. Never returns key material. */
export async function verifyLlmCredential(input: VerifyLlmCredentialInput): Promise<VerifyLlmCredentialResult> {
  try {
    const res = await fetch(input.completionsUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        tools: [VERIFY_TOOL],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true };
    // G2: bounded read — an oversized body becomes a fixed slug, never a
    // buffer; sanitized text only otherwise.
    const text = (await readBoundedBody(res)) ?? "";
    const message = sanitizeProviderMessage(text, input.apiKey);
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized", message };
    if (res.status === 404 || (/model/i.test(text) && /not.*(found|exist)|does not exist|unknown model/i.test(text))) {
      return { ok: false, reason: "model_rejected", message };
    }
    return { ok: false, reason: "bad_endpoint", message };
  } catch (err) {
    const message = sanitizeProviderMessage((err as Error).message ?? "", input.apiKey);
    if ((err as Error).name === "TimeoutError" || (err as { cause?: { name?: string } })?.cause?.name === "TimeoutError") {
      return { ok: false, reason: "timeout", message: "endpoint timed out" };
    }
    return { ok: false, reason: "unknown", message };
  }
}

// --- store (spec §1–§2): parameterized SQL only -------------------------------

/** Stored credential metadata — everything the UI/API may see. The decrypted
 *  key exists only inside ResolveLlmCredentialResult, which never reaches a
 *  response. */
export interface LlmCredentialRow {
  label: string;
  model: string;
  base_url: string | null;
  key_fingerprint: string;
  created_at: Date;
  updated_at: Date;
}

/** Decrypted credential for one chat turn / one verify call. Request-scoped:
 *  never cache, never log, never put in a response. */
export interface ResolvedLlmCredential {
  apiKey: string;
  model: string;
  completionsUrl: string;
}

interface DbRow {
  label: string;
  model: string;
  base_url: string | null;
  ciphertext: string;
  key_fingerprint: string;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `label, model, base_url, ciphertext, key_fingerprint, created_at, updated_at`;

export async function getLlmCredential(sellerId: string): Promise<LlmCredentialRow | null> {
  const { rows } = await pool.query<DbRow>(
    `SELECT ${SELECT_COLUMNS} FROM llm_credentials WHERE seller_id = $1 AND kind = 'api_key'`,
    [sellerId],
  );
  const row = rows[0];
  if (!row) return null;
  const { ciphertext: _ciphertext, ...meta } = row;
  return meta;
}

/** Loads + decrypts the seller's credential (spec §6 resolution order).
 *  Returns null when none is stored, when the master key is unavailable
 *  (N2, fail closed → company key — never an exception), or when the stored
 *  row no longer passes the URL/model gates. Throws only on tamper/corruption
 *  — callers treat that as "fall back to company key" after logging a
 *  security event slug (no ciphertext in the log). */
export async function resolveLlmCredential(sellerId: string): Promise<ResolvedLlmCredential | null> {
  // N2 (Security review THI-191): honor the documented null contract — with
  // no master key the feature is disabled, so callers silently fall back to
  // the company credential instead of distinguishing an exception.
  if (!byoMasterKeyConfigured()) return null;
  const { rows } = await pool.query<DbRow>(
    `SELECT ${SELECT_COLUMNS} FROM llm_credentials WHERE seller_id = $1 AND kind = 'api_key'`,
    [sellerId],
  );
  const row = rows[0];
  if (!row) return null;
  const completionsUrl = row.base_url ? normalizeBaseUrl(row.base_url) : DEFAULT_BYO_COMPLETIONS_URL;
  if (!completionsUrl) return null; // stored base_url no longer parses → company fallback
  if (!modelAllowedForByo(row.model)) return null; // gate revoked at runtime → company fallback
  const apiKey = decryptSecret(sellerId, "api_key", row.ciphertext);
  return { apiKey, model: row.model, completionsUrl };
}

export interface UpsertLlmCredentialInput {
  label: string;
  model: string;
  /** Null = provider default (OpenAI). */
  baseUrl: string | null;
  apiKey: string;
}

/** Stores (first save) or rotates (replace) the seller's ONE api_key
 *  credential. The partial unique index makes this atomic; verify must have
 *  run BEFORE this call (spec §2: verify failure never writes). */
export async function upsertLlmCredential(sellerId: string, input: UpsertLlmCredentialInput): Promise<LlmCredentialRow> {
  const ciphertext = encryptSecret(sellerId, "api_key", input.apiKey);
  const fingerprint = keyFingerprint(input.apiKey);
  const { rows } = await pool.query<DbRow>(
    `INSERT INTO llm_credentials (seller_id, kind, label, base_url, model, ciphertext, key_fingerprint)
     VALUES ($1, 'api_key', $2, $3, $4, $5, $6)
     ON CONFLICT (seller_id) WHERE kind = 'api_key'
     DO UPDATE SET label = EXCLUDED.label, base_url = EXCLUDED.base_url, model = EXCLUDED.model,
                   ciphertext = EXCLUDED.ciphertext, key_fingerprint = EXCLUDED.key_fingerprint,
                   updated_at = now()
     RETURNING ${SELECT_COLUMNS}`,
    [sellerId, input.label, input.baseUrl, input.model, ciphertext, fingerprint],
  );
  const { ciphertext: _ciphertext, ...meta } = rows[0];
  return meta;
}

/** Removes the stored credential (fall back to the company key). Idempotent
 *  from the route's view — a second DELETE is a 200 with nothing to do. */
export async function deleteLlmCredential(sellerId: string): Promise<void> {
  await pool.query(`DELETE FROM llm_credentials WHERE seller_id = $1 AND kind = 'api_key'`, [sellerId]);
}
