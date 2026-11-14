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
 * header-injection surface, belt-and-braces even with a JSON API provider). */
function subjectSafe(s: string): string {
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
    `Order status: ${facts.orderStatus}`,
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

export function renderBuyerOrderPlaced(p: OrderFacts & { payUrl?: string; paymentDeadline?: string }): RenderedEmail {
  return orderEmail({
    subject: `Order placed: ${p.itemTitle} — Thingery`,
    intro: "You placed an order on Thingery. Here are the details:",
    facts: p,
    details: p.payUrl ? [`Pay here: ${p.payUrl}`] : [],
    outro: p.paymentDeadline ? `Complete payment by ${p.paymentDeadline} or the order is cancelled automatically.` : undefined,
  });
}

export function renderBuyerPaymentDeadlineReminder(p: OrderFacts & { payUrl?: string; paymentDeadline: string }): RenderedEmail {
  return orderEmail({
    subject: `Payment deadline soon: ${p.itemTitle} — Thingery`,
    intro: "Your order is still awaiting payment. The deadline is approaching:",
    facts: p,
    details: p.payUrl ? [`Pay here: ${p.payUrl}`] : [],
    outro: `Complete payment by ${p.paymentDeadline} or the order is cancelled automatically.`,
  });
}

export function renderBuyerOrderCancelled(p: OrderFacts & { reason: string }): RenderedEmail {
  return orderEmail({
    subject: `Order cancelled: ${p.itemTitle} — Thingery`,
    intro: "An order you are part of has been cancelled:",
    facts: p,
    details: [`Reason: ${p.reason}`],
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
    details: [`Reason: ${p.reason}`],
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
    details: [`Outcome: ${p.outcome}`],
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
    details: [`Reason: ${p.reason}`],
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
    details: [`Outcome: ${p.outcome}`],
  });
}

export function renderSellerPayoutPaid(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Payout sent: ${p.itemTitle} — Thingery`,
    intro: "Your payout for this sale was sent to your connected account:",
    facts: p,
  });
}
