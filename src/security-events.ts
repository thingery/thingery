// Structured security event logging (spec THI-112 / docs/security.md §6 H4.2).
// One JSON object per line on stdout — Docker/Caddy capture is the ship path
// (no log infrastructure yet, YAGNI per the security doc). Incident response
// and moderation correlate signups, logins, rate-limit rejections, listing
// writes and image uploads from these lines.
//
// HARD RULE (docs/security.md): never log secrets, API keys, cookies or
// request payloads — titles and descriptions included. The JSON line is
// built field-by-field from the fixed whitelist below, never by stringifying
// the event or context objects, so an extra runtime property on either
// cannot leak into the log. Values that come from callers are short slugs
// (route names, reason codes), never raw request data. Since THI-133 those
// slugs are compile-time literal unions (SecurityEventRoute /
// SecurityEventReason below): a dynamic, request-derived string (e.g.
// req.path) does not typecheck, and a new route/reason is a one-line type
// change reviewers see. Pinned by tests/security-events.test-d.ts.

/** Fixed route slugs for rate_limit events (THI-133; "/api/items/:id/images"
 *  added by THI-144 for the upload-route limiters' 429s; "/api/chat" added
 *  by THI-180 for the chat turn limiters + daily-budget pre-flight 429s;
 *  "/api/me/llm-credential" added by THI-189 for the BYO credential-route limiter;
 *  "/api/me/chatgpt/connect" added by THI-193 PR-2 for the OAuth connect limiter). */
export type SecurityEventRoute =
  | "/api/signup"
  | "/api/login"
  | "/mcp"
  | "/api/items/:id/images"
  | "/api/items/:id/images/:filename" // THI-308 PR 4: image-mutation limiter 429s (F6)
  | "/api/items/:id/images/order" // THI-308 PR 4: image-mutation limiter 429s (F6)
  | "/api/chat"
  | "/api/me/llm-credential"
  | "/api/me/chatgpt/connect";

/** Fixed rejection reasons for image_upload events (THI-133; extended with
 *  the THI-110 upload-abuse reasons that landed via PR #69 — each is a
 *  reviewed one-line addition, which is the point of this union).
 *  THI-156 rev 2 re-encode pipeline rejections — fixed slugs, no payload. */
export type SecurityEventReason =
  | "unsupported_media_type"
  | "empty"
  | "too_large"
  | "not_owned"
  | "bad_magic"
  | "media_type_mismatch"
  | "item_image_limit"
  | "quota_exceeded"
  | "decode_failed"
  | "pixel_limit"
  | "reencode_failed"
  | "output_too_large";

/** Fixed terminal refresh-error slugs for chatgpt_oauth_error events
 *  (THI-193 §2 error taxonomy / §3.3): any of these means the stored OAuth
 *  bundle is unusable and the row is deleted — resolution falls back to
 *  user-key → company and the UI shows "reconnect". Kept a separate union
 *  from SecurityEventReason so an image_upload event can never carry one of
 *  these slugs (and vice versa). */
export type ChatgptOauthErrorReason =
  | "invalid_grant"
  | "token_expired"
  | "refresh_token_invalidated"
  | "refresh_token_reused"
  | "invalid_client";

export type SecurityEvent =
  | { type: "signup"; outcome: "success" }
  | { type: "login"; outcome: "success" | "failure" }
  | { type: "rate_limit"; route: SecurityEventRoute }
  | { type: "listing_write"; action: "create" | "update" | "delete"; outcome: "success" | "rejected" }
  /** THI-360 R5 (THI-380 rider): one line per buyer-intent write (save /
   *  mute-update / delete), success and every rejection class. Buyer id
   *  only — never q or filters (no-payload rule, §6). */
  | { type: "intent_write"; action: "save" | "update" | "delete"; outcome: "success" | "rejected" }
  /** THI-439 §3.3 (spec rev 1): one line per wanted-item write — action is
   *  the state-machine transition (create | update | renew | expire), success
   *  and every rejection class. Buyer id only — never title/notes (no-payload
   *  rule, §6). Moderation correlates these exactly like listing_write. */
  | { type: "wanted_write"; action: "create" | "update" | "renew" | "expire"; outcome: "success" | "rejected" }
  /** THI-439 §3.3/§3.5: one line per seller response on a wanted item —
   *  `respond` at response creation, `publish` when the response listing
   *  first becomes feed-visible (the idempotent photo-publish stamp).
   *  Seller id only; the publish line carries the stamped count as a number,
   *  never listing or wanted payload. */
  | { type: "wanted_response"; action: "respond" | "publish"; outcome: "success" | "rejected" | "degraded"; count?: number }
  | { type: "image_upload"; outcome: "success" | "rejected"; reason?: SecurityEventReason }
  /** THI-180 §3.3 (rev 2): one line per LLM-backed chat turn. Numbers and
   *  slugs only — `model` is the resolved config string (credential ?? env,
   *  never request data), `usage_source` says whether the numbers are
   *  provider-reported or estimate-charged, and `credential_source` labels
   *  whose key paid for the turn (THI-197). No message content ever
   *  reaches the log (H4.2). */
  | {
      type: "chat_usage";
      model: string;
      credential_source: "company" | "user";
      /** THI-193 §3.5 (additive): which credential paid — company env key,
       *  the user's pasted key, or the user's ChatGPT plan (OAuth). */
      provider: "company" | "user_key" | "chatgpt_oauth";
      rounds: number;
      tokens_in: number;
      tokens_out: number;
      daily_total: number;
      budget: number;
      usage_source: "provider" | "estimate_fallback";
    }
  /** THI-197: a stored BYO credential failed to decrypt (tamper/corruption)
   *  during /api/chat resolution. Slug only — never key material, ciphertext
   *  or base_url; the turn falls back to the company key. */
  | { type: "byo_credential_error"; route: SecurityEventRoute }
  /** THI-193 §3.3: a stored ChatGPT OAuth connection hit a TERMINAL refresh
   *  error and the row was deleted. `reason` is a fixed slug (never provider
   * text, never token material). */
  | { type: "chatgpt_oauth_error"; reason: ChatgptOauthErrorReason };

export interface SecurityEventContext {
  sellerId?: string;
  ip?: string;
}

/**
 * Emits one security event as a single JSON line on stdout:
 * `ts`, `type`, the event-specific fields (`outcome` / `action` / `route` /
 * `reason`), then `sellerId` and `ip` (null when absent).
 *
 * The event schema is owned by Security (docs/security.md §6); field names
 * and the set of events are final at PR review.
 */
export function logSecurityEvent(event: SecurityEvent, ctx: SecurityEventContext = {}): void {
  const line = {
    ts: new Date().toISOString(),
    type: event.type,
    ...("outcome" in event ? { outcome: event.outcome } : {}),
    ...("action" in event ? { action: event.action } : {}),
    ...("route" in event ? { route: event.route } : {}),
    ...(event.type === "image_upload" && event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.type === "chatgpt_oauth_error" ? { reason: event.reason } : {}),
    ...(event.type === "wanted_response" && event.count !== undefined ? { count: event.count } : {}),
    ...(event.type === "chat_usage"
      ? {
          model: event.model,
          credential_source: event.credential_source,
          provider: event.provider,
          rounds: event.rounds,
          tokens_in: event.tokens_in,
          tokens_out: event.tokens_out,
          daily_total: event.daily_total,
          budget: event.budget,
          usage_source: event.usage_source,
        }
      : {}),
    sellerId: ctx.sellerId ?? null,
    ip: ctx.ip ?? null,
  };
  console.log(JSON.stringify(line));
}
