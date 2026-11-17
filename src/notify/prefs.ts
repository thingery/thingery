// Notification preferences + policy classes (THI-760 plan Phase 2 / THI-780,
// PR 1 of Phase 2; plan §5). Preferences live in
// `sellers.profile.notification_prefs` — the profile column's own comment
// reserves exactly this key — with the four-field shape the board approved:
//
//   { transactional_orders: 'email'|'in_app',
//     transactional_money:   'email+in_app'          (locked),
//     digest:                'none'|'daily'|'weekly' (default none),
//     locale:                'en' }
//
// Policy classes (plan §5), enforced in ONE place — the delivery sweep's
// pre-send account checks (src/notify/delivery.ts):
//   (a) money / security-critical (receipts, refunds, disputes, chargebacks,
//       payouts): email can never be disabled — money events must reach the
//       account owner (`transactional_money` is locked at 'email+in_app');
//   (b) ordinary transactional (shipped, sold, placed, reminders…):
//       per-channel opt-out via `transactional_orders`;
//   (c) digest: opt-in only (default 'none'); the digest sweep creates rows
//       only for opted-in recipients and delivery re-checks the preference
//       so a pending digest is cancelled by a late opt-out/unsubscribe.
//
// Reading is tolerant: any malformed stored value degrades to the per-key
// default (never throws — a corrupt profile must not break delivery).
// Writing is strict: PATCH input is validated by sanitizePrefsUpdate and
// every invalid value is rejected with a 400 (API contract is explicit).

/** The four preference fields, board-approved shape (plan §5). */
export interface NotificationPrefs {
  transactional_orders: "email" | "in_app";
  /** Locked (plan §5a): stored and returned, but never writable to anything
   *  else — the money class cannot be email-disabled. */
  transactional_money: "email+in_app";
  digest: "none" | "daily" | "weekly";
  locale: string; // 'en' in Phase 2; the field exists so later phases can branch
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  transactional_orders: "email",
  transactional_money: "email+in_app",
  digest: "none",
  locale: "en",
};

/** Parse a stored `profile->'notification_prefs'` value. Unknown shapes,
 *  missing keys, and wrong types all fall back per-key — fail-open to
 *  defaults (a corrupt row yields the shipped default behavior). */
export function parseNotificationPrefs(raw: unknown): NotificationPrefs {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    transactional_orders:
      o.transactional_orders === "in_app" || o.transactional_orders === "email"
        ? o.transactional_orders
        : DEFAULT_NOTIFICATION_PREFS.transactional_orders,
    transactional_money: DEFAULT_NOTIFICATION_PREFS.transactional_money, // locked — single legal value
    digest:
      o.digest === "daily" || o.digest === "weekly" || o.digest === "none"
        ? o.digest
        : DEFAULT_NOTIFICATION_PREFS.digest,
    locale: o.locale === "en" ? o.locale : DEFAULT_NOTIFICATION_PREFS.locale,
  };
}

export interface PrefsFieldError {
  field: string;
  reason: string;
}

export interface PrefsUpdateResult {
  /** Validated partial update — only fields the caller sent; empty when
   *  every field was invalid (caller answers with the errors). */
  prefs: Partial<NotificationPrefs>;
  errors: PrefsFieldError[];
}

/** Validate a PATCH body. Every sent field must be legal; unknown fields and
 *  attempts to change the locked money class are errors, not silent drops.
 *  `null`/undefined values are ignored (JSON Merge-Patch semantics). */
export function sanitizePrefsUpdate(input: unknown): PrefsUpdateResult {
  const result: PrefsUpdateResult = { prefs: {}, errors: [] };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    result.errors.push({ field: "", reason: "body must be a JSON object" });
    return result;
  }
  const o = input as Record<string, unknown>;
  for (const [field, value] of Object.entries(o)) {
    if (value === null) continue;
    switch (field) {
      case "transactional_orders":
        if (value === "email" || value === "in_app") result.prefs.transactional_orders = value;
        else result.errors.push({ field, reason: "must be 'email' or 'in_app'" });
        break;
      case "transactional_money":
        // Locked (plan §5a): the only accepted value is the locked one
        // itself — an explicit no-op. Anything else is a rejected attempt to
        // disable money email.
        if (value === "email+in_app") break;
        result.errors.push({
          field,
          reason: "locked: money and security notifications (receipts, refunds, disputes, chargebacks, payouts) cannot be disabled",
        });
        break;
      case "digest":
        if (value === "none" || value === "daily" || value === "weekly") result.prefs.digest = value;
        else result.errors.push({ field, reason: "must be 'none', 'daily' or 'weekly'" });
        break;
      case "locale":
        if (value === "en") result.prefs.locale = value; // Phase 2: en only (plan §6)
        else result.errors.push({ field, reason: "unsupported locale (Phase 2 supports 'en')" });
        break;
      default:
        result.errors.push({ field, reason: "unknown preference field" });
    }
  }
  return result;
}

// --- Policy classes -----------------------------------------------------------

/** Money / security-critical events (plan §5a): receipts, refunds, disputes,
 *  chargebacks — plus payouts (the seller's money moving; same reasoning the
 *  plan states: "money events must reach the account owner"). */
export const MONEY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "buyer.payment_received",
  "buyer.refund_initiated",
  "buyer.refund_confirmed",
  "buyer.dispute_outcome",
  "seller.dispute_opened",
  "seller.chargeback",
  "seller.dispute_resolved",
  "seller.payout_paid",
]);

/** The policy class of an event type (or outbox template key, with or
 *  without the `.v1` suffix): everything not in the money set is ordinary
 *  transactional (digest templates are handled by their own branch in
 *  emailAllowedByPrefs — they are never "orders"). */
export function eventPolicyClass(eventType: string): "money" | "orders" {
  return MONEY_EVENT_TYPES.has(eventType.replace(/\.v\d+$/, "")) ? "money" : "orders";
}

/** THE single policy decision (plan §5) — consumed by the delivery sweep
 *  only. `template` is the email_outbox template column value (e.g.
 *  'seller.item_sold.v1', 'digest.daily.v1'). */
export function emailAllowedByPrefs(prefs: NotificationPrefs, template: string): boolean {
  const key = template.replace(/\.v\d+$/, "");
  if (key === "digest.daily" || key === "digest.weekly") return prefs.digest !== "none"; // (c) opt-in, cancellable until sent
  if (eventPolicyClass(key) === "money") return true; // (a) locked — cannot be disabled
  return prefs.transactional_orders === "email"; // (b) per-channel opt-out
}
