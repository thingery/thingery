// THI-760 plan Phase 1 / THI-763, PR 2: order email templates. Snapshot-style
// assertions (subject/body content, deep links, canonical footer) and the F6
// no-PII rule: emails carry item title, amount, status and links ONLY — tests
// assert no address-like or contact-like content can appear, and that HTML
// escapes user-controlled values (item title). Pure functions — no DB.

import { describe, expect, it } from "vitest";
import {
  ORDER_EMAIL_KEYS,
  formatMoney,
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
      renderBuyerOrderPlaced({ ...facts, payUrl: `${BASE}/order/x#pay`, paymentDeadline: "2026-11-20 12:00 UTC" }),
      renderBuyerPaymentDeadlineReminder({ ...facts, payUrl: `${BASE}/order/x#pay`, paymentDeadline: "2026-11-20 12:00 UTC" }),
      renderBuyerOrderCancelled({ ...facts, reason: "payment_expired" }),
      renderBuyerPaymentReceived(facts),
      renderBuyerItemShipped({ ...facts, carrier: "DHL", trackingCode: "9400111899223197428490" }),
      renderBuyerOrderDelivered({ ...facts, disputeWindowHours: 48 }),
      renderBuyerRefundInitiated({ ...facts, reason: "carrier_failure" }),
      renderBuyerRefundConfirmed(facts),
      renderBuyerDisputeOutcome({ ...facts, outcome: "refunded" }),
      renderSellerOffPlatformOrder(facts),
      renderSellerItemSold(facts),
      renderSellerOrderCancelledByBuyer({ ...facts, reason: "buyer_cancelled_refund" }),
      renderSellerDisputeOpened(facts),
      renderSellerChargeback(facts),
      renderSellerDisputeResolved({ ...facts, outcome: "released" }),
      renderSellerPayoutPaid(facts),
    ];
    expect(cases).toHaveLength(ORDER_EMAIL_KEYS.length);
    for (const email of cases) {
      expect(email.subject).toContain("Thingery");
      for (const body of [email.text, email.html]) {
        expect(body).toContain("Vintage denim jacket");
        expect(body).toContain("€12.34");
        expect(body).toContain("sold");
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
    const placed = renderBuyerOrderPlaced({ ...facts, payUrl: "https://thingery.dev/pay/cs_test", paymentDeadline: "2026-11-20 12:00 UTC" });
    expect(placed.subject).toBe("Order placed: Vintage denim jacket — Thingery");
    expect(placed.text).toContain("Pay here: https://thingery.dev/pay/cs_test");
    expect(placed.text).toContain("Complete payment by 2026-11-20 12:00 UTC");
    const delivered = renderBuyerOrderDelivered({ ...facts, disputeWindowHours: 48 });
    expect(delivered.text).toContain("open a dispute within 48 hours");
    const shipped = renderBuyerItemShipped({ ...facts, carrier: "DHL", trackingCode: "TRACK123" });
    expect(shipped.text).toContain("Tracking code: TRACK123");
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
});
