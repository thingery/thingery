// HTTP API for the browser pages: account signup/login and the chat endpoint.
// Mounted after the raw-body /mcp route; express.json() applies from here on.

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  accountByEmail,
  createAccount,
  EMAIL_VERIFICATION_TTL_S,
  regenerateApiKey,
  sellerFromSession,
  sessionCookieOptions,
  signSession,
  SESSION_SECRET,
  verifyPassword,
  SESSION_COOKIE,
  type SignupRow,
} from "./auth.js";
import { chatTurn, chatConfigured, type ChatMessage } from "./chat.js";
import { chatLimits, dailyTokenBudget } from "./chat-limits.js";
import {
  CHATGPT_PLAN_USAGE_SCOPE,
  chatgptOauthEnabled,
  deleteChatgptConnection,
  getChatgptConnection,
  getChatgptRefreshToken,
  upsertChatgptConnection,
} from "./chatgpt-oauth.js";
import {
  CHATGPT_TX_COOKIE,
  buildChatgptConnect,
  chatgptOauthRedirectUri,
  chatgptTxCookieClearOptions,
  chatgptTxCookieOptions,
  consumeChatgptTx,
  exchangeChatgptAuthorizationCode,
  fetchChatgptDefaultModel,
  revokeChatgptRefreshToken,
  verifyChatgptIdToken,
} from "./chatgpt-oauth-flow.js";
import { resolveChatgptCredential } from "./chatgpt-oauth.js";
import {
  byoMasterKeyConfigured,
  deleteLlmCredential,
  getLlmCredential,
  modelAllowedForByo,
  normalizeBaseUrl,
  resolveLlmCredential,
  upsertLlmCredential,
  verifyLlmCredential,
  type ResolvedLlmCredential,
  type VerifyLlmCredentialResult,
} from "./llm-credentials.js";
import { addItemImage, MAX_IMAGE_BYTES, MAX_IMAGES_PER_ITEM, uploadsDir } from "./images.js";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { asyncHandler } from "./oauth.js";
import { RateLimiter } from "./rate-limit.js";
import {
  updateWanted,
  listMyWanted,
  wantedToPublic,
  WantedLimitError,
  WantedValidationError,
  ContactInfoError,
  WantedNotFoundError,
} from "./wanted.js";
import { createWantedWithAlert, wantedCreateSchema, wantedEditShape, wantedWriteLimiter } from "./wanted-writes.js";
import crypto from "node:crypto";
import { pool } from "./db.js";
import { orderFlowConfig, envValue } from "./config.js";
import { applyTransition, IllegalTransitionError, type OrderRow } from "./orders.js";
import { logSecurityEvent } from "./security-events.js";
import { page, escapeHtml } from "./web-pages.js";
import { getStripe, createRefundForOrder, createTransferForOrder, retrieveTransfer } from "./stripe.js";

const authAttemptLimiter = new RateLimiter(10, 60 * 60_000); // 10 signups/logins per IP per hour
const apiKeyRotateLimiter = new RateLimiter(10, 60 * 60_000); // 10 key rotations per seller per hour (THI-114)
export const chatAnonLimiter = new RateLimiter(chatLimits.turnsHourlyAnon, 60 * 60_000); // anonymous chats per IP per hour (THI-180: env-configurable)
export const chatAuthedLimiter = new RateLimiter(chatLimits.turnsHourlyAuthed, 60 * 60_000); // logged-in chats per hour (THI-180: env-configurable)
export const adminAttemptLimiter = new RateLimiter(10, 60 * 60_000); // 10 admin calls per IP per hour (F7)
export const imageUploadLimiter = new RateLimiter(30, 60 * 60_000); // 30 image uploads per seller per hour (THI-110 / H3)
export const imageUploadIpLimiter = new RateLimiter(120, 60 * 60_000); // 120 image upload attempts per IP per hour (THI-140 / THI-123 obs 2)
export const imageMutationLimiter = new RateLimiter(60, 60 * 60_000); // 60 image delete/reorder mutations per seller per hour (THI-308 F6: churn here must never consume upload quota)
export const llmCredentialLimiter = new RateLimiter(10, 60 * 60_000); // 10 BYO credential writes per seller per hour (THI-189)
export const chatgptConnectLimiter = new RateLimiter(10, 60 * 60_000); // 10 ChatGPT connect starts per seller per hour (THI-193 §3.2)

function clientIp(req: Request): string {
  return req.ip ?? "unknown";
}

export const api = express.Router();

// --- accounts --------------------------------------------------------------

const signupSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(80).optional(),
});

// THI-59 / THI-58: every async handler is wrapped in asyncHandler — rejections
// reach the terminal error middleware in mountApiRoutes below instead of
// escaping as unhandled rejections that kill the process (Express 4 does not
// route rejected promises to error middleware on its own).

api.post("/signup", asyncHandler(async (req: Request, res: Response) => {
  if (!authAttemptLimiter.allow(`ip:${clientIp(req)}`)) {
    // THI-112: brute-force attempts on the auth surface are first-class
    // security events — the 429 response alone leaves no trace.
    logSecurityEvent({ type: "rate_limit", route: "/api/signup" }, { ip: clientIp(req) });
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Valid email and a password of at least 8 characters are required." });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  if (await accountByEmail(email)) {
    res.status(409).json({ error: "An account with this email already exists." });
    return;
  }
  // createAccount rejections flow to the terminal middleware as a generic
  // JSON 500 — the old local catch leaked raw driver detail (spec THI-58 F5).
  // THI-61 (Security THI-60 note N3 / spec THI-58 §9 OQ3): two concurrent
  // signups can both pass the pre-check above; the insert loser hits the
  // sellers email unique constraint (pg 23505) and gets the same 409 body
  // as the pre-check. Any other fault rethrows — generic 500, no detail.
  let account: SignupRow;
  try {
    account = await createAccount(email, parsed.data.password, parsed.data.name ?? email.split("@")[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "An account with this email already exists." });
      return;
    }
    throw err;
  }
  // THI-112: signup success — correlated by seller id + IP (H4.2).
  logSecurityEvent({ type: "signup", outcome: "success" }, { sellerId: account.id, ip: clientIp(req) });
  // Sign at the live epoch (spec THI-115 §3): a fresh account is epoch 0, but
  // passing the row's value keeps the cookie correct-by-construction.
  res.cookie(SESSION_COOKIE, signSession(account.id, account.session_epoch), sessionCookieOptions());
  // THI-762 (THI-760 Phase 0 PR 1): surface the verification token ONLY outside
  // production — the show-once plaintext for dev/testing until PR 2's mailer
  // logs it via DryRunMailer. Production never returns it; the signup flow and
  // every existing response field are otherwise unchanged (deployable dark).
  const sellerBody = { name: account.display_name, email: account.email, api_key: account.api_key };
  if (process.env.NODE_ENV === "production") {
    res.json({ seller: sellerBody });
  } else {
    res.json({
      seller: sellerBody,
      email_verification: { token: account.email_verification_token, expires_in_s: EMAIL_VERIFICATION_TTL_S },
    });
  }
}));

api.post("/login", asyncHandler(async (req: Request, res: Response) => {
  if (!authAttemptLimiter.allow(`ip:${clientIp(req)}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/login" }, { ip: clientIp(req) });
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  // THI-55 (repeated-param type-confusion sweep): a JSON body can carry
  // arrays/objects where strings are expected, and email.toLowerCase() on an
  // array is a TypeError → generic 500 via the terminal middleware. Treat
  // non-string credentials as absent — the same fail-closed 401 as a wrong
  // email. `?? {}` also covers a non-object body (top-level JSON array/string).
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof body.email === "string" ? body.email : undefined;
  const password = typeof body.password === "string" ? body.password : undefined;
  const account = email ? await accountByEmail(email.toLowerCase()) : null;
  if (!account || !verifyPassword(password ?? "", account.password_hash)) {
    // THI-112: no email/username is logged — the failure event carries only
    // outcome + IP, so the log can't become a credential-validity oracle.
    logSecurityEvent({ type: "login", outcome: "failure" }, { ip: clientIp(req) });
    res.status(401).json({ error: "Wrong email or password." });
    return;
  }
  logSecurityEvent({ type: "login", outcome: "success" }, { sellerId: account.id, ip: clientIp(req) });
  // Sign at the live epoch (spec THI-115 §3): after a future epoch bump (key
  // regeneration), a cookie signed at a stale epoch would fail verification
  // immediately — so login always reads the seller's current epoch.
  res.cookie(SESSION_COOKIE, signSession(account.id, account.session_epoch), sessionCookieOptions());
  // THI-125 verdict / THI-158 contract: login no longer returns the API key —
  // the key is show-once (signup + regenerate only), and the plaintext column
  // it used to be read from no longer exists. public/account.js renders the
  // masked key hint + regenerate path when the field is absent.
  res.json({ seller: { name: account.display_name, email: account.email } });
}));

api.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  res.json({ ok: true });
});

api.get("/me", asyncHandler(async (req: Request, res: Response) => {
  // The .catch stays: a session-lookup fault means anonymous here (intended
  // semantics, spec THI-58 D3), not a 500.
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.json({ seller: null });
    return;
  }
  // THI-114: no api_key here — the key is show-once (signup/regenerate).
  res.json({ seller: { name: seller.display_name } });
}));

// THI-114 (security doc §6 H2): rotate the seller API key. Session-auth only;
// the new key is returned exactly once and the old one dies atomically with
// the UPDATE (hash replaced; THI-158 contract — there is no plaintext column).
// The same UPDATE bumps sellers.session_epoch (THI-114 spec item 3), revoking
// every outstanding session cookie — the response re-signs the acting session
// at the new epoch so the seller rotating their own key stays logged in while
// any other session (e.g. a stolen browser) is revoked.
api.post("/me/api-key", asyncHandler(async (req: Request, res: Response) => {
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to manage your API key." });
    return;
  }
  if (!apiKeyRotateLimiter.allow(`seller:${seller.id}`)) {
    res.status(429).json({ error: "Too many regenerations. Try again later." });
    return;
  }
  const rotated = await regenerateApiKey(seller.id);
  if (!rotated) {
    // Session was valid but the row vanished between the two queries.
    res.status(404).json({ error: "Account not found." });
    return;
  }
  res.cookie(
    SESSION_COOKIE,
    signSession(seller.id, rotated.sessionEpoch),
    sessionCookieOptions(),
  );
  res.set("Cache-Control", "no-store"); // show-once: never cache the plaintext key
  res.json({ api_key: rotated.apiKey });
}));

// --- bring-your-own LLM credential (spec THI-186 Phase 1 / THI-189) ----------

// Session-auth-only surface for the seller's own OpenAI-compatible chat key.
// The plaintext key appears exactly once — in the PUT body — and never in any
// response, log line, or cache (no-store on all three routes). Every write
// passes the verify probe FIRST (spec §2: a failed verify never touches the
// DB), so a stored credential is always one a 1-token call with tools already
// accepted.
const llmCredentialPutSchema = z.object({
  api_key: z.string().min(20).max(400),
  model: z.string().min(1).max(100),
  base_url: z.string().max(500).optional(),
  label: z.string().max(80).optional(),
});

/** User-facing text for a failed verify probe. The probe's message is already
 *  sanitized in src/llm-credentials.ts (key material stripped, bounded);
 *  this only prefixes phrasing. */
function llmVerifyErrorText(v: VerifyLlmCredentialResult & { ok: false }): string {
  switch (v.reason) {
    case "unauthorized":
      return `The endpoint rejected this API key (${v.message}).`;
    case "model_rejected":
      return `The endpoint rejected this model (${v.message}).`;
    case "bad_endpoint":
      return `The endpoint did not accept the request (${v.message}).`;
    case "timeout":
      return "The endpoint timed out — try again.";
    default:
      return `Could not verify the key against the endpoint (${v.message}).`;
  }
}

api.get("/me/llm-credential", asyncHandler(async (req: Request, res: Response) => {
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to manage your chat model." });
    return;
  }
  // Metadata only — the stored key material can never appear here (the
  // store never returns ciphertext, and decryption never runs on GET).
  const credential = await getLlmCredential(seller.id);
  res.set("Cache-Control", "no-store");
  res.json({ byo_enabled: byoMasterKeyConfigured(), credential });
}));

api.put("/me/llm-credential", asyncHandler(async (req: Request, res: Response) => {
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to manage your chat model." });
    return;
  }
  if (!llmCredentialLimiter.allow(`seller:${seller.id}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/me/llm-credential" }, { sellerId: seller.id });
    res.status(429).json({ error: "Too many changes — try again later." });
    return;
  }
  // Fail closed the same way the store does: no master key, no feature.
  if (!byoMasterKeyConfigured()) {
    res.status(503).json({ error: "This server does not accept custom model keys." });
    return;
  }
  const parsed = llmCredentialPutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Need api_key (20–400 chars), model (1–100), optional base_url and label." });
    return;
  }
  const { api_key, model, base_url, label } = parsed.data;
  // Tool-calling gate (spec §4): chat needs tools, so only tool-capable
  // models may be stored. The model string is the seller's own input echoed
  // back to them only, never logged.
  if (!modelAllowedForByo(model)) {
    res.status(400).json({ error: `Model "${model}" is not on this server's list of tool-calling models.` });
    return;
  }
  const completionsUrl = normalizeBaseUrl(base_url);
  if (!completionsUrl) {
    res.status(400).json({ error: "base_url must be an https URL of an OpenAI-compatible endpoint (or omitted)." });
    return;
  }
  // Verify-before-write: a key the endpoint rejects (or an endpoint without
  // tool support) is never stored. Errors carry sanitized provider text only.
  const verify = await verifyLlmCredential({ apiKey: api_key, completionsUrl, model });
  if (!verify.ok) {
    res.status(400).json({ error: llmVerifyErrorText(verify) });
    return;
  }
  const credential = await upsertLlmCredential(seller.id, {
    label: label?.trim() ?? "",
    model,
    baseUrl: base_url?.trim() ? base_url.trim() : null,
    apiKey: api_key,
  });
  res.set("Cache-Control", "no-store");
  res.json({ credential });
}));

api.delete("/me/llm-credential", asyncHandler(async (req: Request, res: Response) => {
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to manage your chat model." });
    return;
  }
  // Works even with no master key (users can always remove what they stored).
  await deleteLlmCredential(seller.id);
  res.set("Cache-Control", "no-store");
  res.json({ ok: true });
}));

// --- Sign in with ChatGPT plan usage (spec THI-193 §3.2/§5, PR-2) -----------

// Session-authenticated, flag-gated browser OAuth surface (connect →
// callback → status/disconnect). Fail closed (§3.1): when
// chatgptOauthEnabled() is off every route below is 404 — a disabled
// surface is indistinguishable from an absent one (admin-route pattern),
// and the connect route sets no cookie. Tokens never reach the browser in
// any response, redirect URL or log line; provider failures surface as
// fixed /login.html?chatgpt=<slug> redirects only (bounded sanitized
// slugs). The flow mechanics live in src/chatgpt-oauth-flow.ts.

function readChatgptTxCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === CHATGPT_TX_COOKIE) return rest.join("=");
  }
  return undefined;
}

api.get("/me/chatgpt", asyncHandler(async (req: Request, res: Response) => {
  if (!chatgptOauthEnabled()) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to manage your ChatGPT connection." });
    return;
  }
  // Metadata only — getChatgptConnection never decrypts, so no token
  // material can appear here (§3.2: no tokens, no scopes string).
  const connection = await getChatgptConnection(seller.id);
  res.set("Cache-Control", "no-store");
  res.json({
    enabled: true,
    connected: connection !== null,
    fingerprint: connection?.fingerprint ?? null,
    model: connection?.model ?? null,
    plan_usage: true,
  });
}));

api.get("/me/chatgpt/connect", asyncHandler(async (req: Request, res: Response) => {
  if (!chatgptOauthEnabled()) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to connect your ChatGPT account." });
    return;
  }
  if (!chatgptConnectLimiter.allow(`seller:${seller.id}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/me/chatgpt/connect" }, { sellerId: seller.id });
    res.status(429).json({ error: "Too many attempts — try again later." });
    return;
  }
  // Same fail-closed posture as the BYO PUT: no master key, no feature —
  // and the flow needs an exact redirect URI before it can start.
  const clientId = envValue("CHATGPT_OAUTH_CLIENT_ID");
  const redirectUri = chatgptOauthRedirectUri();
  if (!byoMasterKeyConfigured() || !clientId || !redirectUri) {
    res.status(503).json({ error: "ChatGPT sign-in is not configured on this server." });
    return;
  }
  const { url, cookie } = buildChatgptConnect(redirectUri, clientId);
  res.cookie(CHATGPT_TX_COOKIE, cookie, chatgptTxCookieOptions());
  res.redirect(302, url);
}));

api.get("/me/chatgpt/callback", asyncHandler(async (req: Request, res: Response) => {
  if (!chatgptOauthEnabled()) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to connect your ChatGPT account." });
    return;
  }
  // Every outcome below clears the tx cookie (§3.2) and ends in a redirect
  // with a fixed slug — never provider text, never tokens.
  const fail = (slug: "error" | "declined" | "plan_not_enabled") => {
    res.clearCookie(CHATGPT_TX_COOKIE, chatgptTxCookieClearOptions());
    res.redirect(302, `/login.html?chatgpt=${slug}`);
  };
  // Consume the tx ONCE, server-side (signature/expiry/single-use checked
  // and burned in one step) — then bind the callback to it via the state
  // echo. A missing/expired/reused cookie or a mismatched state never
  // reaches the exchange.
  const tx = consumeChatgptTx(readChatgptTxCookie(req));
  const q = req.query as Record<string, unknown>;
  const state = typeof q.state === "string" ? q.state : "";
  if (!tx || state !== tx.state) {
    fail("error");
    return;
  }
  if (q.error === "access_denied") {
    fail("declined");
    return;
  }
  const code = typeof q.code === "string" ? q.code : "";
  const clientId = envValue("CHATGPT_OAUTH_CLIENT_ID");
  const redirectUri = chatgptOauthRedirectUri();
  if (code.length === 0 || code.length > 512 || !clientId || !redirectUri || !byoMasterKeyConfigured()) {
    fail("error");
    return;
  }
  const exchange = await exchangeChatgptAuthorizationCode({ code, redirectUri, clientId, verifier: tx.verifier });
  if (!exchange) {
    fail("error");
    return;
  }
  // §2: a valid ID token alone does not authorize plan usage — verify the
  // token (iss/aud/exp/iat/nonce/sub via jose + remote JWKS), then gate on
  // the granted scopes before anything is stored.
  const sub = await verifyChatgptIdToken(exchange.idToken, tx.nonce, clientId);
  if (!sub) {
    fail("error");
    return;
  }
  if (!exchange.scopes.split(/\s+/).includes(CHATGPT_PLAN_USAGE_SCOPE)) {
    fail("plan_not_enabled");
    return;
  }
  const model = await fetchChatgptDefaultModel(exchange.accessToken);
  if (!model) {
    fail("error");
    return;
  }
  await upsertChatgptConnection(
    seller.id,
    {
      accessToken: exchange.accessToken,
      refreshToken: exchange.refreshToken,
      idToken: exchange.idToken,
      scopes: exchange.scopes,
      accessExpiresAt: exchange.accessExpiresAt,
      earliestRefreshAt: exchange.earliestRefreshAt,
      sub,
    },
    model,
  );
  res.clearCookie(CHATGPT_TX_COOKIE, chatgptTxCookieClearOptions());
  res.redirect(302, "/login.html?chatgpt=connected");
}));

api.delete("/me/chatgpt", asyncHandler(async (req: Request, res: Response) => {
  if (!chatgptOauthEnabled()) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to manage your ChatGPT connection." });
    return;
  }
  // Best-effort revocation FIRST (§3.2): the row is deleted either way — a
  // stored-but-revoked pair is worthless. An unreadable bundle (master key
  // rotated/lost, tamper) or an unconfirmed revoke still deletes and flags
  // revocation_unconfirmed so the UI can tell the seller to also remove the
  // app in ChatGPT settings. No row ⇒ no revoke attempt, no flag.
  let revocationUnconfirmed = false;
  try {
    const refreshToken = await getChatgptRefreshToken(seller.id);
    if (refreshToken) {
      const clientId = envValue("CHATGPT_OAUTH_CLIENT_ID");
      revocationUnconfirmed = !clientId || !(await revokeChatgptRefreshToken(refreshToken, clientId));
    }
  } catch {
    revocationUnconfirmed = true;
  }
  await deleteChatgptConnection(seller.id);
  res.clearCookie(CHATGPT_TX_COOKIE, chatgptTxCookieClearOptions());
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, ...(revocationUnconfirmed ? { revocation_unconfirmed: true } : {}) });
}));

// --- item images (browser upload) -------------------------------------------

// Raw body for image uploads: express.raw with the image content types only.
const imageUpload = express.raw({ type: ["image/jpeg", "image/png", "image/webp", "image/gif"], limit: MAX_IMAGE_BYTES + 64 * 1024 });

// THI-140 (THI-123 obs 2): pre-auth IP gate for the upload route. Mounted
// BEFORE the express.raw buffer so an unauthenticated flood is answered 429
// before the per-request session lookup and before up to ~5 MB of in-memory
// body buffering per request. Sync by design — awaiting anything here would
// reintroduce the cost this gate exists to avoid. Coarser than the seller
// bucket (clients behind one NAT share it) and deliberately generous (4× the
// per-seller cap): it bounds anonymous flood cost, while legitimate
// per-seller use stays governed by imageUploadLimiter.
function imageUploadIpGate(req: Request, res: Response, next: NextFunction): void {
  if (!imageUploadIpLimiter.allow(`ip:${clientIp(req)}`)) {
    // THI-144: the gate is pre-auth, so the flood is anonymous — the event
    // carries the IP (the only attribution available), never a body.
    logSecurityEvent({ type: "rate_limit", route: "/api/items/:id/images" }, { ip: clientIp(req) });
    res.status(429).json({ error: "Too many uploads — try again later." });
    return;
  }
  next();
}

api.post("/items/:id/images", imageUploadIpGate, imageUpload, asyncHandler(async (req: Request, res: Response) => {
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to add photos." });
    return;
  }
  // THI-110 (H3): the upload route is authenticated, so key the bucket by
  // seller, not IP (IP attribution was the H1 bug; seller keys are exact).
  if (!imageUploadLimiter.allow(`seller:${seller.id}`)) {
    // THI-144: same convention as the auth-surface limiters (THI-112) — a
    // bounded-but-silent reject is a logging/monitoring failure.
    logSecurityEvent({ type: "rate_limit", route: "/api/items/:id/images" }, { sellerId: seller.id });
    res.status(429).json({ error: "Too many uploads — try again later." });
    return;
  }
  const mediaType = (req.headers["content-type"] ?? "").split(";")[0].trim();
  const data = req.body as Buffer;
  // THI-140 (THI-123 obs 1): a non-image Content-Type (e.g. application/json
  // under the express.json limit) reaches the handler with req.body already a
  // parsed object, not bytes — the length checks below would slide past it on
  // `undefined`. Guard structurally: only a raw Buffer body proceeds to
  // addItemImage; any other body shape is a client error (400), never a
  // validator fault (500).
  if (!Buffer.isBuffer(data)) {
    res.status(400).json({ error: "Send the image bytes as the raw request body with an image Content-Type." });
    return;
  }
  if (data.length === 0) {
    res.status(400).json({ error: "Empty upload — send the image bytes as the request body." });
    return;
  }
  const result = await addItemImage(seller.id, req.params.id, data, mediaType);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ url: result.url });
}));

// THI-308 PR 4 (spec rev 2, Security THI-314 F4–F7): owner-side photo
// mutation — delete one member of items.images and reorder the array. The
// images array is the source of truth; files on disk are best-effort
// residue. Mutations draw from their own limiter bucket (F6) so delete /
// reorder churn can never eat a seller's upload quota — every 429 is logged
// per the THI-144 convention.

const SERVER_IMAGE_PREFIX = "/img/items/"; // storage-managed members; everything else is an external URL

/** F4: the only string that may ever reach path.join below. Generated names
 *  are `{itemId}-{base36}.{ext}`, so `[\w.-]` covers every stored file; the
 *  explicit basename/separator checks are belt-and-braces on top (spec asks
 *  for `path.basename(filename) !== filename` rejection). Express decodes
 *  path params AFTER routing, so an encoded `..%2F` arrives here as "../"
 *  and dies at this gate — 400 with a fixed string, no echo (F7). */
function validStoredFilename(filename: string): boolean {
  return (
    filename.length > 0 &&
    filename.length <= 300 &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    filename !== "." &&
    filename !== ".." &&
    path.basename(filename) === filename &&
    /^[\w.-]+$/.test(filename)
  );
}

api.delete("/items/:id/images/:filename", asyncHandler(async (req: Request, res: Response) => {
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to manage photos." });
    return;
  }
  if (!imageMutationLimiter.allow(`seller:${seller.id}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/items/:id/images/:filename" }, { sellerId: seller.id });
    res.status(429).json({ error: "Too many photo changes — try again later." });
    return;
  }
  // F4-secondary: an external-URL member is removable too — it is matched
  // exactly against images[] and never touches the filesystem. Anything else
  // is a stored filename and must pass the traversal gate first.
  const raw = req.params.filename;
  let member: string;
  if (/^https?:\/\//i.test(raw)) {
    member = raw;
  } else {
    if (!validStoredFilename(raw)) {
      res.status(400).json({ error: "Invalid photo reference." });
      return;
    }
    member = `${SERVER_IMAGE_PREFIX}${raw}`;
  }
  // F5: one atomic statement — membership, ownership and the removal are a
  // single row update, so a photo appended concurrently with this delete is
  // removed-none-of (array_remove only drops the matched member) and can
  // never be lost to a read-modify-write race. Zero rows means: no such
  // item, not this seller's, or not a member — all three answer the same
  // unified 404 (F7: no enumeration oracle, fixed string, no echo).
  const removed = await pool.query<{ images: string[]; photo_required: boolean }>(
    `UPDATE items SET images = array_remove(images, $2)
     WHERE id = $1 AND seller_id = $3 AND $2 = ANY(images)
     RETURNING images, photo_required`,
    [req.params.id, member, seller.id],
  );
  if (removed.rows.length === 0) {
    res.status(404).json({ error: "Item not found or not owned by this seller." });
    return;
  }
  const { images, photo_required } = removed.rows[0];
  // F4: unlink only a server-stored file of THIS item, only after the row
  // update committed. The array is the source of truth — a failed unlink is a
  // logged warning and the request still succeeds (F7).
  if (member.startsWith(`${SERVER_IMAGE_PREFIX}${req.params.id}-`)) {
    const stored = member.slice(SERVER_IMAGE_PREFIX.length);
    await unlink(path.join(uploadsDir(), "items", stored)).catch((err: unknown) => {
      console.warn(`[images] best-effort unlink of stored photo failed: ${(err as Error).message}`);
    });
  }
  const visible = !photo_required || images.length > 0;
  res.set("Cache-Control", "no-store");
  res.json({
    images,
    visible,
    // Deleting the last photo of a photo_required listing returns it to
    // pending — hidden from every feed until a photo lands again.
    ...(photo_required && images.length === 0
      ? { warning: "This listing is hidden from search until you add a photo." }
      : {}),
  });
}));

const imageOrderSchema = z.object({
  images: z.array(z.string().min(1).max(500)).max(MAX_IMAGES_PER_ITEM), // array ≤ 12, short elements; the 256 kb JSON body cap already bounds the request
});

api.put("/items/:id/images/order", asyncHandler(async (req: Request, res: Response) => {
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to manage photos." });
    return;
  }
  if (!imageMutationLimiter.allow(`seller:${seller.id}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/items/:id/images/order" }, { sellerId: seller.id });
    res.status(429).json({ error: "Too many photo changes — try again later." });
    return;
  }
  const parsed = imageOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: `Send images as an array of up to ${MAX_IMAGES_PER_ITEM} photo references.` });
    return;
  }
  const next = parsed.data.images;
  const current = await pool.query<{ images: string[] }>(
    "SELECT images FROM items WHERE id = $1 AND seller_id = $2",
    [req.params.id, seller.id],
  );
  if (current.rows.length === 0) {
    res.status(404).json({ error: "Item not found or not owned by this seller." });
    return;
  }
  const cur = current.rows[0].images ?? [];
  // Exact permutation: same length and same multiset (order is the only
  // degree of freedom). Partial sets, duplicates and foreign references are
  // 400 — reorder can never smuggle an add or a delete past this gate.
  const sortedCur = [...cur].sort();
  const sortedNext = [...next].sort();
  if (sortedCur.length !== sortedNext.length || sortedCur.some((v, i) => v !== sortedNext[i])) {
    res.status(400).json({ error: "Photos must be the exact same set as the current ones." });
    return;
  }
  // F5 optimistic-concurrency guard: the write lands only against the exact
  // array the permutation was validated against. A concurrent append, delete
  // or reorder that slipped in between flips the WHERE to zero rows → 409
  // with a re-read. Replay-safe by construction: the same body twice still
  // matches (images is already $next), so the second call is a 200 no-op.
  const updated = await pool.query<{ images: string[] }>(
    "UPDATE items SET images = $3 WHERE id = $1 AND seller_id = $2 AND images = $4 RETURNING images",
    [req.params.id, seller.id, next, cur],
  );
  if (updated.rows.length === 0) {
    const reread = await pool.query<{ images: string[] }>(
      "SELECT images FROM items WHERE id = $1 AND seller_id = $2",
      [req.params.id, seller.id],
    );
    res.set("Cache-Control", "no-store");
    res.status(409).json({ error: "Photos changed since the page loaded — showing the current set.", images: reread.rows[0]?.images ?? [] });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json({ images: updated.rows[0].images });
}));

// --- wanted listings, browser CRUD (spec THI-439 §6.3 — protected path) ------
// Session-authed browser surface for the funnel form + my-wanted management
// (public/wanted.js). Every body routes through src/wanted.ts only — caps,
// quota, scrub and events are the module's, never bypassed (same layering
// note as THI-360 §5). 20 writes/hour per seller; 429s log rate_limit events
// (THI-144 convention). Field shapes and the limiter live in
// src/wanted-writes.ts, shared with the MCP tools.

const wantedEditSchema = z.object(wantedEditShape);

/** Session seller or 401 — the wanted surface is login-first (the /wanted
 *  board is public; writes are not). */
async function wantedSeller(req: Request, res: Response): Promise<{ id: string } | null> {
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to manage your wanted listings." });
    return null;
  }
  return seller;
}

/** Wanted-module error → response. Same mapping for every write route. */
function wantedErrorResponse(e: unknown, res: Response): void {
  if (e instanceof WantedLimitError) {
    res.status(429).json({ error: e.message });
    return;
  }
  if (e instanceof ContactInfoError) {
    // The message is the generic contactInfoMessage — never echoes which
    // rule tripped, so it cannot be used as an oracle to evade the scrub.
    res.status(400).json({ error: e.message });
    return;
  }
  if (e instanceof WantedValidationError) {
    res.status(400).json({ error: e.message });
    return;
  }
  if (e instanceof WantedNotFoundError) {
    res.status(404).json({ error: "Wanted listing not found." });
    return;
  }
  throw e; // unknown: the terminal error middleware owns it
}

api.post("/wanted", asyncHandler(async (req: Request, res: Response) => {
  const seller = await wantedSeller(req, res);
  if (!seller) return;
  if (!wantedWriteLimiter.allow(`seller:${seller.id}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/wanted" }, { sellerId: seller.id });
    res.status(429).json({ error: "Too many wanted-listing changes. Try again later." });
    return;
  }
  const parsed = wantedCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid wanted listing." });
    return;
  }
  let created;
  try {
    created = await createWantedWithAlert(seller.id, parsed.data);
  } catch (e) {
    wantedErrorResponse(e, res);
    return;
  }
  res.set("Cache-Control", "no-store");
  res.status(201).json({ wanted: wantedToPublic(created.wanted), alert_saved: created.alertSaved });
}));

api.get("/wanted/mine", asyncHandler(async (req: Request, res: Response) => {
  const seller = await wantedSeller(req, res);
  if (!seller) return;
  const { wanteds } = await listMyWanted(seller.id);
  res.set("Cache-Control", "no-store");
  // Raw field shape (not wantedToPublic): the management UI edits
  // budget_min_cents/budget_max_cents directly. embedding is never selected
  // (R4 discipline); buyer_id IS selected by the shared row query and
  // stripped in the destructure below — the strip, not the SELECT, is the
  // invariant (THI-453 N1: comments must state it as it is).
  res.json({
    wanteds: wanteds.map(({ buyer_id: _b, embedding: _e, ...w }) => ({
      ...w,
      budget: w.budget_min_cents !== null || w.budget_max_cents !== null
        ? { min_cents: w.budget_min_cents, max_cents: w.budget_max_cents, currency: w.currency }
        : null,
      days_left: Math.max(0, Math.ceil((w.expires_at.getTime() - Date.now()) / 86_400_000)),
    })),
  });
}));

api.put("/wanted/:id", asyncHandler(async (req: Request, res: Response) => {
  const seller = await wantedSeller(req, res);
  if (!seller) return;
  if (!wantedWriteLimiter.allow(`seller:${seller.id}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/wanted/:id" }, { sellerId: seller.id });
    res.status(429).json({ error: "Too many wanted-listing changes. Try again later." });
    return;
  }
  const parsed = wantedEditSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid changes." });
    return;
  }
  const fields = { ...parsed.data };
  try {
    const row = await updateWanted(req.params.id, seller.id, { fields });
    res.set("Cache-Control", "no-store");
    res.json({ wanted: wantedToPublic(row) });
  } catch (e) {
    wantedErrorResponse(e, res);
  }
}));

api.post("/wanted/:id/expire", asyncHandler(async (req: Request, res: Response) => {
  const seller = await wantedSeller(req, res);
  if (!seller) return;
  if (!wantedWriteLimiter.allow(`seller:${seller.id}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/wanted/:id/expire" }, { sellerId: seller.id });
    res.status(429).json({ error: "Too many wanted-listing changes. Try again later." });
    return;
  }
  try {
    const row = await updateWanted(req.params.id, seller.id, { expire: true });
    res.set("Cache-Control", "no-store");
    res.json({ wanted: wantedToPublic(row) });
  } catch (e) {
    wantedErrorResponse(e, res);
  }
}));

api.post("/wanted/:id/renew", asyncHandler(async (req: Request, res: Response) => {
  const seller = await wantedSeller(req, res);
  if (!seller) return;
  if (!wantedWriteLimiter.allow(`seller:${seller.id}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/wanted/:id/renew" }, { sellerId: seller.id });
    res.status(429).json({ error: "Too many wanted-listing changes. Try again later." });
    return;
  }
  try {
    const row = await updateWanted(req.params.id, seller.id, { renew: true });
    res.set("Cache-Control", "no-store");
    res.json({ wanted: wantedToPublic(row) });
  } catch (e) {
    wantedErrorResponse(e, res);
  }
}));

// --- chat -------------------------------------------------------------------

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(24)
    .default([]),
});

// No inner try/catch → next(e): asyncHandler forwards rejections to the
// terminal middleware — one idiom everywhere (THI-59, spec THI-58 D1).

/** THI-193 §3.4 resolution order (rev fa3288ff; extends THI-197): user
 *  OAuth → user key → company (null). OAuth wins when the flag is on and a
 *  row resolves a fresh plan-scoped token — expired ones refresh HERE,
 *  before the turn; terminal refresh errors already deleted the row (PR-1)
 *  and fall through. Resolvers return null for fail-closed states and
 *  throw only on tamper — logged as a fixed slug, still falling through.
 *  No mid-turn switching (THI-197 posture). */
async function resolveByoCredential(sellerId: string): Promise<ResolvedLlmCredential | null> {
  try {
    const oauth = await resolveChatgptCredential(sellerId);
    if (oauth) return oauth;
  } catch {
    logSecurityEvent({ type: "byo_credential_error", route: "/api/chat" }, { sellerId });
  }
  try {
    return await resolveLlmCredential(sellerId);
  } catch {
    logSecurityEvent({ type: "byo_credential_error", route: "/api/chat" }, { sellerId });
    return null;
  }
}

api.post("/chat", asyncHandler(async (req: Request, res: Response) => {
  const seller = await sellerFromSession(req).catch(() => null);
  const limiter = seller ? chatAuthedLimiter : chatAnonLimiter;
  const key = seller ? `seller:${seller.id}` : `ip:${clientIp(req)}`;
  if (!limiter.allow(key)) {
    // THI-180 N3: chat 429s were the only ones without a rate_limit line
    // (THI-144 convention) — attribution matches the limiter key.
    logSecurityEvent({ type: "rate_limit", route: "/api/chat" }, seller ? { sellerId: seller.id } : { ip: clientIp(req) });
    res.status(429).json({
      error: seller
        ? "Chat limit reached for this hour."
        : "Anonymous chat limit reached — create an account (free) to keep going.",
    });
    return;
  }
  if (!chatConfigured()) {
    res.status(503).json({
      error: "Chat is not configured on this server yet. The MCP endpoint at /mcp works as usual.",
    });
    return;
  }
  // THI-197/THI-193 §3.4: resolve the credential BEFORE the budget gate —
  // user-billed turns (OAuth plan token or user key) bypass the company
  // daily budget; rate limits and per-call caps stay on ALL turns. Order:
  // limiter → configured → credential (OAuth → key → company) → budget
  // (company turns only) → zod parse.
  const byo = seller ? await resolveByoCredential(seller.id) : null;
  if (byo === null && dailyTokenBudget.isExhausted()) {
    logSecurityEvent({ type: "rate_limit", route: "/api/chat" }, seller ? { sellerId: seller.id } : { ip: clientIp(req) });
    res.status(429).json({ error: "Daily chat budget exhausted — please try again tomorrow." });
    return;
  }
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Message required (max 4000 characters)." });
    return;
  }
  const { usage, ...reply } = await chatTurn(parsed.data.history as ChatMessage[], parsed.data.message, seller, byo);
  if (usage) {
    // One usage line per LLM-backed turn (numbers + slugs only — no message
    // content, H4.2). Confirm/decline fast paths emit none. THI-197: every
    // LLM-backed turn is labeled — including user-key turns (Architect
    // reconciliation: labeling supersedes the earlier no-line comment;
    // Phase 3 per-user usage reuses these lines). `model` is the model the
    // turn actually ran on (credential ?? env, never request data);
    // daily_total/budget keep reporting the company meter (unchanged by
    // user-key turns).
    logSecurityEvent(
      {
        type: "chat_usage",
        model: usage.model,
        credential_source: usage.credentialSource,
        provider: usage.provider,
        rounds: usage.rounds,
        tokens_in: usage.tokensIn,
        tokens_out: usage.tokensOut,
        daily_total: dailyTokenBudget.used(),
        budget: chatLimits.dailyTokenBudget,
        usage_source: usage.source,
      },
      seller ? { sellerId: seller.id } : { ip: clientIp(req) },
    );
  }
  res.json({ reply }); // byte-identical to the pre-THI-180 shape — no usage key leaks
}));

// --- admin: dispute resolution (spec THI-3 §4.3, PR-9) ----------------------

/** F7: timing-safe Bearer compare — length-check first, then constant-time
 * equal (auth.ts verifyPassword pattern; kept local so auth.ts is untouched). */
function adminKeyMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const resolveDisputeSchema = z.object({
  outcome: z.enum(["refund", "release"]),
  note: z.string().min(1).max(500),
});

const ADMIN = { type: "admin" as const };

/** §6.6 refund-after-transfer: reverse the transfer (full, idempotent per
 * order), then refund the charge from the platform balance; alert the
 * operator to any shortfall — never silently drop funds. */
async function refundAfterTransfer(order: OrderRow): Promise<{ refundId: string | null }> {
  const stripe = getStripe();
  if (!stripe) throw new Error("payments_not_configured");
  if (order.transfer_id && !order.refund_id) {
    await stripe.transfers
      .createReversal(order.transfer_id, {}, { idempotencyKey: `reversal:${order.id}` })
      .catch((err: unknown) => console.error(`[admin] reversal of ${order.transfer_id} failed (${(err as Error).message}) — refund continues from platform balance`));
    console.error(
      `[admin] operator alert: order ${order.id} refunded after transfer ${order.transfer_id} — ` +
        `platform-balance shortfall possible (transfer ${order.transfer_id} reversed; reserve policy §6.4)`,
    );
  }
  if (order.refund_id) return { refundId: null }; // refund already in flight — reconcile, never duplicate (F3)
  const refund = await createRefundForOrder(order, order.payment_intent_id!, stripe);
  // THI-70 A1(a): persist refund_id BEFORE the transition. If admin_refund
  // loses a cross-outcome race (admin_release won the status CAS meanwhile),
  // the refund stays visible on the row instead of orphaning at Stripe —
  // sweep rules 7/9 key on non-terminal statuses, so the row is the only
  // record a terminal paid_out would carry.
  await pool.query("UPDATE orders SET refund_id = $2 WHERE id = $1 AND refund_id IS NULL", [order.id, refund.id]);
  return { refundId: refund.id };
}

/** #19 release: reconcile-don't-recreate (F3) — an existing transfer is
 * retrieved, not re-created; paid → #20 lands immediately, in flight → the
 * order waits for its own transfer event. */
async function releaseWithReconcile(order: OrderRow): Promise<void> {
  if (order.payment_mode !== "stripe") return;
  if (order.transfer_id) {
    const transfer = await retrieveTransfer(order.transfer_id);
    if (transfer && !transfer.amount_reversed) {
      // Already landed: complete the payout now instead of waiting for a
      // possibly-lost transfer event (rule 6 recovers it otherwise).
      const landed = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
      if (landed.rows[0]?.status === "payout_pending") {
        await applyTransition({ orderId: order.id, trigger: "transfer_paid", actor: { type: "stripe", id: order.transfer_id } });
      }
    }
    return;
  }
  const stripe = getStripe();
  if (!stripe) throw new Error("payments_not_configured");
  const dest = await pool.query<{ stripe_account_id: string | null }>(
    "SELECT stripe_account_id FROM sellers WHERE id = $1",
    [order.seller_id],
  );
  const destination = dest.rows[0]?.stripe_account_id;
  if (!destination) throw new Error("inconsistent_state: seller payout account missing");
  const transfer = await createTransferForOrder(order, destination, stripe);
  await pool.query("UPDATE orders SET transfer_id = $2 WHERE id = $1", [order.id, transfer.id]);
}

/** Shared dispute-resolution core (spec admin-dispute-ui.md, THI-569 PR-C):
 *  one code path, two transports — the JSON endpoint (Bearer key, scripts)
 *  and the admin form POST (session + CSRF, humans). Returns a typed result;
 *  callers own status codes and response shape per transport. */
interface ResolveCoreOk {
  kind: "ok";
  order: OrderRow; // post-resolution row (status, refund_id, transfer_id)
}
interface ResolveCoreNotFound {
  kind: "not_found";
}
interface ResolveCoreConflict {
  kind: "conflict";
  message: string;
}
type ResolveCoreResult = ResolveCoreOk | ResolveCoreNotFound | ResolveCoreConflict;

async function resolveDisputeCore(
  orderId: string,
  outcome: "refund" | "release",
  note: string,
): Promise<ResolveCoreResult> {
  // Malformed ids must 404 (no uuid parse error, no oracle).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    return { kind: "not_found" };
  }
  const { rows } = await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [orderId]);
  const order = rows[0];
  if (!order) {
    return { kind: "not_found" };
  }
  if (order.status !== "disputed") {
    return { kind: "conflict", message: `Order is ${order.status}; only disputed orders can be resolved.` };
  }
  try {
    if (outcome === "refund") {
      const refundId =
        order.payment_mode === "stripe" && order.payment_intent_id
          ? (await refundAfterTransfer(order)).refundId
          : null; // null → refund already in flight (reconcile) or off_platform
      await applyTransition({ orderId: order.id, trigger: "admin_refund", actor: ADMIN, reason: note, ...(refundId ? { sets: { refund_id: refundId } } : {}) });
    } else {
      await applyTransition({ orderId: order.id, trigger: "admin_release", actor: ADMIN, reason: note });
      await releaseWithReconcile(order);
    }
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      return { kind: "conflict", message: err.message };
    }
    throw err;
  }
  const after = (await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [order.id])).rows[0];
  return { kind: "ok", order: after };
}

api.post("/admin/orders/:id/resolve-dispute", asyncHandler(async (req: Request, res: Response) => {
  // F1/F7: boot validation disables the route entirely when the key is unset
  // or short — a disabled admin surface is indistinguishable from absent.
  const cfg = orderFlowConfig();
  if (!cfg.adminRouteEnabled) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  if (!adminAttemptLimiter.allow(`ip:${clientIp(req)}`)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  const header = req.get("Authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
  // A2 (THI-70): read through envValue — trimmed, empty=unset — so the auth
  // compare sees exactly what the adminRouteEnabled gate validated at boot.
  // Raw process.env here made a whitespace-padded key enable the route while
  // every request 401s (fail-closed, availability-only).
  if (!adminKeyMatches(presented, envValue("ADMIN_API_KEY"))) {
    res.status(401).json({ error: "Not authorized." });
    return;
  }
  const parsed = resolveDisputeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "outcome (refund|release) and note (1-500 chars) required." });
    return;
  }
  const result = await resolveDisputeCore(String(req.params.id), parsed.data.outcome, parsed.data.note);
  if (result.kind === "not_found") {
    res.status(404).json({ error: "Order not found." });
    return;
  }
  if (result.kind === "conflict") {
    res.status(409).json({ error: result.message });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json({ order_id: result.order.id, status: result.order.status, refund_id: result.order.refund_id, transfer_id: result.order.transfer_id });
}));

// --- admin UI: session, login/logout, CSRF (spec docs/specs/admin-dispute-ui.md,
// THI-562 work item 3, PR-A) ----------------------------------------------
//
// Session, not per-request key: the operator submits the admin key once at
// POST /admin/login; on timing-safe match the server sets an HMAC cookie
// `admin_session = exp + "." + HMAC_SHA256(SESSION_SECRET, "admin|" + exp)` —
// httpOnly, Secure, SameSite=Strict, 8h TTL. The JSON endpoint above keeps
// its Bearer-key auth unchanged (scripts keep working).
//
// CSRF (PR-C uses it for the resolve form): token = HMAC_SHA256(
// SESSION_SECRET, "csrf|" + exp) — bound to the session by the shared exp,
// not derivable from the session cookie without SESSION_SECRET. SameSite=
// Strict is defense-in-depth, not the control.
//
// Fail-closed boot gate: adminUiEnabled (config.ts) = ADMIN_API_KEY ≥32 chars
// AND an explicit SESSION_SECRET ≥32 chars. Key unset/short or secret
// unset/short ⇒ every /admin route 404s, login included — a disabled admin
// surface is indistinguishable from an absent one.

const ADMIN_SESSION_COOKIE = "admin_session";
const ADMIN_SESSION_TTL_S = 8 * 3600; // 8-hour session (spec)

/** THI-566 minor: constant-time compares everywhere a secret is checked —
 * the adminKeyMatches pattern, reused for both HMACs. */
function hmacMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function adminSessionMac(exp: number): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(`admin|${exp}`).digest("base64url");
}

function adminCsrfMac(exp: number): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(`csrf|${exp}`).digest("base64url");
}

export interface AdminSession {
  /** Expiry, unix seconds — the session and its CSRF token share it. */
  exp: number;
}

/** Signs a fresh admin session. `nowMs` injectable for tests. */
export function signAdminSession(nowMs = Date.now()): AdminSession & { cookie: string; csrf: string } {
  const exp = Math.floor(nowMs / 1000) + ADMIN_SESSION_TTL_S;
  return { exp, cookie: `${exp}.${adminSessionMac(exp)}`, csrf: adminCsrfMac(exp) };
}

/** Structure + expiry + constant-time MAC check for a cookie value. */
export function verifyAdminSession(cookieValue: string | undefined, nowMs = Date.now()): AdminSession | null {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const exp = Number(cookieValue.slice(0, dot));
  if (!Number.isInteger(exp) || exp <= Math.floor(nowMs / 1000)) return null; // expired or malformed
  return hmacMatches(cookieValue.slice(dot + 1), adminSessionMac(exp)) ? { exp } : null;
}

/** CSRF check for a form-submitted token against the authenticated session. */
export function adminCsrfMatches(presented: string | undefined, session: AdminSession): boolean {
  return hmacMatches(presented, adminCsrfMac(session.exp));
}

function readAdminCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === ADMIN_SESSION_COOKIE) return rest.join("=");
  }
  return undefined;
}

const adminCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  maxAge: ADMIN_SESSION_TTL_S * 1000,
  path: "/admin",
};

/** B1 (THI-566, required amendment): the strict 10/IP/hr adminAttemptLimiter
 * meters only the sensitive POSTs (login, resolve, reveal) — browsing pages
 * gets this separate, higher limit so an operator working a dispute queue
 * never eats the brute-force bucket (the insecure path must not become the
 * easy path). */
export const adminPageLimiter = new RateLimiter(300, 60 * 60_000); // 300 admin page GETs per IP per hour

/** Uniform, admin-agnostic 404 page — used by every /admin route whenever the
 * boot gate is closed, so a disabled surface is indistinguishable from an
 * absent one (same discipline as the JSON endpoint above). */
function adminNotFound(res: Response): void {
  res.status(404).set("Cache-Control", "no-store").type("html").send(
    page("Not found — Thingery", "Page not found", `<h1>Not found</h1><p class="meta">This page does not exist.</p>`),
  );
}

/** Boot gate for every admin UI route. Returns false after responding. */
function adminUiGate(res: Response): boolean {
  if (orderFlowConfig().adminUiEnabled) return true;
  adminNotFound(res);
  return false;
}

/** Session gate: every /admin page and action requires a valid cookie;
 * failures redirect to the login page (spec). Returns the session, or null
 * after redirecting. */
function requireAdminSession(req: Request, res: Response): AdminSession | null {
  const session = verifyAdminSession(readAdminCookie(req));
  if (session) return session;
  res.redirect(303, "/admin/login");
  return null;
}

function adminLoginPage(res: Response, error?: string): void {
  // B3: no-store on every admin page; OQ1 (THI-566): unlinked + noindex.
  res.set("Cache-Control", "no-store");
  const body = `
  <h1>Admin login</h1>
  ${error ? `<p class="banner-warn" role="alert">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/admin/login">
    <p><label for="key">Admin key</label><br>
    <input type="password" id="key" name="key" autocomplete="off" autofocus required></p>
    <button type="submit">Sign in</button>
  </form>`;
  res.status(error ? 401 : 200).type("html").send(page("Admin login — Thingery", "Admin login", body, undefined, true));
}

export const adminPages = express.Router();

adminPages.get("/admin", (req, res) => {
  if (!adminUiGate(res)) return;
  if (!adminPageLimiter.allow(`ip:${clientIp(req)}`)) {
    res.status(429).type("html").send(page("Too many requests — Thingery", "Too many requests", `<h1>Too many requests</h1><p class="meta">Try again later.</p>`));
    return;
  }
  res.redirect(301, "/admin/disputes");
});

adminPages.get("/admin/login", (req, res) => {
  if (!adminUiGate(res)) return;
  if (!adminPageLimiter.allow(`ip:${clientIp(req)}`)) {
    res.status(429).type("html").send(page("Too many requests — Thingery", "Too many requests", `<h1>Too many requests</h1><p class="meta">Try again later.</p>`));
    return;
  }
  if (verifyAdminSession(readAdminCookie(req))) {
    res.redirect(303, "/admin/disputes");
    return;
  }
  adminLoginPage(res);
});

adminPages.post("/admin/login", asyncHandler(async (req: Request, res: Response) => {
  if (!adminUiGate(res)) return;
  // Spec: the existing attempt limiter covers brute force — a login POST
  // consumes the same strict 10/IP/hr bucket as the JSON endpoint (B1).
  if (!adminAttemptLimiter.allow(`ip:${clientIp(req)}`)) {
    logSecurityEvent({ type: "admin_login", outcome: "denied" }, { ip: clientIp(req) });
    res.status(429).type("html").send(page("Too many attempts — Thingery", "Too many attempts", `<h1>Too many attempts</h1><p class="meta">Try again later.</p>`));
    return;
  }
  const presented = typeof req.body?.key === "string" ? req.body.key.trim() : undefined;
  // Same timing-safe compare + envValue read as the JSON endpoint (A2).
  if (!adminKeyMatches(presented, envValue("ADMIN_API_KEY"))) {
    logSecurityEvent({ type: "admin_login", outcome: "denied" }, { ip: clientIp(req) });
    adminLoginPage(res, "That key is not valid.");
    return;
  }
  logSecurityEvent({ type: "admin_login", outcome: "ok" }, { ip: clientIp(req) });
  res.cookie(ADMIN_SESSION_COOKIE, signAdminSession().cookie, adminCookieOptions);
  res.redirect(303, "/admin/disputes");
}));

adminPages.post("/admin/logout", (req, res) => {
  if (!adminUiGate(res)) return;
  const session = requireAdminSession(req, res);
  if (!session) return;
  const token = typeof req.body?.csrf === "string" ? req.body.csrf : undefined;
  if (!adminCsrfMatches(token, session)) {
    res.status(400).type("html").send(page("Bad request — Thingery", "Bad request", `<h1>Bad request</h1><p class="meta">Invalid request.</p>`));
    return;
  }
  res.clearCookie(ADMIN_SESSION_COOKIE, { path: "/admin", httpOnly: true, secure: true, sameSite: "strict" });
  res.redirect(303, "/admin/login");
});

// --- admin UI: dispute list + detail pages (spec admin-dispute-ui.md, PR-B) ---

const ADMIN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_DISPUTE_LIST_CAP = 50; // OQ2: no pagination in v1 — cap + note

const fmtUtc = (value: Date | string): string =>
  `${new Date(value).toISOString().replace("T", " ").slice(0, 16)} UTC`;

const adminMoney = (cents: number, currency: string): string => `${(cents / 100).toFixed(2)} ${currency}`;

/** CSRF token for a live session (embedded in every admin form). */
function adminCsrfValue(session: AdminSession): string {
  return adminCsrfMac(session.exp);
}

/** Inline sign-out form for the admin page headers (POST + CSRF). */
function signOutForm(session: AdminSession): string {
  return `<form method="post" action="/admin/logout" style="display:inline"><input type="hidden" name="csrf" value="${escapeHtml(adminCsrfValue(session))}"><button type="submit">Sign out</button></form>`;
}

function admin429(res: Response): void {
  res.status(429).set("Cache-Control", "no-store").type("html").send(
    page("Too many requests — Thingery", "Too many requests", `<h1>Too many requests</h1><p class="meta">Try again later.</p>`),
  );
}

/** B2 (THI-566, required amendment): every interpolated field is contextually
 *  escaped via escapeHtml — item titles, handles, event reasons and message
 *  bodies are attacker-controlled and aggregate into this authenticated
 *  admin page (stored-XSS → admin session takeover class). The page()
 *  helper only; no raw interpolation anywhere below. */
function addressRowsHtml(addr: Record<string, unknown>, revealed: boolean): string {
  const row = (label: string, value: unknown) =>
    `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value ?? "")}</td></tr>`;
  const mask = "\u2022\u2022\u2022"; // ••• — full mask for identifying lines
  const lines: string[] = [
    row("Name", revealed ? addr.name : mask),
    row("Address line 1", revealed ? addr.line1 : mask),
    row("Address line 2", revealed ? addr.line2 || "" : addr.line2 ? mask : ""),
    // City + country stay visible masked-out: coarse context for adjudication
    // without identifying the street door.
    row("City", addr.city),
    row("Postal code", revealed ? addr.postal_code : mask),
    row("Country", addr.country),
  ];
  return `<table>${lines.join("")}</table>`;
}

interface DisputeListRow {
  id: string;
  price_cents: number;
  shipping_price_cents: number;
  currency: string;
  status_changed_at: Date;
  item_title: string;
  buyer_name: string;
  seller_name: string;
}

/** PRG (spec: no double-submit): after a successful form resolve the list
 *  renders a confirmation line for ?resolved=<orderId>. The value is a
 *  server-generated uuid echoed from the DB row, and is escaped anyway (B2). */
function resolvedNote(req: Request): string {
  const raw = typeof req.query.resolved === "string" ? req.query.resolved : "";
  return raw && ADMIN_UUID_RE.test(raw)
    ? `<p class="meta">Resolved order ${escapeHtml(raw.slice(0, 8))}… — it has left the dispute queue.</p>`
    : "";
}

adminPages.get("/admin/disputes", asyncHandler(async (req: Request, res: Response) => {
  if (!adminUiGate(res)) return;
  if (!adminPageLimiter.allow(`ip:${clientIp(req)}`)) {
    admin429(res);
    return;
  }
  const session = requireAdminSession(req, res);
  if (!session) return;
  // 51 fetched so the cap note appears exactly when more than 50 exist (OQ2).
  const { rows } = await pool.query<DisputeListRow>(
    `SELECT o.id, o.price_cents, o.shipping_price_cents, o.currency, o.status_changed_at,
            i.title AS item_title,
            buyer.display_name AS buyer_name, seller.display_name AS seller_name
     FROM orders o
     JOIN items i ON i.id = o.item_id
     JOIN sellers buyer ON buyer.id = o.buyer_id
     JOIN sellers seller ON seller.id = o.seller_id
     WHERE o.status = 'disputed'
     ORDER BY o.status_changed_at DESC
     LIMIT ${ADMIN_DISPUTE_LIST_CAP + 1}`,
  );
  const overflow = rows.length > ADMIN_DISPUTE_LIST_CAP;
  const list = overflow ? rows.slice(0, ADMIN_DISPUTE_LIST_CAP) : rows;
  const table = list
    .map(
      (o) => `<tr>
      <td><a href="/admin/disputes/${escapeHtml(o.id)}">${escapeHtml(o.id.slice(0, 8))}…</a></td>
      <td>${escapeHtml(o.item_title)}</td>
      <td>${escapeHtml(adminMoney(o.price_cents + o.shipping_price_cents, o.currency))}</td>
      <td>${escapeHtml(o.buyer_name)}</td>
      <td>${escapeHtml(o.seller_name)}</td>
      <td>${escapeHtml(fmtUtc(o.status_changed_at))}</td>
    </tr>`,
    )
    .join("\n");
  const body = `
  <p class="meta"><a href="/admin/disputes">Disputes</a> · <strong>Thingery admin</strong> · ${signOutForm(session)}</p>
  <h1>Disputed orders</h1>
  ${resolvedNote(req)}
  ${list.length === 0 ? `<p class="meta">No disputed orders right now.</p>` : `
  <table>
    <thead><tr><th>Order</th><th>Item</th><th>Total</th><th>Buyer</th><th>Seller</th><th>Disputed since</th></tr></thead>
    <tbody>${table}</tbody>
  </table>`}
  ${overflow ? `<p class="meta">More than ${ADMIN_DISPUTE_LIST_CAP} disputed orders — showing the ${ADMIN_DISPUTE_LIST_CAP} most recent.</p>` : ""}`;
  res.set("Cache-Control", "no-store").type("html").send(page("Disputed orders — Thingery admin", "Disputed orders", body, undefined, true));
}));

interface DisputeDetailRow extends OrderRow {
  item_title: string;
  buyer_name: string;
  seller_name: string;
}

interface OrderEventRow {
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: string;
  actor_id: string | null;
  reason: string | null;
  created_at: Date;
}

interface OrderMessageRow {
  body: string;
  sender_role: string;
  sender_name: string;
  created_at: Date;
}

/** Loads the order for the dispute workspace. Uniform 404 for malformed,
 * non-existent and non-disputed ids — this UI is a dispute workspace, not an
 * order browser (spec). Returns null after responding. */
async function loadDisputedOrderOr404(id: string, res: Response): Promise<DisputeDetailRow | null> {
  const order = await loadDisputedOrder(id);
  if (!order) {
    adminNotFound(res);
    return null;
  }
  return order;
}

/** Non-responding variant: null without touching the response (PR-C's 409
 *  re-render path falls back to an error page when the order left the
 *  disputed queue concurrently). */
async function loadDisputedOrder(id: string): Promise<DisputeDetailRow | null> {
  if (!ADMIN_UUID_RE.test(id)) {
    return null;
  }
  const { rows } = await pool.query<DisputeDetailRow>(
    `SELECT o.*, i.title AS item_title,
            buyer.display_name AS buyer_name, seller.display_name AS seller_name
     FROM orders o
     JOIN items i ON i.id = o.item_id
     JOIN sellers buyer ON buyer.id = o.buyer_id
     JOIN sellers seller ON seller.id = o.seller_id
     WHERE o.id = $1`,
    [id],
  );
  const order = rows[0];
  if (!order || order.status !== "disputed") {
    return null;
  }
  return order;
}

/** Order messages (THI-562 work item 1) are read-only evidence here. The
 *  table may not exist yet on a deployment that has not picked up work item
 *  1 — degrade to an absent section instead of a 500. */
async function loadOrderMessages(orderId: string): Promise<OrderMessageRow[]> {
  const exists = await pool.query<{ t: string | null }>("SELECT to_regclass('public.order_messages') AS t");
  if (!exists.rows[0]?.t) return [];
  const { rows } = await pool.query<OrderMessageRow>(
    `SELECT m.body, m.sender_role, s.display_name AS sender_name, m.created_at
     FROM order_messages m
     JOIN sellers s ON s.id = m.sender_id
     WHERE m.order_id = $1
     ORDER BY m.created_at ASC`,
    [orderId],
  );
  return rows;
}

async function renderDisputeDetail(
  res: Response,
  order: DisputeDetailRow,
  session: AdminSession,
  opts: { revealedAddress?: boolean; error?: string } = {},
): Promise<void> {
  const revealed = opts.revealedAddress === true;
  const events = (
    await pool.query<OrderEventRow>(
      `SELECT event_type, from_status, to_status, actor_type, actor_id, reason, created_at
       FROM order_events WHERE order_id = $1 ORDER BY created_at ASC, id ASC`,
      [order.id],
    )
  ).rows;
  const messages = await loadOrderMessages(order.id);

  const eventsHtml = events
    .map(
      (e) => `<tr>
      <td>${escapeHtml(fmtUtc(e.created_at))}</td>
      <td>${escapeHtml(e.event_type)}${e.from_status || e.to_status ? ` (${escapeHtml(e.from_status ?? "—")} → ${escapeHtml(e.to_status ?? "—")})` : ""}</td>
      <td>${escapeHtml(e.actor_type)}${e.actor_id ? `:${escapeHtml(e.actor_id)}` : ""}</td>
      <td>${escapeHtml(e.reason ?? "")}</td>
    </tr>`,
    )
    .join("\n");

  const messagesHtml =
    messages.length === 0
      ? ""
      : `<h2>Messages between the parties</h2>
  ${messages
    .map(
      (m) => `<div class="card">
    <p class="meta"><strong>${escapeHtml(m.sender_name)}</strong> (${escapeHtml(m.sender_role)}) · ${escapeHtml(fmtUtc(m.created_at))}</p>
    <p class="desc">${escapeHtml(m.body)}</p>
  </div>`,
    )
    .join("\n")}`;

  const body = `
  <p class="meta"><a href="/admin/disputes">← All disputes</a> · <strong>Thingery admin</strong> · ${signOutForm(session)}</p>
  <h1>Dispute — order ${escapeHtml(order.id.slice(0, 8))}…</h1>
  ${opts.error ? `<p class="price" style="color:#b00">${escapeHtml(opts.error)}</p>` : ""}
  <p class="meta">Item: <strong>${escapeHtml(order.item_title)}</strong> · Status: <span class="badge">${escapeHtml(order.status)}</span></p>
  <p class="meta">Buyer: <strong>${escapeHtml(order.buyer_name)}</strong> · Seller: <strong>${escapeHtml(order.seller_name)}</strong></p>
  <p class="price">${escapeHtml(adminMoney(order.price_cents + order.shipping_price_cents, order.currency))}
    <span class="meta">(${escapeHtml(adminMoney(order.price_cents, order.currency))} + ${escapeHtml(adminMoney(order.shipping_price_cents, order.currency))} shipping)</span></p>
  <p class="meta">Payment mode: <strong>${escapeHtml(order.payment_mode)}</strong>${order.payment_mode === "off_platform" ? " — off-platform: the parties settle payment themselves; resolving only sets the order status, no Stripe refund or payout is moved." : ""}</p>
  ${order.carrier || order.tracking_code ? `<p class="meta">Carrier: ${escapeHtml(order.carrier ?? "—")} · Tracking: ${escapeHtml(order.tracking_code ?? "—")}</p>` : ""}
  ${order.refund_id ? `<p class="meta">Stripe refund: ${escapeHtml(order.refund_id)}</p>` : ""}
  ${order.transfer_id ? `<p class="meta">Stripe transfer: ${escapeHtml(order.transfer_id)}</p>` : ""}

  <h2>Shipping address</h2>
  ${addressRowsHtml(order.shipping_address, revealed)}
  ${revealed
    ? `<p class="meta">Address revealed for this view — a fresh page load masks it again.</p>`
    : `<form method="post" action="/admin/disputes/${escapeHtml(order.id)}/reveal">
      <input type="hidden" name="csrf" value="${escapeHtml(adminCsrfValue(session))}">
      <button type="submit">Reveal address</button>
      <p class="meta">The address is masked by default; revealing it is logged.</p>
    </form>`}

  <h2>Order history</h2>
  <table>
    <thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Note</th></tr></thead>
    <tbody>${eventsHtml}</tbody>
  </table>

  ${messagesHtml}

  <h2>Resolve dispute</h2>
  ${opts.error ? `<p class="meta">${escapeHtml(opts.error)}</p>` : ""}
  <form method="post" action="/admin/disputes/${escapeHtml(order.id)}/resolve">
    <input type="hidden" name="csrf" value="${escapeHtml(adminCsrfValue(session))}">
    <p><label><input type="radio" name="outcome" value="refund" required> Refund buyer${order.payment_mode === "off_platform" ? " (status-only: no Stripe refund to move)" : ""}</label></p>
    <p><label><input type="radio" name="outcome" value="release"> Release to seller${order.payment_mode === "off_platform" ? " (status-only: no Stripe payout to move)" : ""}</label></p>
    <p><label>Decision note (1–500 chars — stored on the audit row)
      <textarea name="note" maxlength="500" required rows="3" cols="60"></textarea></label></p>
    <button type="submit">Resolve dispute</button>
  </form>`;
  res.set("Cache-Control", "no-store").type("html").send(
    page(`Dispute ${order.id.slice(0, 8)} — Thingery admin`, `Dispute workspace for order ${order.id}`, body, undefined, true),
  );
}

adminPages.get("/admin/disputes/:id", asyncHandler(async (req: Request, res: Response) => {
  if (!adminUiGate(res)) return;
  if (!adminPageLimiter.allow(`ip:${clientIp(req)}`)) {
    admin429(res);
    return;
  }
  const session = requireAdminSession(req, res);
  if (!session) return;
  const order = await loadDisputedOrderOr404(String(req.params.id ?? ""), res);
  if (!order) return;
  await renderDisputeDetail(res, order, session);
}));

adminPages.post("/admin/disputes/:id/reveal", asyncHandler(async (req: Request, res: Response) => {
  if (!adminUiGate(res)) return;
  // B1: reveal is a sensitive POST — strict limiter, not the page bucket.
  if (!adminAttemptLimiter.allow(`ip:${clientIp(req)}`)) {
    admin429(res);
    return;
  }
  const session = requireAdminSession(req, res);
  if (!session) return;
  const token = typeof req.body?.csrf === "string" ? req.body.csrf : undefined;
  if (!adminCsrfMatches(token, session)) {
    res.status(400).set("Cache-Control", "no-store").type("html").send(
      page("Bad request — Thingery", "Bad request", `<h1>Bad request</h1><p class="meta">Invalid request.</p>`),
    );
    return;
  }
  const order = await loadDisputedOrderOr404(String(req.params.id ?? ""), res);
  if (!order) return;
  // PII minimization audit: one line per reveal, order id only (never the
  // address). POST-response render keeps reveal stateless (THI-566 minor):
  // a fresh GET shows the masked view again.
  logSecurityEvent({ type: "admin_pii_reveal", orderId: order.id }, { ip: clientIp(req) });
  await renderDisputeDetail(res, order, session, { revealedAddress: true });
}));

adminPages.post("/admin/disputes/:id/resolve", asyncHandler(async (req: Request, res: Response) => {
  if (!adminUiGate(res)) return;
  // B1: resolve is a sensitive POST — strict limiter, not the page bucket.
  if (!adminAttemptLimiter.allow(`ip:${clientIp(req)}`)) {
    admin429(res);
    return;
  }
  const session = requireAdminSession(req, res);
  if (!session) return;
  const token = typeof req.body?.csrf === "string" ? req.body.csrf : undefined;
  if (!adminCsrfMatches(token, session)) {
    res.status(400).set("Cache-Control", "no-store").type("html").send(
      page("Bad request — Thingery", "Bad request", `<h1>Bad request</h1><p class="meta">Invalid request.</p>`),
    );
    return;
  }
  const parsed = resolveDisputeSchema.safeParse({ outcome: req.body?.outcome, note: req.body?.note });
  if (!parsed.success) {
    // Re-render the form with the field error (no state change yet).
    const order = await loadDisputedOrderOr404(String(req.params.id ?? ""), res);
    if (!order) return;
    await renderDisputeDetail(res, order, session, {
      error: "Pick an outcome (refund or release) and write a 1–500 char note.",
    });
    return;
  }
  const result = await resolveDisputeCore(String(req.params.id ?? ""), parsed.data.outcome, parsed.data.note);
  if (result.kind === "not_found") {
    adminNotFound(res);
    return;
  }
  if (result.kind === "conflict") {
    // 409-class: if the order is still disputed (race), re-render its detail
    // with the error; otherwise it has already left the queue — plain error page.
    const order = await loadDisputedOrder(String(req.params.id ?? ""));
    if (order) {
      await renderDisputeDetail(res, order, session, { error: result.message });
      return;
    }
    res.status(409).set("Cache-Control", "no-store").type("html").send(
      page("Cannot resolve — Thingery", "Cannot resolve", `<h1>Cannot resolve</h1><p class="meta">${escapeHtml(result.message)}</p><p><a href="/admin/disputes">← All disputes</a></p>`),
    );
    return;
  }
  // PRG: redirect after success so a refresh never re-submits the resolution.
  res.redirect(303, `/admin/disputes?resolved=${encodeURIComponent(result.order.id)}`);
}));



/**
 * Mounts the browser API and its terminal error middleware (spec THI-58 §2
 * D2, PR-1). The middleware is app-level and registered AFTER the router
 * mount, so it catches both errors escaping the router and the pre-router
 * body-parser errors a router-internal handler can never see (F3). Mirrors
 * mountOauthRoutes in src/oauth.ts.
 */
export function mountApiRoutes(app: Express): void {
  app.use("/api", api);
  // Admin UI pages (THI-569): mounted at the app root (/admin/...), inside
  // this protected file so the whole admin route surface stays under the
  // THI-36 gate. Form transport: scoped urlencoded body parser for /admin
  // only — the global JSON parser above never sees form posts.
  app.use("/admin", express.urlencoded({ limit: "64kb", extended: false }));
  app.use(adminPages);
  // THI-58: terminal error middleware for the /api surface. asyncHandler
  // forwards handler rejections here; they degrade to a generic JSON 500 —
  // no error detail, no stack (F5). Body-parser 4xx statuses are preserved
  // ONLY for genuine entity.* parser errors (F4); anything else — including
  // a handler error carrying a forged or real .status — fails closed to 500
  // (Security note N1). In-flight (headers-sent) responses are destroyed.
  // Express 4 matches routes case-insensitively (THI-52 finding 1), so the
  // scope check folds the path: /API/LOGIN stays in scope.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const foldedPath = req.path.toLowerCase();
    if (foldedPath !== "/api" && !foldedPath.startsWith("/api/")) {
      next(err); // non-/api errors pass through untouched (blast-radius guard)
      return;
    }
    const parserErr = err as { type?: unknown; status?: unknown };
    let status = 500;
    let message = "Something went wrong. Please try again.";
    if (
      typeof parserErr.type === "string" &&
      parserErr.type.startsWith("entity.") &&
      typeof parserErr.status === "number" &&
      parserErr.status >= 400 &&
      parserErr.status < 500
    ) {
      status = parserErr.status;
      message = status === 413 ? "Request body too large." : "Request body could not be read.";
    }
    console.error("api error:", req.method, req.path, "->", status, message);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.set("Cache-Control", "no-store");
    res.status(status).json({ error: message });
  });
}
