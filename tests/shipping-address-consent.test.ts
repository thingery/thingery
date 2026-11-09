// Off-platform orders release shipping_address only after the buyer agrees for
// that order; Stripe-mode orders keep the rules in seller-shipping-address.test.ts.
// The pool is faked, so every branch and state boundary runs without a database;
// the real SQL is covered in tests/order-tools.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { withToolResultLogging } from "../src/analytics.js";
import { pool, type SellerRow } from "../src/db.js";
import { ORDER_STATUSES, type OrderRow, type OrderStatus } from "../src/orders.js";
import {
  OrderFlowError,
  shareShippingAddress,
  shippingAddressConsent,
  shippingAddressForSeller,
} from "../src/order-flow.js";
import { registerTools } from "../src/tools.js";

const SELLER_ID = "11111111-1111-4111-8111-111111111111";
const BUYER_ID = "22222222-2222-4222-8222-222222222222";
const STRANGER_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";
const SHARED_AT = new Date("2026-02-02T00:00:00Z");

const ADDRESS_MARKER = "Example Consent Street";
const address = { name: "Fixture Recipient", line1: `1 ${ADDRESS_MARKER}`, city: "Testville", postal_code: "00000", country: "ZZ" };

const OPEN_STATES: readonly OrderStatus[] = ["sold", "label_issued"];
const CLOSED_STATES = ORDER_STATUSES.filter((status) => !OPEN_STATES.includes(status));

type OrderFixture = OrderRow & { item_title: string; payment_url: string | null };

function offPlatformOrder(status: OrderStatus, overrides: Partial<OrderRow> = {}): OrderFixture {
  const at = new Date("2026-01-01T00:00:00Z");
  return {
    id: ORDER_ID, item_id: "55555555-5555-4555-8555-555555555555",
    seller_id: SELLER_ID, buyer_id: BUYER_ID, status, payment_mode: "off_platform",
    price_cents: 1000, shipping_price_cents: 100, currency: "EUR", fulfillment: "shipping",
    shipping_address: address, carrier: null, tracking_code: null, tracker_id: null, label_url: null,
    shipping_address_shared_at: null,
    checkout_session_id: null, payment_intent_id: null, transfer_id: null, refund_id: null,
    payment_deadline: null, dispute_deadline: null, status_changed_at: at, created_at: at, updated_at: at,
    item_title: "Fixture item", payment_url: null, ...overrides,
  };
}

interface FakeQuery { sql: string; params: unknown[] }

/** Fakes the pool. `rows` answers each SELECT in turn; the last answer repeats. */
function fakePool(rows: Array<OrderRow | undefined>) {
  const queries: FakeQuery[] = [];
  let selects = 0;
  vi.spyOn(pool, "query").mockImplementation((async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    if (!sql.trimStart().startsWith("SELECT")) return { rows: [], rowCount: 1 };
    const row = rows[Math.min(selects, rows.length - 1)];
    selects += 1;
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }) as never);
  return { queries, writes: () => queries.filter(({ sql }) => !sql.trimStart().startsWith("SELECT")) };
}

interface ToolResult { isError?: boolean; content: { text: string }[] }
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function toolsFor(callerId: string | null, wrap = false) {
  const tools = new Map<string, { description: string; handler: ToolHandler }>();
  const server = {
    registerTool(name: string, config: { description: string }, handler: ToolHandler) {
      tools.set(name, { description: config.description, handler });
    },
  };
  const ctx = { seller: callerId ? ({ id: callerId } as SellerRow) : null };
  registerTools(wrap ? withToolResultLogging(server, ctx) : server, ctx);
  return tools;
}

async function callTool(name: string, callerId: string | null, wrap = false) {
  const result = await toolsFor(callerId, wrap).get(name)!.handler({ order_id: ORDER_ID });
  return { result, raw: result.content[0].text, body: JSON.parse(result.content[0].text) };
}

async function expectRefusal(buyerId: string, code: string) {
  const refusal = await shareShippingAddress(ORDER_ID, buyerId).catch((e: unknown) => e);
  expect(refusal).toBeInstanceOf(OrderFlowError);
  expect((refusal as OrderFlowError).code).toBe(code);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shippingAddressForSeller on off-platform orders", () => {
  it.each(OPEN_STATES)("withholds the address in %s until the buyer agrees", (status) => {
    expect(shippingAddressForSeller(offPlatformOrder(status), SELLER_ID)).toBeNull();
  });

  it.each(OPEN_STATES)("releases the address in %s after the buyer agrees", (status) => {
    const shared = offPlatformOrder(status, { shipping_address_shared_at: SHARED_AT });
    expect(shippingAddressForSeller(shared, SELLER_ID)).toEqual(address);
  });

  it.each(CLOSED_STATES)("consent does not widen the release to %s", (status) => {
    const shared = offPlatformOrder(status, { shipping_address_shared_at: SHARED_AT });
    expect(shippingAddressForSeller(shared, SELLER_ID)).toBeNull();
  });

  it("consent never releases it to the buyer or another account", () => {
    const shared = offPlatformOrder("sold", { shipping_address_shared_at: SHARED_AT });
    expect(shippingAddressForSeller(shared, BUYER_ID)).toBeNull();
    expect(shippingAddressForSeller(shared, STRANGER_ID)).toBeNull();
  });

  it("fails closed for a mode other than stripe", () => {
    const unknownMode = offPlatformOrder("sold", { payment_mode: "something_new" as OrderRow["payment_mode"] });
    expect(shippingAddressForSeller(unknownMode, SELLER_ID)).toBeNull();
  });

  it.each(OPEN_STATES)("Stripe-mode orders release in %s with no consent", (status) => {
    expect(shippingAddressForSeller(offPlatformOrder(status, { payment_mode: "stripe" }), SELLER_ID)).toEqual(address);
  });
});

describe("shippingAddressConsent", () => {
  it.each(OPEN_STATES)("tells each party consent is awaited in %s, in its own words", (status) => {
    const order = offPlatformOrder(status);
    const buyer = shippingAddressConsent(order, BUYER_ID);
    const seller = shippingAddressConsent(order, SELLER_ID);
    expect(buyer).toMatchObject({ status: "awaiting_buyer", next_step: expect.stringContaining("share_shipping_address") });
    expect(seller).toMatchObject({ status: "awaiting_buyer", next_step: expect.stringContaining("cannot grant") });
    expect(JSON.stringify([buyer, seller])).not.toContain(ADDRESS_MARKER);
  });

  it("reports granted to both parties once shared", () => {
    const shared = offPlatformOrder("sold", { shipping_address_shared_at: SHARED_AT });
    const expected = { status: "granted", granted_at: SHARED_AT };
    expect(shippingAddressConsent(shared, BUYER_ID)).toEqual(expected);
    expect(shippingAddressConsent(shared, SELLER_ID)).toEqual(expected);
  });

  it.each(CLOSED_STATES)("asks for nothing in %s", (status) => {
    expect(shippingAddressConsent(offPlatformOrder(status), BUYER_ID)).toBeNull();
    expect(shippingAddressConsent(offPlatformOrder(status), SELLER_ID)).toBeNull();
  });

  it("does not apply to Stripe-mode orders, pickup orders or outsiders", () => {
    expect(shippingAddressConsent(offPlatformOrder("sold", { payment_mode: "stripe" }), BUYER_ID)).toBeNull();
    expect(shippingAddressConsent(offPlatformOrder("sold", { fulfillment: "pickup" }), BUYER_ID)).toBeNull();
    expect(shippingAddressConsent(offPlatformOrder("sold"), STRANGER_ID)).toBeNull();
  });
});

describe("shareShippingAddress", () => {
  const shared = (status: OrderStatus) => offPlatformOrder(status, { shipping_address_shared_at: SHARED_AT });

  it.each(OPEN_STATES)("records consent in %s, scoped to this buyer, without the address", async (status) => {
    const { writes } = fakePool([offPlatformOrder(status), shared(status)]);
    const order = await shareShippingAddress(ORDER_ID, BUYER_ID);
    expect(order.shipping_address_shared_at).toEqual(SHARED_AT);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].sql).toContain("buyer_id = $2");
    expect(writes()[0].params.slice(0, 2)).toEqual([ORDER_ID, BUYER_ID]);
    expect(JSON.stringify(writes())).not.toContain(ADDRESS_MARKER);
  });

  it.each(CLOSED_STATES)("refuses %s and writes nothing", async (status) => {
    const { writes } = fakePool([offPlatformOrder(status)]);
    await expectRefusal(BUYER_ID, "invalid_state");
    expect(writes()).toHaveLength(0);
  });

  it("is scoped to the buyer: anyone else, the seller included, reads no row and gets not_found", async () => {
    for (const caller of [SELLER_ID, STRANGER_ID]) {
      const { queries, writes } = fakePool([undefined]);
      await expectRefusal(caller, "not_found");
      expect(queries[0].sql).toContain("buyer_id = $2");
      expect(queries[0].params).toEqual([ORDER_ID, caller]);
      expect(writes()).toHaveLength(0);
    }
  });

  it("replaying after consent is a no-op, even once the order has moved on", async () => {
    const { writes } = fakePool([shared("in_transit")]);
    await expect(shareShippingAddress(ORDER_ID, BUYER_ID)).resolves.toMatchObject({ shipping_address_shared_at: SHARED_AT });
    expect(writes()).toHaveLength(0);
  });

  it("refuses Stripe-mode and pickup orders", async () => {
    for (const overrides of [{ payment_mode: "stripe" }, { fulfillment: "pickup" }] as const) {
      const { writes } = fakePool([offPlatformOrder("sold", overrides)]);
      await expectRefusal(BUYER_ID, "not_applicable");
      expect(writes()).toHaveLength(0);
    }
  });

  it("reports invalid_state when a transition wins the race and consent did not land", async () => {
    fakePool([offPlatformOrder("sold"), offPlatformOrder("cancelled")]);
    await expectRefusal(BUYER_ID, "invalid_state");
  });
});

describe("share_shipping_address tool", () => {
  it("rejects an anonymous caller before any query", async () => {
    const { queries } = fakePool([offPlatformOrder("sold")]);
    const { result, body } = await callTool("share_shipping_address", null);
    expect(result.isError).toBe(true);
    expect(body.code).toBe("unauthorized");
    expect(queries).toHaveLength(0);
  });

  it("returns the consent state to the buyer but never the address", async () => {
    fakePool([offPlatformOrder("sold"), offPlatformOrder("sold", { shipping_address_shared_at: SHARED_AT })]);
    const { result, body, raw } = await callTool("share_shipping_address", BUYER_ID);
    expect(result.isError).toBeUndefined();
    expect(body.shipping_address_consent.status).toBe("granted");
    expect(body.order).not.toHaveProperty("shipping_address");
    expect(body.order).not.toHaveProperty("shipping_address_shared_at");
    expect(raw).not.toContain(ADDRESS_MARKER);
  });

  it("surfaces a refusal as its error code", async () => {
    fakePool([offPlatformOrder("pending")]);
    const { result, body, raw } = await callTool("share_shipping_address", BUYER_ID);
    expect(result.isError).toBe(true);
    expect(body.code).toBe("invalid_state");
    expect(raw).not.toContain(ADDRESS_MARKER);
  });

  it("a seller calling it is refused and consent stays unrecorded", async () => {
    const { writes } = fakePool([undefined]);
    const { result, body } = await callTool("share_shipping_address", SELLER_ID);
    expect(result.isError).toBe(true);
    expect(body.code).toBe("not_found");
    expect(writes()).toHaveLength(0);
  });

  it("describes the buyer-only, explicit-instruction contract", () => {
    const { description } = toolsFor(BUYER_ID).get("share_shipping_address")!;
    expect(description).toContain("Buyer only");
    expect(description).toContain("only when the buyer has told you to");
  });

  it("never reaches stdout or stderr", async () => {
    const sinks = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    fakePool([offPlatformOrder("sold"), offPlatformOrder("sold", { shipping_address_shared_at: SHARED_AT })]);
    await callTool("share_shipping_address", BUYER_ID, true);
    expect(sinks[0].mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(sinks.flatMap((sink) => sink.mock.calls))).not.toContain(ADDRESS_MARKER);
  });
});

describe("get_order on off-platform orders", () => {
  const viewFor = (order: OrderFixture) => fakePool([order]);

  it.each(OPEN_STATES)("seller in %s waits: no address, told consent is awaited", async (status) => {
    viewFor(offPlatformOrder(status));
    const { body, raw } = await callTool("get_order", SELLER_ID);
    expect(body.order).not.toHaveProperty("shipping_address");
    expect(body.order.shipping_address_consent.status).toBe("awaiting_buyer");
    expect(raw).not.toContain(ADDRESS_MARKER);
  });

  it.each(OPEN_STATES)("buyer in %s is asked, and is never handed the address", async (status) => {
    viewFor(offPlatformOrder(status));
    const { body, raw } = await callTool("get_order", BUYER_ID);
    expect(body.order.shipping_address_consent.next_step).toContain("share_shipping_address");
    expect(raw).not.toContain(ADDRESS_MARKER);
  });

  it.each(OPEN_STATES)("seller in %s gets the address once shared", async (status) => {
    viewFor(offPlatformOrder(status, { shipping_address_shared_at: SHARED_AT }));
    const { body } = await callTool("get_order", SELLER_ID);
    expect(body.order.shipping_address).toEqual(address);
    expect(body.order.shipping_address_consent.status).toBe("granted");
    expect(body.order).not.toHaveProperty("shipping_address_shared_at");
  });

  it.each(CLOSED_STATES)("seller in %s gets no address even after consent", async (status) => {
    viewFor(offPlatformOrder(status, { shipping_address_shared_at: SHARED_AT }));
    const { raw } = await callTool("get_order", SELLER_ID);
    expect(raw).not.toContain(ADDRESS_MARKER);
  });

  it("buyer's response never carries the address after consent", async () => {
    viewFor(offPlatformOrder("sold", { shipping_address_shared_at: SHARED_AT }));
    const { raw } = await callTool("get_order", BUYER_ID);
    expect(raw).not.toContain(ADDRESS_MARKER);
  });

  it("anonymous is rejected before any query", async () => {
    const { queries } = fakePool([offPlatformOrder("sold")]);
    const { body } = await callTool("get_order", null);
    expect(body.code).toBe("unauthorized");
    expect(queries).toHaveLength(0);
  });

  it("Stripe-mode output is unchanged: address released, no consent field", async () => {
    viewFor(offPlatformOrder("sold", { payment_mode: "stripe" }));
    const { body } = await callTool("get_order", SELLER_ID);
    expect(body.order.shipping_address).toEqual(address);
    expect(body.order).not.toHaveProperty("shipping_address_consent");
  });

  it("documents the consent rule in the tool description", () => {
    const { description } = toolsFor(SELLER_ID).get("get_order")!;
    expect(description).toContain("share_shipping_address");
    expect(description).toContain("shipping_address_consent");
  });
});
