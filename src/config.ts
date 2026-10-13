// Order-flow configuration (spec THI-3 rev 2 §4.4 + rev 3 §11) — shared,
// fail-closed boot validation (THI-8 F1). Reused by the Stripe client
// (PR-3), the webhook endpoints (PR-6/7) and the admin route (PR-9).
//
// Fail-closed rule #1: an EMPTY or whitespace-only value is treated as UNSET
// everywhere. HMAC-SHA256(body, "") is computable by anyone, and .env files
// conventionally carry empty-valued entries — that misconfiguration must
// never turn into an accept-anything verifier.
//
// Fail-closed rule #2: providers configured "half way" degrade to disabled
// surfaces with a boot error, never to open ones:
//   - STRIPE_SECRET_KEY set + STRIPE_WEBHOOK_SECRET unset
//       → payments stay enabled, the Stripe webhook endpoint mounts as a 503
//         stub (PR-6) and this module flags stripeWebhookReady = false.
//   - EASYPOST_API_KEY set + EASYPOST_WEBHOOK_SECRET unset
//       → tracker registration works, the carrier webhook mounts as a 503
//         stub (PR-7), carrierWebhookReady = false.
//   - ADMIN_API_KEY shorter than 32 chars → the admin route stays disabled
//     (PR-9), adminRouteEnabled = false.

/** Empty/whitespace strings count as unset (F1). */
export function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Positive-integer env with a spec default; malformed values fall back. */
export function envInt(name: string, fallback: number): number {
  const raw = envValue(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export type StripeMode = "test" | "live";

export interface OrderFlowConfig {
  // Stripe payments (the kill switch: STRIPE_SECRET_KEY absent → order tools
  // return payments_not_configured and listing/search behavior is unchanged).
  stripePaymentsEnabled: boolean;
  stripeMode: StripeMode | null;
  stripeWebhookReady: boolean;
  stripeWebhookSecret: string | undefined;
  stripeWebhookSecretPrevious: string | undefined; // rotation (F13)
  // EasyPost carrier automation (optional per deployment; degraded mode).
  easypostEnabled: boolean;
  carrierWebhookReady: boolean;
  easypostWebhookSecret: string | undefined;
  easypostWebhookSecretPrevious: string | undefined;
  // Admin dispute route (PR-9): disabled unless the key is long enough (F7).
  adminRouteEnabled: boolean;
  // Deadline / abuse-cap windows (spec §4.4; rev 3 §11.3 adds 8–9).
  paymentDeadlineHours: number;          // 24
  disputeWindowHours: number;            // 48 (buyer/carrier-confirmed)
  systemConfirmedDisputeWindowHours: number; // 336 (pickup auto-confirm, F10)
  pickupAutoconfirmDays: number;         // 14
  inTransitStuckDays: number;            // 21
  staleSoldDays: number;                 // 21
  disputeAutorefundHours: number;        // 72 (rev 3 §11.3 rule 8)
  disputeStaleDays: number;              // 7  (rev 3 §11.3 rule 9)
  stuckMoneyAlertDays: number;           // 7  (sweep rule 7)
  sweepIntervalMinutes: number;          // 10 (sweep cadence, §4.5)
  maxPendingOrdersPerBuyer: number;      // 3  (F8)
  reorderCooldownMinutes: number;        // 60 (F8)
}

function stripeModeFor(key: string | undefined): StripeMode | null {
  if (key === undefined) return null;
  if (key.startsWith("sk_test_")) return "test";
  if (key.startsWith("sk_live_")) return "live";
  // Unknown prefix: treat as test (never silently accept live-shaped
  // behavior from a malformed key) — surfaced as a boot error below.
  return "test";
}

export function orderFlowConfig(): OrderFlowConfig {
  const stripeKey = envValue("STRIPE_SECRET_KEY");
  const stripeMode = stripeModeFor(stripeKey);
  const stripePaymentsEnabled = stripeKey !== undefined;

  const stripeWebhookSecret = envValue("STRIPE_WEBHOOK_SECRET");
  const stripeWebhookSecretPrevious = envValue("STRIPE_WEBHOOK_SECRET_PREVIOUS");
  const easypostKey = envValue("EASYPOST_API_KEY");
  const easypostWebhookSecret = envValue("EASYPOST_WEBHOOK_SECRET");
  const easypostWebhookSecretPrevious = envValue("EASYPOST_WEBHOOK_SECRET_PREVIOUS");
  const adminKey = envValue("ADMIN_API_KEY");

  if (stripeKey !== undefined && !/^(sk_test_|sk_live_)/.test(stripeKey)) {
    console.error(
      "[config] STRIPE_SECRET_KEY has an unrecognized prefix (expected sk_test_… or sk_live_…); " +
        "treating the deployment as test mode — check the key.",
    );
  }

  return {
    stripePaymentsEnabled,
    stripeMode,
    stripeWebhookReady: stripeKey !== undefined && stripeWebhookSecret !== undefined,
    stripeWebhookSecret,
    stripeWebhookSecretPrevious: stripeWebhookSecret !== undefined ? stripeWebhookSecretPrevious : undefined,
    easypostEnabled: easypostKey !== undefined,
    carrierWebhookReady: easypostWebhookSecret !== undefined,
    easypostWebhookSecret,
    easypostWebhookSecretPrevious: easypostWebhookSecret !== undefined ? easypostWebhookSecretPrevious : undefined,
    adminRouteEnabled: adminKey !== undefined && adminKey.length >= 32,
    paymentDeadlineHours: envInt("PAYMENT_DEADLINE_HOURS", 24),
    disputeWindowHours: envInt("DISPUTE_WINDOW_HOURS", 48),
    systemConfirmedDisputeWindowHours: envInt("SYSTEM_CONFIRMED_DISPUTE_WINDOW_HOURS", 336),
    pickupAutoconfirmDays: envInt("PICKUP_AUTOCONFIRM_DAYS", 14),
    inTransitStuckDays: envInt("IN_TRANSIT_STUCK_DAYS", 21),
    staleSoldDays: envInt("STALE_SOLD_DAYS", 21),
    disputeAutorefundHours: envInt("DISPUTE_AUTOREFUND_HOURS", 72),
    disputeStaleDays: envInt("DISPUTE_STALE_DAYS", 7),
    stuckMoneyAlertDays: envInt("STUCK_MONEY_ALERT_DAYS", 7),
    sweepIntervalMinutes: envInt("SWEEP_INTERVAL_MINUTES", 10),
    maxPendingOrdersPerBuyer: envInt("MAX_PENDING_ORDERS_PER_BUYER", 3),
    reorderCooldownMinutes: envInt("REORDER_COOLDOWN_MINUTES", 60),
  };
}

/** Boot-time report (fail-closed errors are logged, never swallowed). */
export function logConfigBootReport(cfg: OrderFlowConfig = orderFlowConfig()): OrderFlowConfig {
  if (cfg.stripePaymentsEnabled) {
    console.log(`[config] Stripe payments enabled (${cfg.stripeMode} mode)`);
    if (!cfg.stripeWebhookReady) {
      console.error(
        "[config] STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is unset — " +
          "the Stripe webhook endpoint will mount as a 503 stub (payments continue; " +
          "webhook events are not accepted until the secret is configured).",
      );
    }
  } else {
    console.log("[config] Stripe payments not configured — order tools answer payments_not_configured (kill switch)");
  }
  if (cfg.easypostEnabled && !cfg.carrierWebhookReady) {
    console.error(
      "[config] EASYPOST_API_KEY is set but EASYPOST_WEBHOOK_SECRET is unset — " +
        "the carrier webhook endpoint will mount as a 503 stub.",
    );
  }
  if (!cfg.adminRouteEnabled) {
    console.log("[config] Admin dispute route disabled (ADMIN_API_KEY unset or shorter than 32 chars)");
  }
  return cfg;
}
