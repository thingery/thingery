// Email templates (THI-760 plan §6): pure TypeScript functions — subject +
// text + minimal HTML, no framework (YAGNI), English-only in Phase 1 with the
// `locale` field reserved for later phases. Keys follow the plan's
// `{role}.{event}.v1` convention (account-level mail uses the `account`
// role namespace): renaming content later means issuing a new key, never
// mutating meaning — the API-evolution rule applied to humans' inboxes.
//
// F6 applies to every template: PII-free bodies. The verification email
// carries the verify link only — no order data, no addresses, no counterparty
// information — and the canonical sentence footer.

/** Rendered template — exactly what a Mailer receives. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Stable template keys (record on sends when the Phase 1 outbox exists). */
export const EMAIL_TEMPLATE_KEYS = {
  emailVerification: "account.email_verification.v1",
} as const;

/** THI-780 PR 2 (plan §5 + §6): digest line items — public listing data
 * only (item title + link), no counterparties, no addresses (F6). */
export interface DigestItem {
  eventType: string;
  itemTitle?: string;
  url?: string;
}

/** `digest.daily.v1` / `digest.weekly.v1` — one renderer, the frequency is
 * a parameter. Opt-in mail: every digest carries a working one-click
 * unsubscribe link in the body (plus the List-Unsubscribe header the
 * delivery sweep stamps from payload.unsubscribe_url — belt and braces in
 * case the provider strips headers). */
export function renderDigest(p: {
  frequency: "daily" | "weekly";
  count: number;
  items: DigestItem[];
  unsubscribeUrl: string;
}): RenderedEmail {
  const label = p.frequency;
  const subject = subjectSafe(
    p.count > p.items.length
      ? `Your ${label} Thingery digest — ${p.count} updates`
      : `Your ${label} Thingery digest`,
  );
  const lines = p.items.map(
    (it) => `${it.itemTitle ?? it.eventType}${it.url ? ` — ${it.url}` : ""}`,
  );
  const more = p.count > p.items.length ? [`… and ${p.count - p.items.length} more` ] : [];
  const text =
    `Here is what happened on Thingery since your last digest:

` +
    [...lines, ...more].join("\n") +
    `\n\nManage or turn off digests: ${p.unsubscribeUrl}\n` +
    `\n— ${CANONICAL_SENTENCE}\n`;
  const html =
    `<p>Here is what happened on Thingery since your last digest:</p>\n<ul>\n` +
    p.items.map((it) => `  <li>${it.url ? `<a href="${escapeHtml(it.url)}">${escapeHtml(it.itemTitle ?? it.eventType)}</a>` : escapeHtml(it.itemTitle ?? it.eventType)}</li>`).join("\n") +
    (p.count > p.items.length ? `\n  <li>… and ${p.count - p.items.length} more</li>` : "") +
    `\n</ul>\n` +
    `<p><a href="${escapeHtml(p.unsubscribeUrl)}">Turn off ${label} digests</a></p>\n` +
    `<p style="color:#666;font-size:12px">— ${CANONICAL_SENTENCE}</p>\n`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Canonical footer sentence (AGENTS.md — verbatim, never paraphrased). */
const CANONICAL_SENTENCE =
  "Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.";

/** `account.email_verification.v1` — sent at signup and on resend while the
 * address is unverified. `verifyUrl` is server-built (token is the only
 * secret in it); `ttlHours` matches EMAIL_VERIFICATION_TTL_S. */
export function renderEmailVerification(params: {
  verifyUrl: string;
  ttlHours: number;
}): RenderedEmail {
  const { verifyUrl, ttlHours } = params;
  const subject = "Verify your email — Thingery";
  const text =
    `Welcome to Thingery!\n\n` +
    `Confirm your email address to make sure marketplace notifications reach you:\n\n` +
    `${verifyUrl}\n\n` +
    `This link expires in ${ttlHours} hours and can be used once. If you did not create a ` +
    `Thingery account, you can ignore this email.\n\n` +
    `— ${CANONICAL_SENTENCE}\n`;
  const html =
    `<p>Welcome to Thingery!</p>\n` +
    `<p>Confirm your email address to make sure marketplace notifications reach you:</p>\n` +
    `<p><a href="${escapeHtml(verifyUrl)}">Verify your email</a> ` +
    `(<code>${escapeHtml(verifyUrl)}</code>)</p>\n` +
    `<p>This link expires in ${ttlHours} hours and can be used once. If you did not create a ` +
    `Thingery account, you can ignore this email.</p>\n` +
    `<p style="color:#666;font-size:12px">— ${CANONICAL_SENTENCE}</p>\n`;
  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Phase 1 order emails (THI-760 plan §1/§6, THI-763 PR 2). One pure function
// per `{role}.{event}.v1` key — the notifications.event_type carries the key
// without the `.v1`, so template = `${event_type}.v1` (outbox column).
// F6 everywhere: params and bodies carry item title, amount, status and deep
// links ONLY — never shipping addresses or counterparty contact data. Every
// email links /order/:id (primary) and /browse (footer); item-linked events
// also link /item/:id. English-only (plan §6 — `locale` reserved).

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", CHF: "Fr " };

/** Deterministic money formatting — no Intl/ICU so snapshots are stable. */
export function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${amount}` : `${currency.toUpperCase()} ${amount}`;
}

// ---------------------------------------------------------------------------
// THI-1585 PR (a): plain-English text fixes. Raw internal values — reason
// codes, dispute outcomes, order statuses, ISO deadlines — must never reach
// an inbox: each renders through the maps below in plain English, and an
// unknown code falls back to neutral copy, never the raw code. The maps
// cover exactly what the fan-out emits (src/notify/fanout.ts) plus the 12
// statuses CHECK-constrained in db/schema.sql. Moderator reasons are free
// text and stay untouched (seller.item_taken_down, buyer.review_hidden).
// Formatting is deterministic — no Intl/ICU (same standard as formatMoney);
// deadlines render in UTC with an explicit suffix so snapshots never drift.

/** The 12 order statuses of db/schema.sql → user-facing English. */
const ORDER_STATUS_TEXT: Record<string, string> = {
  pending: "Awaiting payment",
  sold: "Paid — awaiting shipment",
  label_issued: "Label issued — awaiting carrier pickup",
  in_transit: "In transit",
  delivered: "Delivered — dispute window open",
  disputed: "Under dispute review",
  refunding: "Refund in progress",
  refunded: "Refunded",
  payout_pending: "Seller payout scheduled",
  paid_out: "Seller paid",
  cancelled: "Cancelled",
  completed: "Completed",
};

/** Fan-out cancel/refund reason codes → user-facing English. */
const ORDER_REASON_TEXT: Record<string, string> = {
  payment_deadline_passed: "The payment deadline passed",
  you_cancelled: "You cancelled the order",
  buyer_cancelled: "The buyer cancelled the order",
  seller_cancelled: "The seller cancelled the order",
  dispute_refund: "The dispute was resolved with a refund",
  buyer_requested_refund: "The buyer requested a refund",
  you_requested_refund: "You requested a refund",
  seller_initiated_refund: "The seller initiated a refund",
  not_shipped_or_transit_issue:
    "The item was not shipped in time, or the shipment stalled in transit",
  dispute_released: "The dispute was resolved with the funds released to the seller",
};

/** Fan-out dispute outcome codes → user-facing English. */
const DISPUTE_OUTCOME_TEXT: Record<string, string> = {
  cancelled: "Refund to the buyer — order cancelled",
  refunded: "Refund to the buyer",
  released_to_seller: "Funds released to the seller",
};

export function orderStatusText(status: string): string {
  return ORDER_STATUS_TEXT[status] ?? "In progress";
}

export function orderReasonText(reason: string): string {
  return ORDER_REASON_TEXT[reason] ?? "Not specified";
}

export function disputeOutcomeText(outcome: string): string {
  return DISPUTE_OUTCOME_TEXT[outcome] ?? "Resolved";
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Deadline formatting: fixed UTC calendar format with an explicit time-zone
 *  suffix, no Intl/ICU (same determinism standard as formatMoney). Returns
 *  "" for an unparseable value so callers fall back to date-free copy — a
 *  raw timestamp never reaches the body. */
export function formatDeadlineUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Shared facts every order email states (plan §6: title, amount, status). */
interface OrderFacts {
  itemTitle: string;
  amountCents: number;
  currency: string;
  orderStatus: string;
  orderUrl: string;
  itemUrl?: string;
}

/** Subject-line hardening: subjects are plain text rendered by mail clients
 * with unknown strictness — strip angle brackets (no HTML) and CR/LF (no
 * header-injection surface, belt-and-braces even with a JSON API provider).
 * Exported for outbox-subject builders that embed DB strings (THI-780 PR 3). */
export function subjectSafe(s: string): string {
  return s.replaceAll("<", "").replaceAll(">", "").replaceAll("\r", " ").replaceAll("\n", " ");
}

function orderEmail(o: {
  subject: string;
  intro: string;
  facts: OrderFacts;
  /** Extra context lines after the facts (e.g. tracking code). */
  details?: string[];
  /** Closing note (e.g. dispute-window explanation, pay deadline). */
  outro?: string;
}): RenderedEmail {
  const { intro, facts, details = [], outro } = o;
  const subject = subjectSafe(o.subject);
  // Browse link derives from the (always absolute, server-built) order URL's
  // origin — templates receive trusted input and stay pure functions.
  const browseUrl = `${new URL(facts.orderUrl).origin}/browse`;
  const lines = [
    `Item: ${facts.itemTitle}`,
    `Amount: ${formatMoney(facts.amountCents, facts.currency)}`,
    `Order status: ${orderStatusText(facts.orderStatus)}`,
    ...details,
  ];
  const linkLines = [facts.orderUrl, ...(facts.itemUrl ? [facts.itemUrl] : []), browseUrl];
  const text =
    `${intro}\n\n` +
    lines.join("\n") +
    `\n\n${linkLines.join("\n")}\n` +
    (outro ? `\n${outro}\n` : "\n") +
    `\n— ${CANONICAL_SENTENCE}\n`;
  const html =
    `<p>${escapeHtml(intro)}</p>\n` +
    `<ul>\n${lines.map((l) => `  <li>${escapeHtml(l)}</li>`).join("\n")}\n</ul>\n` +
    `<p><a href="${escapeHtml(facts.orderUrl)}">Open the order</a> ` +
    (facts.itemUrl ? `<a href="${escapeHtml(facts.itemUrl)}">View the item</a> ` : "") +
    `<a href="${escapeHtml(browseUrl)}">Browse</a></p>\n` +
    (outro ? `<p>${escapeHtml(outro)}</p>\n` : "") +
    `<p style="color:#666;font-size:12px">— ${CANONICAL_SENTENCE}</p>\n`;
  return { subject, text, html };
}

export const ORDER_EMAIL_KEYS = [
  "buyer.order_placed",
  "buyer.payment_deadline_reminder",
  "buyer.order_cancelled",
  "buyer.payment_received",
  "buyer.item_shipped",
  "buyer.order_delivered",
  "buyer.refund_initiated",
  "buyer.refund_confirmed",
  "buyer.dispute_outcome",
  "seller.off_platform_order",
  "seller.item_sold",
  "seller.order_cancelled_by_buyer",
  "seller.dispute_opened",
  "seller.chargeback",
  "seller.dispute_resolved",
  "seller.payout_paid",
] as const;
export type OrderEmailEvent = (typeof ORDER_EMAIL_KEYS)[number];
/** Template column value for an event type: `{role}.{event}.v1` (plan §6). */
export function templateKeyFor(eventType: OrderEmailEvent | string): string {
  return `${eventType}.v1`;
}

/** Payment-deadline outro: a readable UTC deadline when the payload carries
 *  one; date-free copy when it is missing/unparseable. A raw ISO timestamp
 *  never reaches the body. (THI-1585) */
function paymentOutro(paymentDeadline?: string): string | undefined {
  if (paymentDeadline === undefined) return undefined;
  const fmt = paymentDeadline ? formatDeadlineUtc(paymentDeadline) : "";
  return fmt
    ? `Complete payment by ${fmt} or the order is cancelled automatically.`
    : "Complete payment before the deadline or the order is cancelled automatically.";
}

export function renderBuyerOrderPlaced(p: OrderFacts & { paymentDeadline?: string }): RenderedEmail {
  return orderEmail({
    subject: `Order placed: ${p.itemTitle} — Thingery`,
    intro: "You placed an order on Thingery. Here are the details:",
    facts: p,
    outro: paymentOutro(p.paymentDeadline),
  });
}

export function renderBuyerPaymentDeadlineReminder(p: OrderFacts & { paymentDeadline: string }): RenderedEmail {
  return orderEmail({
    subject: `Payment deadline soon: ${p.itemTitle} — Thingery`,
    intro: "Your order is still awaiting payment. The deadline is approaching:",
    facts: p,
    outro: paymentOutro(p.paymentDeadline),
  });
}

export function renderBuyerOrderCancelled(p: OrderFacts & { reason: string }): RenderedEmail {
  return orderEmail({
    subject: `Order cancelled: ${p.itemTitle} — Thingery`,
    intro: "An order you are part of has been cancelled:",
    facts: p,
    details: [`Reason: ${orderReasonText(p.reason)}`],
    // Refund follow-up decided on the RAW reason code (the fan-out contract),
    // never on the translated display text. (THI-1585)
    outro: p.reason.toLowerCase().includes("refund")
      ? "A refund to your original payment method will follow; no action is needed."
      : undefined,
  });
}

export function renderBuyerPaymentReceived(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Payment received: ${p.itemTitle} — Thingery`,
    intro: "Your payment was received. The seller has been notified and will ship the item:",
    facts: p,
  });
}

export function renderBuyerItemShipped(p: OrderFacts & { carrier?: string; trackingCode?: string }): RenderedEmail {
  return orderEmail({
    subject: `Your item shipped: ${p.itemTitle} — Thingery`,
    intro: "The seller shipped your order:",
    facts: p,
    details: [
      ...(p.carrier ? [`Carrier: ${p.carrier}`] : []),
      ...(p.trackingCode ? [`Tracking code: ${p.trackingCode}`] : []),
    ],
  });
}

export function renderBuyerOrderDelivered(p: OrderFacts & { disputeWindowHours: number }): RenderedEmail {
  return orderEmail({
    subject: `Delivered: ${p.itemTitle} — Thingery`,
    intro: "Your order was marked delivered:",
    facts: p,
    outro:
      `If something is wrong, open a dispute within ${p.disputeWindowHours} hours of delivery ` +
      `from the order page — after that the sale is final.`,
  });
}

export function renderBuyerRefundInitiated(p: OrderFacts & { reason: string }): RenderedEmail {
  return orderEmail({
    subject: `Refund initiated: ${p.itemTitle} — Thingery`,
    intro: "A refund has been initiated for your order:",
    facts: p,
    details: [`Reason: ${orderReasonText(p.reason)}`],
    outro: "The refund is processing; no action is needed.",
  });
}

export function renderBuyerRefundConfirmed(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Refund completed: ${p.itemTitle} — Thingery`,
    intro: "Your refund has completed. The amount returns to your original payment method:",
    facts: p,
  });
}

export function renderBuyerDisputeOutcome(p: OrderFacts & { outcome: string }): RenderedEmail {
  return orderEmail({
    subject: `Dispute resolved: ${p.itemTitle} — Thingery`,
    intro: "Your dispute has been resolved:",
    facts: p,
    details: [`Outcome: ${disputeOutcomeText(p.outcome)}`],
    outro: "The order page shows the final state of the order.",
  });
}

export function renderSellerOffPlatformOrder(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `New order awaiting confirmation: ${p.itemTitle} — Thingery`,
    intro: "A buyer placed an off-platform order for your item and it awaits your confirmation:",
    facts: p,
  });
}

export function renderSellerItemSold(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Sold: ${p.itemTitle} — Thingery`,
    intro: "Your item sold. Payment was received — time to ship:",
    facts: p,
    outro: "Record tracking on the order page so the buyer can follow the shipment.",
  });
}

export function renderSellerOrderCancelledByBuyer(p: OrderFacts & { reason: string }): RenderedEmail {
  return orderEmail({
    subject: `Order cancelled by buyer: ${p.itemTitle} — Thingery`,
    intro: "A buyer cancelled an order for your item:",
    facts: p,
    details: [`Reason: ${orderReasonText(p.reason)}`],
    // Refund follow-up decided on the RAW reason code, never the translated
    // display text. (THI-1585)
    outro: p.reason.toLowerCase().includes("refund")
      ? "A refund to the buyer will follow automatically; no action is needed."
      : undefined,
  });
}

export function renderSellerDisputeOpened(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Dispute opened: ${p.itemTitle} — Thingery`,
    intro: "The buyer opened a dispute on this order:",
    facts: p,
    outro: "Open the order page to review the case. Disputes are resolved by Thingery admins.",
  });
}

export function renderSellerChargeback(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Chargeback filed: ${p.itemTitle} — Thingery`,
    intro: "A chargeback was filed on this order:",
    facts: p,
    outro: "Thingery will represent the case with the recorded evidence. No action is needed unless we contact you.",
  });
}

export function renderSellerDisputeResolved(p: OrderFacts & { outcome: string }): RenderedEmail {
  return orderEmail({
    subject: `Dispute resolved: ${p.itemTitle} — Thingery`,
    intro: "The dispute on this order has been resolved:",
    facts: p,
    details: [`Outcome: ${disputeOutcomeText(p.outcome)}`],
  });
}

export function renderSellerPayoutPaid(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Payout sent: ${p.itemTitle} — Thingery`,
    intro: "Your payout for this sale was sent to your connected account:",
    facts: p,
  });
}

// THI-780 PR 3: item/account-level events (plan §6). All orders-class
// (prefs-gated transactional), PII-free bodies.

/** `seller.payouts_enabled.v1` — account.updated flipped transfers on. */
export function renderSellerPayoutsEnabled(): RenderedEmail {
  const subject = "Payouts enabled — Thingery";
  const text =
    "Your payout account is set up. Money from your sales can now reach you automatically.\n\n" +
    `— ${CANONICAL_SENTENCE}\n`;
  const html =
    "<p>Your payout account is set up. Money from your sales can now reach you automatically.</p>\n" +
    `<p style="color:#666;font-size:12px">— ${CANONICAL_SENTENCE}</p>\n`;
  return { subject, text, html };
}

/** `seller.stale_sale_warning.v1` / `seller.stuck_transit_warning.v1` — the
 * sweep's early warning before the hard deadline cancels/refunds. */
export function renderSellerDeadlineWarning(p: OrderFacts & { kind: "stale_sale" | "stuck_transit" }): RenderedEmail {
  const intro =
    p.kind === "stale_sale"
      ? "You sold this item but no shipping has been recorded. If nothing is shipped in time, the order is cancelled and the buyer refunded automatically."
      : "This shipment has not moved for a while. If no carrier event arrives in time, the order is refunded to the buyer automatically.";
  return orderEmail({
    subject:
      p.kind === "stale_sale"
        ? `Action needed: ship your sale — ${p.itemTitle} — Thingery`
        : `Shipping stalled: ${p.itemTitle} — Thingery`,
    intro,
    facts: p,
  });
}

/** `seller.item_taken_down.v1` — moderation removed a listing. */
export function renderSellerItemTakenDown(p: { itemTitle: string; itemUrl: string; reason: string }): RenderedEmail {
  const subject = subjectSafe(`Listing removed: ${p.itemTitle} — Thingery`);
  const lines = [`Item: ${p.itemTitle}`, `Reason: ${p.reason}`];
  const text =
    "A moderator removed your listing from Thingery:\n\n" +
    lines.join("\n") +
    `\n\n${p.itemUrl}\n\n` +
    `If you believe this was a mistake, contact the marketplace operators.\n\n` +
    `— ${CANONICAL_SENTENCE}\n`;
  const html =
    "<p>A moderator removed your listing from Thingery:</p>\n" +
    `<ul>\n${lines.map((l) => `  <li>${escapeHtml(l)}</li>`).join("\n")}\n</ul>\n` +
    `<p><a href="${escapeHtml(p.itemUrl)}">View the item</a></p>\n` +
    `<p>If you believe this was a mistake, contact the marketplace operators.</p>\n` +
    `<p style="color:#666;font-size:12px">— ${CANONICAL_SENTENCE}</p>\n`;
  return { subject, text, html };
}

/** `buyer.review_hidden.v1` — moderation hid a review the buyer wrote
 *  (order-reviews spec PR 3). */
export function renderBuyerReviewHidden(p: { itemTitle: string; sellerUrl: string; reason: string }): RenderedEmail {
  const subject = subjectSafe(`Review removed: ${p.itemTitle} — Thingery`);
  const lines = [`Item: ${p.itemTitle}`, `Reason: ${p.reason}`];
  const text =
    "A moderator removed your review from Thingery:\n\n" +
    lines.join("\n") +
    `\n\n${p.sellerUrl}\n\n` +
    `If you believe this was a mistake, contact the marketplace operators.\n\n` +
    `— ${CANONICAL_SENTENCE}\n`;
  const html =
    "<p>A moderator removed your review from Thingery:</p>\n" +
    `<ul>\n${lines.map((l) => `  <li>${escapeHtml(l)}</li>`).join("\n")}\n</ul>\n` +
    `<p><a href="${escapeHtml(p.sellerUrl)}">View the seller page</a></p>\n` +
    "<p>If you believe this was a mistake, contact the marketplace operators.</p>\n" +
    `<p style="color:#666;font-size:12px">— ${CANONICAL_SENTENCE}</p>\n`;
  return { subject, text, html };
}

/** `operator.*.v1` — internal alerts (THI-780 PR 4). Plain, id-first,
 * PII-free: ids, statuses, error strings only. */
export function renderOperatorAlert(p: { title: string; lines: string[] }): RenderedEmail {
  const subject = subjectSafe(p.title);
  const text = p.lines.join("\n") + `\n\n— ${CANONICAL_SENTENCE}\n`;
  const html =
    `<p>${escapeHtml(p.title)}</p>\n<ul>\n${p.lines.map((l) => `  <li>${escapeHtml(l)}</li>`).join("\n")}\n</ul>\n` +
    `<p style="color:#666;font-size:12px">— ${CANONICAL_SENTENCE}</p>\n`;
  return { subject, text, html };
}

/** Registry: a notification payload (the PII-free JSONB the fan-out stores)
 *  → the rendered email for its event type, with deep links built from the
 *  deployment base URL. One source of truth for content: fan-out stores the
 *  subject snapshot, the delivery sweep renders subject+body identically.
 *  Unknown keys throw — the fan-out only emits ORDER_EMAIL_KEYS events, so an
 *  unknown key is a programming error to surface, not silently mail. */
export function renderOrderEmail(
  eventType: string,
  payload: Record<string, unknown>,
  baseUrl: string,
): RenderedEmail {
  const str = (k: string): string | undefined => (typeof payload[k] === "string" ? (payload[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof payload[k] === "number" ? (payload[k] as number) : undefined);
  // THI-780 PR 2: digest rows carry their own payload shape (items list),
  // not order facts.
  if (eventType === "digest.daily" || eventType === "digest.weekly") {
    return renderDigest({
      frequency: eventType === "digest.daily" ? "daily" : "weekly",
      count: num("count") ?? 0,
      items: Array.isArray(payload.items)
        ? (payload.items as Array<Record<string, unknown>>).map((it) => ({
            eventType: typeof it.event_type === "string" ? it.event_type : "",
            itemTitle: typeof it.item_title === "string" ? it.item_title : undefined,
            url: typeof it.url === "string" ? it.url : undefined,
          }))
        : [],
      unsubscribeUrl: str("unsubscribe_url") ?? baseUrl,
    });
  }
  const facts: OrderFacts = {
    itemTitle: str("item_title") ?? "",
    amountCents: num("amount_cents") ?? 0,
    currency: str("currency") ?? "EUR",
    orderStatus: str("order_status") ?? "",
    orderUrl: str("order_id") ? `${baseUrl}/order/${payload.order_id}` : baseUrl,
    itemUrl: str("item_id") ? `${baseUrl}/item/${payload.item_id}` : undefined,
  };
  switch (eventType) {
    case "buyer.order_placed":
      return renderBuyerOrderPlaced({ ...facts, paymentDeadline: str("payment_deadline") });
    case "buyer.payment_deadline_reminder":
      return renderBuyerPaymentDeadlineReminder({ ...facts, paymentDeadline: str("payment_deadline") ?? "" });
    case "buyer.order_cancelled":
      return renderBuyerOrderCancelled({ ...facts, reason: str("reason") ?? "" });
    case "buyer.payment_received":
      return renderBuyerPaymentReceived(facts);
    case "buyer.item_shipped":
      return renderBuyerItemShipped({ ...facts, carrier: str("carrier"), trackingCode: str("tracking_code") });
    case "buyer.order_delivered":
      return renderBuyerOrderDelivered({ ...facts, disputeWindowHours: num("dispute_window_hours") ?? 48 });
    case "buyer.refund_initiated":
      return renderBuyerRefundInitiated({ ...facts, reason: str("reason") ?? "" });
    case "buyer.refund_confirmed":
      return renderBuyerRefundConfirmed(facts);
    case "buyer.dispute_outcome":
      return renderBuyerDisputeOutcome({ ...facts, outcome: str("outcome") ?? "" });
    case "seller.off_platform_order":
      return renderSellerOffPlatformOrder(facts);
    case "seller.item_sold":
      return renderSellerItemSold(facts);
    case "seller.order_cancelled_by_buyer":
      return renderSellerOrderCancelledByBuyer({ ...facts, reason: str("reason") ?? "" });
    case "seller.dispute_opened":
      return renderSellerDisputeOpened(facts);
    case "seller.chargeback":
      return renderSellerChargeback(facts);
    case "seller.dispute_resolved":
      return renderSellerDisputeResolved({ ...facts, outcome: str("outcome") ?? "" });
    case "seller.payout_paid":
      return renderSellerPayoutPaid(facts);
    // THI-780 PR 3: item/account-level events.
    case "seller.payouts_enabled":
      return renderSellerPayoutsEnabled();
    case "seller.stale_sale_warning":
      return renderSellerDeadlineWarning({ ...facts, kind: "stale_sale" });
    case "seller.stuck_transit_warning":
      return renderSellerDeadlineWarning({ ...facts, kind: "stuck_transit" });
    case "seller.item_taken_down":
      return renderSellerItemTakenDown({
        itemTitle: str("item_title") ?? "",
        itemUrl: str("item_id") ? `${baseUrl}/item/${payload.item_id}` : baseUrl,
        reason: str("reason") ?? "policy violation",
      });
    // Order-reviews spec PR 3: moderation hid one of the buyer's reviews.
    case "buyer.review_hidden":
      return renderBuyerReviewHidden({
        itemTitle: str("item_title") ?? "",
        sellerUrl: str("seller_id") ? `${baseUrl}/seller/${payload.seller_id}` : baseUrl,
        reason: str("reason") ?? "policy violation",
      });
    // THI-780 PR 4: operator alerts — account-less rows, bypass account
    // gates (an operator address is not a marketplace account).
    // THI-1537 adds the bounce-suppression observability pair
    // (suppression_self / suppression_volume — src/webhooks-resend.ts).
    case "operator.stuck_money":
    case "operator.stale_dispute":
    case "operator.dead_letter":
    case "operator.suppression_self":
    case "operator.suppression_volume": {
      const lines = Array.isArray(payload.lines)
        ? (payload.lines as unknown[]).map(String)
        : [];
      return renderOperatorAlert({ title: str("title") ?? "Thingery operator alert", lines });
    }
    // THI-1451 (THI-1479 plan Phase C): item-report mirror to the report
    // alias — account-less row, bypasses account gates for the same reason
    // operator.* does. Same PII-minimal discipline: ids, reason slug,
    // timestamp only; the motivation free-text (UNTRUSTED user content)
    // never enters the payload, so it can never leak into the mail body.
    case "ops.item_reported": {
      const itemId = str("item_id") ?? "";
      return renderOperatorAlert({
        title: "New item report — Thingery",
        lines: [
          `Report: ${str("report_id") ?? "?"}`,
          `Item: ${itemId ? `${baseUrl}/item/${itemId}` : "?"}`, 
          `Reason: ${str("reason") ?? "?"}`,
          `Reported at: ${str("created_at") ?? "?"}`,
        ],
      });
    }
    default:
      throw new Error(`renderOrderEmail: unknown event type ${eventType}`);
  }
}
