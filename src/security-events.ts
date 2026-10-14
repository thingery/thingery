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

/** Fixed route slugs for rate_limit events (THI-133). */
export type SecurityEventRoute = "/api/signup" | "/api/login" | "/mcp";

/** Fixed rejection reasons for image_upload events (THI-133; extended with
 *  the THI-110 upload-abuse reasons that landed via PR #69 — each is a
 *  reviewed one-line addition, which is the point of this union). */
export type SecurityEventReason =
  | "unsupported_media_type"
  | "empty"
  | "too_large"
  | "not_owned"
  | "bad_magic"
  | "media_type_mismatch"
  | "item_image_limit"
  | "quota_exceeded";

export type SecurityEvent =
  | { type: "signup"; outcome: "success" }
  | { type: "login"; outcome: "success" | "failure" }
  | { type: "rate_limit"; route: SecurityEventRoute }
  | { type: "listing_write"; action: "create" | "update" | "delete"; outcome: "success" | "rejected" }
  | { type: "image_upload"; outcome: "success" | "rejected"; reason?: SecurityEventReason };

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
    sellerId: ctx.sellerId ?? null,
    ip: ctx.ip ?? null,
  };
  console.log(JSON.stringify(line));
}
