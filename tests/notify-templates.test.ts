// THI-760 plan Phase 1 / THI-763, PR 2: order email templates. Snapshot-style
// assertions (subject/body content, deep links, canonical footer) and the F6
// no-PII rule: emails carry item title, amount, status and links ONLY — tests
// assert no address-like or contact-like content can appear, and that HTML
// escapes user-controlled values (item title). Pure functions — no DB.

import { describe, expect, it } from "vitest";
import {
  ORDER_EMAIL_KEYS,
  formatMoney,
  formatDeadlineUtc,
  templateKeyFor,
  renderBuyerOrderPlaced,
  renderBuyerPaymentDeadlineReminder,
  renderBuyerOrderCancelled,
  renderBuyerPaymentReceived,
  renderBuyerItemShipped,
  renderBuyerOrderDelivered,
  renderBuyerRefundInitiated,
  renderBuyerRefundConfirmed,
  renderBuyerDisputeOutcome,
  renderSellerOffPlatformOrder,
  renderSellerItemSold,
  renderSellerOrderCancelledByBuyer,
  renderSellerDisputeOpened,
  renderSellerChargeback,
  renderSellerDisputeResolved,
  renderSellerPayoutPaid,
  renderOrderEmail,
} from "../src/notify/templates.js";

const BASE = "https://thingery.dev";
const facts = {
  itemTitle: "Vintage denim jacket",
  amountCents: 1234,
  currency: "EUR",
  orderStatus: "sold",
  orderUrl: `${BASE}/order/00000000-0000-0000-0000-000000000001`,
  itemUrl: `${BASE}/item/00000000-0000-0000-0000-000000000002`,
};
const CANONICAL =
  "Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.";

describe("order email templates (THI-763 PR 2)", () => {
  it("every event key renders with subject, facts, all three deep links, footer", () => {
    const cases = [
      renderBuyerOrderPlaced({ ...facts, paymentDeadline: "2026-11-20T12:00:00.000Z" }),
      renderBuyerPaymentDeadlineReminder({ ...facts, paymentDeadline: "2026-11-20T12:00:00.000Z" }),
      renderBuyerOrderCancelled({ ...facts, reason: "payment_deadline_passed" }),
      renderBuyerPaymentReceived(facts),
      renderBuyerItemShipped({ ...facts, carrier: "DHL", trackingCode: "9400111899223197428490" }),
      renderBuyerOrderDelivered({ ...facts, disputeWindowHours: 48 }),
      renderBuyerRefundInitiated({ ...facts, reason: "not_shipped_or_transit_issue" }),
      renderBuyerRefundConfirmed(facts),
      renderBuyerDisputeOutcome({ ...facts, outcome: "refunded" }),
      renderSellerOffPlatformOrder(facts),
      renderSellerItemSold(facts),
      renderSellerOrderCancelledByBuyer({ ...facts, reason: "buyer_requested_refund" }),
      renderSellerDisputeOpened(facts),
      renderSellerChargeback(facts),
      renderSellerDisputeResolved({ ...facts, outcome: "released_to_seller" }),
      renderSellerPayoutPaid(facts),
    ];
    expect(cases).toHaveLength(ORDER_EMAIL_KEYS.length);
    for (const email of cases) {
      expect(email.subject).toContain("Thingery");
      for (const body of [email.text, email.html]) {
        expect(body).toContain("Vintage denim jacket");
        expect(body).toContain("€12.34");
        expect(body).toContain("Paid — awaiting shipment");
        expect(body).toContain(`${BASE}/order/00000000-0000-0000-0000-000000000001`);
        expect(body).toContain(`${BASE}/item/00000000-0000-0000-0000-000000000002`);
        expect(body).toContain(`${BASE}/browse`);
        expect(body).toContain(CANONICAL);
      }
    }
  });

  it("snapshot: representative subjects and bodies are stable", () => {
    const sold = renderSellerItemSold(facts);
    expect(sold.subject).toBe("Sold: Vintage denim jacket — Thingery");
    expect(sold.text).toContain("Your item sold. Payment was received — time to ship:");
    expect(sold.text).toContain("Amount: €12.34");
    const placed = renderBuyerOrderPlaced({ ...facts, paymentDeadline: "2026-11-20T12:00:00.000Z" });
    expect(placed.subject).toBe("Order placed: Vintage denim jacket — Thingery");
    expect(placed.text).toContain("Complete payment by 20 Nov 2026, 12:00 UTC");
    expect(placed.text).not.toContain("Pay here");
    expect(placed.text).not.toContain("2026-11-20T");
    const delivered = renderBuyerOrderDelivered({ ...facts, disputeWindowHours: 48 });
    expect(delivered.text).toContain("open a dispute within 48 hours");
    const shipped = renderBuyerItemShipped({ ...facts, carrier: "DHL", trackingCode: "TRACK123" });
    expect(shipped.text).toContain("Tracking code: TRACK123");
  });

  it("raw codes never reach the body: reasons, outcomes and statuses translate (THI-1585)", () => {
    const cancelled = renderBuyerOrderCancelled({ ...facts, reason: "payment_deadline_passed" });
    expect(cancelled.text).toContain("Reason: The payment deadline passed");
    expect(cancelled.text).not.toContain("payment_deadline_passed");
    // The refund-outro decision stays on the RAW code; the display text is
    // the translation.
    const buyerRefund = renderBuyerOrderCancelled({ ...facts, orderStatus: "refunding", reason: "you_requested_refund" });
    expect(buyerRefund.text).toContain("Reason: You requested a refund");
    expect(buyerRefund.text).toContain("A refund to your original payment method will follow");
    expect(buyerRefund.text).not.toContain("you_requested_refund");
    const sellerRefund = renderSellerOrderCancelledByBuyer({ ...facts, reason: "buyer_requested_refund" });
    expect(sellerRefund.text).toContain("Reason: The buyer requested a refund");
    expect(sellerRefund.text).toContain("A refund to the buyer will follow automatically");
    // Unknown codes fall back to neutral copy — never the raw code — and do
    // not trip the raw-code refund heuristic.
    const unknown = renderBuyerOrderCancelled({ ...facts, reason: "mystery_code_42" });
    expect(unknown.text).toContain("Reason: Not specified");
    expect(unknown.text).not.toContain("mystery_code_42");
    expect(unknown.text).not.toContain("A refund");
    // Statuses translate; label_issued never renders as a shipping claim.
    const shipped = renderBuyerItemShipped({ ...facts, orderStatus: "label_issued" });
    expect(shipped.text).toContain("Order status: Label issued — awaiting carrier pickup");
    expect(shipped.text).not.toContain("label_issued");
    const unknownStatus = renderSellerItemSold({ ...facts, orderStatus: "status_from_the_future" });
    expect(unknownStatus.text).toContain("Order status: In progress");
    expect(unknownStatus.text).not.toContain("status_from_the_future");
    // Dispute outcomes translate.
    const outcome = renderBuyerDisputeOutcome({ ...facts, outcome: "released_to_seller" });
    expect(outcome.text).toContain("Outcome: Funds released to the seller");
    expect(outcome.text).not.toContain("released_to_seller");
    const sellerOutcome = renderSellerDisputeResolved({ ...facts, outcome: "cancelled" });
    expect(sellerOutcome.text).toContain("Outcome: Refund to the buyer — order cancelled");
  });

  it("deadline renders as readable UTC, deterministic, never raw (THI-1585)", () => {
    const reminder = renderBuyerPaymentDeadlineReminder({ ...facts, paymentDeadline: "2026-11-20T12:00:00.000Z" });
    expect(reminder.text).toContain("Complete payment by 20 Nov 2026, 12:00 UTC");
    expect(reminder.text).not.toContain("2026-11-20T");
    // Unparseable values degrade to date-free copy, never raw output.
    const bad = renderBuyerPaymentDeadlineReminder({ ...facts, paymentDeadline: "not-a-date" });
    expect(bad.text).toContain("Complete payment before the deadline or the order is cancelled automatically.");
    expect(bad.text).not.toContain("not-a-date");
    // Deterministic — no Intl/ICU drift (same standard as formatMoney).
    expect(formatDeadlineUtc("2026-03-05T07:05:00Z")).toBe("5 Mar 2026, 07:05 UTC");
    expect(formatDeadlineUtc("not-a-date")).toBe("");
  });

  it("F6 no-PII: no address or contact fields exist in any rendered body", () => {
    // The template param types admit only title/amount/status/urls/tracking;
    // nothing feeds an address or counterparty contact value in. The
    // assertions below pin that for every key at once.
    const all = [
      renderBuyerOrderPlaced(facts).text + renderBuyerOrderPlaced(facts).html,
      renderBuyerPaymentDeadlineReminder({ ...facts, paymentDeadline: "x" }).text,
      renderBuyerOrderCancelled({ ...facts, reason: "payment_expired" }).text,
      renderBuyerPaymentReceived(facts).text,
      renderBuyerItemShipped(facts).text,
      renderBuyerOrderDelivered({ ...facts, disputeWindowHours: 48 }).text,
      renderBuyerRefundInitiated({ ...facts, reason: "r" }).text,
      renderBuyerRefundConfirmed(facts).text,
      renderBuyerDisputeOutcome({ ...facts, outcome: "refunded" }).text,
      renderSellerOffPlatformOrder(facts).text,
      renderSellerItemSold(facts).text,
      renderSellerOrderCancelledByBuyer({ ...facts, reason: "r" }).text,
      renderSellerDisputeOpened(facts).text,
      renderSellerChargeback(facts).text,
      renderSellerDisputeResolved({ ...facts, outcome: "released" }).text,
      renderSellerPayoutPaid(facts).text,
    ];
    const banned = [
      "shipping_address", "shipping address", "street", "postal", "zip",
      "phone", "tel:", "mailto:", "@example.", "buyer@",
    ];
    for (const [i, body] of all.entries()) {
      for (const marker of banned) {
        expect(body.toLowerCase(), `template #${i} leaked "${marker}"`).not.toContain(marker);
      }
    }
  });

  it("HTML escapes user-controlled item titles (injection-safe)", () => {
    const hostile = renderSellerItemSold({ ...facts, itemTitle: `<script>alert("x")</script> & Co` });
    expect(hostile.html).not.toContain("<script>");
    expect(hostile.html).toContain("&lt;script&gt;");
    expect(hostile.html).toContain("&amp; Co");
    expect(hostile.subject).not.toContain("<script>");
  });

  it("money formatting is deterministic (no Intl/ICU drift)", () => {
    expect(formatMoney(1234, "EUR")).toBe("€12.34");
    expect(formatMoney(5, "USD")).toBe("$0.05");
    expect(formatMoney(99999, "CHF")).toBe("Fr 999.99");
    expect(formatMoney(1000, "SEK")).toBe("SEK 10.00");
    expect(formatMoney(0, "EUR")).toBe("€0.00");
  });

  it("template keys follow {role}.{event}.v1 for every Phase-1 event", () => {
    expect(templateKeyFor("seller.item_sold")).toBe("seller.item_sold.v1");
    for (const key of ORDER_EMAIL_KEYS) {
      expect(key).toMatch(/^(buyer|seller)\.[a-z_]+$/);
      expect(templateKeyFor(key)).toBe(`${key}.v1`);
    }
  });

  it("approved layout: table-based, one hosted logo from the base URL, escaped panel (THI-1586)", () => {
    const sold = renderSellerItemSold(facts);
    // Table-based, inline styles: no flexbox/SVG/web-font loading anywhere.
    expect(sold.html).toContain("<table");
    expect(sold.html).not.toMatch(/display:\s*flex|<svg|@font-face|<link/i);
    // One image: the Thread mark, hosted from the deployment's own base URL
    // (self-hosters never reference thingery.dev) with alt text.
    expect(sold.html.match(/<img /g)).toHaveLength(1);
    expect(sold.html).toContain('src="https://thingery.dev/assets/email-logo.png"');
    expect(sold.html).toContain('alt="Thingery"');
    // White panel carries the facts; mono amount; divider color from the spec.
    expect(sold.html).toContain("Paid — awaiting shipment");
    expect(sold.html).toContain("Martian Mono");
    expect(sold.html).toContain("#D9DAD6");
    // One primary button (yellow, ink text) + secondary links.
    expect(sold.html.match(/border-radius:6px/g)).toHaveLength(2);
    expect(sold.html).toContain(">Open the order</a>");
    expect(sold.html).toContain(">View the item</a>");
    expect(sold.html).toContain(">Browse</a>");
    // Footer: support line + canonical sentence under the 2px ink rule.
    expect(sold.html).toContain("Questions? Reply to this email and it reaches support.");
    expect(sold.html).toContain("border-top:2px solid #14151A");
    // renderOrderEmail passes the deployment base URL through to the logo.
    const viaRegistry = renderOrderEmail(
      "seller.item_sold",
      {
        item_title: facts.itemTitle,
        amount_cents: facts.amountCents,
        currency: facts.currency,
        order_status: facts.orderStatus,
        order_id: "o1",
        item_id: "i1",
      },
      BASE,
    );
    expect(viaRegistry.html).toContain(`src="${BASE}/assets/email-logo.png"`);
  });
});
