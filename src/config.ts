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
//
// Shipping provider selection (THI-1246, spec docs/specs/shipping-provider-layer.md):
// SHIPPING_PROVIDER names the one carrier provider for the deployment
// (case-insensitive; default "easypost"). The selected provider's own env
// pair `${ID}_API_KEY` / `${ID}_WEBHOOK_SECRET` (+_PREVIOUS rotation) carries
// its configuration; env vars of other providers are ignored with a boot
// warning. An UNRECOGNIZED selection fails closed: boot error + shipping
// disabled (order quotes fall back to flat rate, label purchase errors
// easypost_not_configured-style, the carrier webhook mounts as a 503 stub).
// Rollback = flip SHIPPING_PROVIDER back — zero DDL, zero data migration.

import {
  SHIPPING_PROVIDER_IDS,
  providerApiKeyEnv,
  providerWebhookSecretEnv,
  type ShippingProviderId,
} from "./shipping/provider.js";
import { isIsoCountryCode } from "./countries.js";

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

/** Non-negative-integer env with a spec default (label-purchase spec, THI-566
 *  A2): 0 is a MEANINGFUL value — LABEL_DAILY_BUDGET_CENTS=0 is the spend kill
 *  switch — so envInt's positive-only rule must not swallow it. Malformed
 *  values still fall back (fail toward the documented default, never wider). */
export function envNonNegativeInt(name: string, fallback: number): number {
  const raw = envValue(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
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
  // THI-1611 A1: Stripe delivers connected-account events (`account.updated`,
  // the seller-onboarding flip) to the 'Connected accounts'-scoped webhook
  // endpoint, which has its OWN signing secret — a different value from the
  // platform endpoint's STRIPE_WEBHOOK_SECRET. Unset ⇒ exactly the old
  // single-secret behavior (self-hosters without Connect onboarding keep
  // working; connect-shaped deliveries then 400 exactly as before).
  stripeConnectWebhookSecret: string | undefined;
  stripeConnectWebhookSecretPrevious: string | undefined; // rotation twin (F13)
  // THI-1625 B-1 (card-only native listings, thi1611 spec §B1/B2): hosted-
  // platform commercial policy behind a deployment flag — OFF by default so
  // self-hosters keep exactly today's behavior (off-platform mode stays a
  // core capability; the public repo stays green with the flag off).
  cardOnlyMode: boolean;
  /** D4: seller payout countries allowed to sell natively under card-only
   *  mode (SELLER_COUNTRY_ALLOWLIST, comma-separated ISO 3166-1 alpha-2).
   *  null = no country restriction (env unset/empty). Parsed fail-closed:
   *  invalid entries are dropped with a boot error, never widened. */
  sellerCountryAllowlist: ReadonlySet<string> | null;
  // THI-1681: Accounts v2 events (capability_status_updated — the payout-ready
  // flip for v2 recipient accounts) do NOT arrive on the v1 webhook endpoints
  // at all; Stripe delivers them only through an event destination
  // (Workbench or /v2/core/event_destinations) with its OWN signing secret.
  // Unset ⇒ the v2 endpoint mounts as a 503 stub and sellers.stripe_onboarded_at
  // is driven by the v1 account.updated path only (legacy sellers). Self-hosters
  // on v1 accounts keep working without it.
  stripeEventDestinationSecret: string | undefined;
  stripeEventDestinationSecretPrevious: string | undefined; // rotation twin (F13)
  // Shipping provider (THI-1246): exactly ONE carrier provider per
  // deployment — id/scoped rate + tracker ids make runtime mixing a non-issue
  // by construction. easypostEnabled's old role ("a provider is configured")
  // is shippingEnabled; easypostWebhookSecret(-Previous) become the carrier-
  // neutral carrierWebhookSecret(-Previous) for the SELECTED provider.
  shippingProvider: ShippingProviderId;
  shippingEnabled: boolean;
  carrierWebhookReady: boolean;
  carrierWebhookSecret: string | undefined;
  carrierWebhookSecretPrevious: string | undefined;
  // Admin dispute route (PR-9): disabled unless the key is long enough (F7).
  adminRouteEnabled: boolean;
  // Admin UI (THI-562 work item 3, spec docs/specs/admin-dispute-ui.md):
  // the session-cookie surface additionally requires an explicit, strong
  // SESSION_SECRET — not auth.ts's ephemeral random fallback (THI-566 minor:
  // silently-churning sessions on restart) and not a short string (the cookie
  // + CSRF HMACs are only as strong as the secret). Fail-closed: unset or
  // short ⇒ every /admin page 404s, indistinguishable from absent. The JSON
  // endpoint keeps its own adminRouteEnabled gate (Bearer-key transport).
  adminUiEnabled: boolean;
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
  // Label purchase spend gates (docs/specs/label-purchase.md; THI-566 A1/A2).
  // Both read env + defaults only — no client input can widen them.
  labelMaxCostCents: number;             // 3000 ≈ €30 per label (A1)
  labelDailyBudgetCents: number;         // 20000 ≈ €200/day platform-wide; 0 = kill switch (A2)
  // Off by default: a label is bought only against shipping the buyer paid. "true"
  // lets sellers also buy labels the deployment pays for (flat and off-platform orders).
  labelAllowOperatorFunded: boolean;
  // Buyer-paid shipping (spec docs/specs/buyer-paid-shipping.md §2, data
  // model). SHIPPING_QUOTE_TIMEOUT_MS bounds the order-time EasyPost quote
  // call with an AbortSignal — a hanging provider must never hold the
  // item-reservation row lock / a pool client (the address-verification
  // timeout is the precedent). SHIPPING_QUOTE_ESTIMATE_TTL_MINUTES is the
  // display-only freshness note for quote_shipping estimates (§9) — advisory,
  // never a binding expiry.
  shippingQuoteTimeoutMs: number;        // 5000 — quote-call AbortSignal bound
  shippingQuoteEstimateTtlMinutes: number; // 15 — estimate display freshness
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
  const stripeConnectWebhookSecret = envValue("STRIPE_CONNECT_WEBHOOK_SECRET");
  const stripeConnectWebhookSecretPrevious = envValue("STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS");

  // --- Card-only native listings (THI-1625 B-1; thi1611 spec §B1/B2) ------
  // CARD_ONLY_MODE=true flips the hosted commercial policy: create_order
  // never creates a NEW off_platform order (explicit requests refused with
  // off_platform_disabled; the fallback is stripe-only, else a clear
  // not-orderable reason) and price-0 native listings are not orderable
  // (free_item_not_orderable). Existing off_platform orders are untouched —
  // the gate is at creation only.
  const cardOnlyMode = ["1", "true"].includes((envValue("CARD_ONLY_MODE") ?? "").toLowerCase());
  // SELLER_COUNTRY_ALLOWLIST (D4): comma-separated ISO 3166-1 alpha-2 payout
  // countries allowed to sell natively under card-only mode; unset/empty ⇒
  // no country restriction. Fail-closed parsing: entries are normalized
  // (trim + uppercase) and validated against the ISO set; an invalid entry
  // is DROPPED with a boot error — the failure direction is "seller
  // blocked", never "unvalidated country allowed". A list that validates to
  // zero entries blocks every seller country until fixed.
  const allowlistRaw = envValue("SELLER_COUNTRY_ALLOWLIST");
  let sellerCountryAllowlist: ReadonlySet<string> | null = null;
  if (allowlistRaw !== undefined) {
    const entries = allowlistRaw
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c.length > 0);
    for (const c of entries.filter((c) => !isIsoCountryCode(c))) {
      console.error(
        `[config] SELLER_COUNTRY_ALLOWLIST entry ${JSON.stringify(c)} is not an ISO 3166-1 alpha-2 code — ` +
          "DROPPED (fail-closed): sellers from that country are blocked until the list is fixed.",
      );
    }
    sellerCountryAllowlist = new Set(entries.filter((c) => isIsoCountryCode(c)));
    if (cardOnlyMode && sellerCountryAllowlist.size === 0) {
      console.error(
        "[config] SELLER_COUNTRY_ALLOWLIST is set but contains no valid ISO 3166-1 alpha-2 code — " +
          "with CARD_ONLY_MODE on, NO seller country is orderable (fail-closed). Fix the list to re-enable.",
      );
    }
  }
  const stripeEventDestinationSecret = envValue("STRIPE_EVENT_DESTINATION_SECRET");
  const stripeEventDestinationSecretPrevious = envValue("STRIPE_EVENT_DESTINATION_SECRET_PREVIOUS");

  // --- Shipping provider selection (THI-1246) ----------------------------
  // Exactly one provider per deployment. Case-insensitive id; unset → the
  // default ("easypost", today's behavior). Only the SELECTED provider's env
  // pair is read; another provider's keys present in the environment are
  // ignored with a boot warning (never silently mixed). An unrecognized value
  // fails closed: boot error + shipping fully disabled, regardless of which
  // API keys are present.
  const AVAILABLE_SHIPPING_PROVIDERS = ["easypost", "shippo"] as const;
  const providerRaw = envValue("SHIPPING_PROVIDER");
  let shippingProvider: ShippingProviderId = "easypost";
  let shippingSelectionValid = true;
  if (providerRaw !== undefined) {
    const candidate = providerRaw.toLowerCase();
    if ((AVAILABLE_SHIPPING_PROVIDERS as readonly string[]).includes(candidate)) {
      shippingProvider = candidate as ShippingProviderId;
    } else {
      shippingSelectionValid = false;
      console.error(
        `[config] SHIPPING_PROVIDER=${JSON.stringify(providerRaw)} is not a valid provider ` +
          `(expected ${AVAILABLE_SHIPPING_PROVIDERS.map((p) => `"${p}"`).join(" or ")}, case-insensitive) — ` +
          "shipping is DISABLED (fail-closed). Fix SHIPPING_PROVIDER to re-enable.",
      );
    }
  }
  // Other vocabulary ids must not leak into a deployment pointed at a
  // different provider: warn loudly, ignore completely.
  for (const other of SHIPPING_PROVIDER_IDS) {
    if (other === shippingProvider) continue;
    const otherKey = envValue(providerApiKeyEnv(other));
    const otherSecret = envValue(providerWebhookSecretEnv(other));
    if (otherKey !== undefined || otherSecret !== undefined) {
      console.warn(
        `[config] ${providerApiKeyEnv(other)} or ${providerWebhookSecretEnv(other)} is set but ` +
          `SHIPPING_PROVIDER=${shippingProvider} — ignoring it (one provider per deployment).`,
      );
    }
  }
  const shippingApiKey = envValue(providerApiKeyEnv(shippingProvider));
  const carrierWebhookSecret = envValue(providerWebhookSecretEnv(shippingProvider));
  const carrierWebhookSecretPrevious = envValue(`${providerWebhookSecretEnv(shippingProvider)}_PREVIOUS`);

  const adminKey = envValue("ADMIN_API_KEY");
  const sessionSecret = envValue("SESSION_SECRET");

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
    stripeConnectWebhookSecret,
    // Same rotation gating as the platform twin: an unset current secret
    // never gets a previous-secret bypass.
    stripeConnectWebhookSecretPrevious:
      stripeConnectWebhookSecret !== undefined ? stripeConnectWebhookSecretPrevious : undefined,
    stripeEventDestinationSecret,
    stripeEventDestinationSecretPrevious:
      stripeEventDestinationSecret !== undefined ? stripeEventDestinationSecretPrevious : undefined,
    cardOnlyMode,
    sellerCountryAllowlist,
    shippingProvider,
    shippingEnabled: shippingSelectionValid && shippingApiKey !== undefined,
    carrierWebhookReady: shippingSelectionValid && carrierWebhookSecret !== undefined,
    carrierWebhookSecret: shippingSelectionValid ? carrierWebhookSecret : undefined,
    carrierWebhookSecretPrevious:
      shippingSelectionValid && carrierWebhookSecret !== undefined ? carrierWebhookSecretPrevious : undefined,
    adminRouteEnabled: adminKey !== undefined && adminKey.length >= 32,
    adminUiEnabled:
      adminKey !== undefined && adminKey.length >= 32 &&
      sessionSecret !== undefined && sessionSecret.length >= 32,
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
    labelMaxCostCents: envInt("LABEL_MAX_COST_CENTS", 3000),
    labelDailyBudgetCents: envNonNegativeInt("LABEL_DAILY_BUDGET_CENTS", 20000),
    labelAllowOperatorFunded: envValue("LABEL_ALLOW_OPERATOR_FUNDED") === "true",
    shippingQuoteTimeoutMs: envInt("SHIPPING_QUOTE_TIMEOUT_MS", 5000),
    shippingQuoteEstimateTtlMinutes: envInt("SHIPPING_QUOTE_ESTIMATE_TTL_MINUTES", 15),
  };
}

// Notifications (THI-760 plan Phase 1 / THI-763): the deploy is dark by
// default — NOTIFY_EMAIL_ENABLED defaults to false, so in-app notifications
// work end-to-end and zero emails leave the process. Same fail-closed rules
// as orderFlowConfig: empty/whitespace env values count as unset (F1), and a
// half-configured provider (flag on, key missing) degrades to dry-run with a
// boot error, never to an open send path (enforced in src/mailer.ts + the
// delivery sweep, later PRs of the same plan).
export interface NotifyConfig {
  // Master email switch (default false — in-app only).
  emailEnabled: boolean;
  // Resend provider key (plan §3: managed provider, not self-hosted SMTP).
  resendApiKey: string | undefined;
  // Transactional sender identity (THI-1280): verification and order-lifecycle
  // mail sends as noreply@ (send-only, no inbox behind it). Replies to any
  // platform mail route to support@ via replyToAddress.
  fromAddress: string;
  // Market-notification sender identity (THI-1280): digests and operator
  // alerts send as notifications@. Kept separate from noreply@ so the two
  // streams can be told apart and reputation-tuned independently.
  digestFromAddress: string;
  // Reply-To for platform mail (THI-1280): user replies land at support@.
  replyToAddress: string;
  // Absolute base for deep links: NOTIFY_PUBLIC_BASE_URL overrides
  // PUBLIC_BASE_URL, then the dev default (plan §3).
  publicBaseUrl: string;
  // Sweep cadence for both notify sweeps (fan-out + delivery).
  sweepIntervalMinutes: number;                 // 1
  // Per-recipient rate cap (overflow stays pending; next sweep retries).
  maxEmailsPerRecipientPerHour: number;         // 6
  // Per-run global send cap (protects the provider free tier, plan §4).
  maxSendsPerSweep: number;                     // 50
  // Staleness cutoff in hours (THI-1043): pending rows older than this are
  // skipped (last_error 'skipped:stale'), never sent — enabling email after
  // a dark period must not flush an arbitrarily old backlog at users.
  maxAgeHours: number;                         // 48
  // Inbound bounce-webhook secret (RESEND_WEBHOOK_SECRET). Unset ⇒ the
  // webhook answers fail-closed 503 (Phase 2 / THI-780) — same posture as
  // STRIPE_WEBHOOK_SECRET / EASYPOST_WEBHOOK_SECRET.
  resendWebhookSecret: string | undefined;
  /** Previous inbound bounce-webhook secret (RESEND_WEBHOOK_SECRET_PREVIOUS,
  * THI-1537): accepted during a rotation window so rotating the Resend
  * webhook secret drops zero deliveries — same pattern as
  * STRIPE_WEBHOOK_SECRET_PREVIOUS (F13). Only honored while the current
  * RESEND_WEBHOOK_SECRET is set; unset ⇒ exactly the single-secret
  * behavior (no bypass of the fail-closed 503 stub). */
  resendWebhookSecretPrevious: string | undefined;
  /** Digest scan cadence in minutes (THI-780 PR 2). Sends are still at
   * most once per period per recipient by dedupe key. */
  digestIntervalMinutes: number;                // 60
  /** Operator alert mailbox (THI-780 PR 4). Unset ⇒ operator alerts are
   * console-only (Phase 1 posture); set ⇒ sweep rules 7/9 + delivery
   * dead-letters mirror there as account-less operator.* outbox rows. */
  operatorAlertEmail: string | undefined;
  /** Item-report alert mailbox (THI-1451, THI-1479 plan Phase C). Unset ⇒
   * report emails stay log-only — the same dark-default posture as
   * operatorAlertEmail, so a self-hosted deployment never mails the
   * Thingery project alias by default. Set (prod: report@thingery.dev) ⇒
   * each committed item report mirrors one account-less
   * ops.item_reported.v1 outbox row (src/notify/operator.ts). */
  reportAlertEmail: string | undefined;
}

export function notifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  // envValue reads process.env directly; notifyConfig takes an explicit env
  // so tests can exercise parsing without mutating process state — same F1
  // empty-is-unset rule, scoped here to the passed environment.
  const value = (name: string): string | undefined => {
    const raw = env[name];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const int = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  const flag = (env.NOTIFY_EMAIL_ENABLED ?? "").trim();
  return {
    emailEnabled: flag === "1" || flag === "true",
    resendApiKey: value("RESEND_API_KEY"),
    fromAddress: value("NOTIFY_FROM_ADDRESS") ?? "noreply@thingery.dev",
    digestFromAddress: value("NOTIFY_DIGEST_FROM_ADDRESS") ?? "notifications@thingery.dev",
    replyToAddress: value("NOTIFY_REPLY_TO_ADDRESS") ?? "support@thingery.dev",
    publicBaseUrl: (
      value("NOTIFY_PUBLIC_BASE_URL") ??
      value("PUBLIC_BASE_URL") ??
      "http://localhost:3000"
    ).replace(/\/+$/, ""),
    sweepIntervalMinutes: int("NOTIFY_SWEEP_INTERVAL_MINUTES", 1),
    maxEmailsPerRecipientPerHour: int("NOTIFY_MAX_EMAILS_PER_RECIPIENT_PER_HOUR", 6),
    maxSendsPerSweep: int("NOTIFY_MAX_SENDS_PER_SWEEP", 50),
    maxAgeHours: int("NOTIFY_MAX_AGE_HOURS", 48),
    resendWebhookSecret: value("RESEND_WEBHOOK_SECRET"),
    // THI-1537: gated on the current secret exactly like Stripe's previous
    // secret — an unset current secret never gets a previous-secret bypass.
    resendWebhookSecretPrevious:
      value("RESEND_WEBHOOK_SECRET") !== undefined
        ? value("RESEND_WEBHOOK_SECRET_PREVIOUS")
        : undefined,
    digestIntervalMinutes: int("NOTIFY_DIGEST_INTERVAL_MINUTES", 60),
    operatorAlertEmail: value("OPERATOR_ALERT_EMAIL") ?? undefined,
    reportAlertEmail: value("REPORT_ALERT_EMAIL") ?? undefined,
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
  if (cfg.cardOnlyMode) {
    console.log(
      `[config] Card-only mode ON — new off_platform orders refused, price-0 native listings not orderable` +
        (cfg.sellerCountryAllowlist
          ? `; seller payout country allowlist: ${[...cfg.sellerCountryAllowlist].sort().join(",")}`
          : "; no seller-country restriction"),
    );
  }
  if (cfg.stripeWebhookReady && !cfg.stripeConnectWebhookSecret) {
    console.error(
      "[config] STRIPE_CONNECT_WEBHOOK_SECRET is unset — connected-account events " +
        "(account.updated: seller onboarding → payout-ready) will fail signature " +
        "verification. Register the 'Connected accounts'-scoped webhook endpoint " +
        "and set its secret (docs/deploy-vps.md §5.3).",
    );
  }
  if (cfg.stripePaymentsEnabled && !cfg.stripeEventDestinationSecret) {
    console.error(
      "[config] STRIPE_EVENT_DESTINATION_SECRET is unset — Accounts v2 capability events " +
        "(v2 seller onboarding → payout-ready, THI-1681) are not accepted; create an event " +
        "destination and set its secret (docs/deploy-vps.md §5.3). Legacy v1 sellers " +
        "are unaffected.",
    );
  }
  if (cfg.shippingEnabled && !cfg.carrierWebhookReady) {
    console.error(
      `[config] ${providerApiKeyEnv(cfg.shippingProvider)} is set but ` +
        `${providerWebhookSecretEnv(cfg.shippingProvider)} is unset — ` +
        "the carrier webhook endpoint will mount as a 503 stub.",
    );
  }
  if (!cfg.adminRouteEnabled) {
    console.log("[config] Admin dispute route disabled (ADMIN_API_KEY unset or shorter than 32 chars)");
  } else if (!cfg.adminUiEnabled) {
    console.error(
      "[config] SESSION_SECRET unset or shorter than 32 chars — the admin UI stays disabled " +
        "(all /admin pages 404). The JSON admin endpoint is unaffected. Set SESSION_SECRET " +
        "explicitly (`openssl rand -hex 32`) so admin sessions survive restarts.",
    );
  }
  // THI-296: presence-only signal — the challenge token value is public-by-design
  // but still never printed (logs stay clean of verbatim operator input).
  console.log(
    `[config] OpenAI apps challenge: ${process.env.OPENAI_APPS_CHALLENGE_TOKEN ? "token set (200)" : "unset (503)"}`,
  );
  return cfg;
}
