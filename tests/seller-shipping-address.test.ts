// get_order releases shipping_address to the order's seller only, and only
// while there is something to ship. Handlers run against mocked order
// functions, so authorization and every state boundary are covered without a
// database; the real SQL path is covered in tests/order-tools.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { withToolResultLogging } from "../src/analytics.js";
import type { SellerRow } from "../src/db.js";
import { ORDER_STATUSES, type OrderRow, type OrderStatus } from "../src/orders.js";

vi.mock("../src/order-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/order-flow.js")>()),
  getOrderView: vi.fn(),
  createOrder: vi.fn(),
  cancelOrder: vi.fn(),
}));
vi.mock("../src/fulfillment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/fulfillment.js")>()),
  recordTracking: vi.fn(),
  confirmPayment: vi.fn(),
  confirmReceipt: vi.fn(),
  openDispute: vi.fn(),
  releaseFunds: vi.fn(),
}));

const orderFlow = await import("../src/order-flow.js");
const fulfillment = await import("../src/fulfillment.js");
const { registerTools } = await import("../src/tools.js");

const SELLER_ID = "11111111-1111-4111-8111-111111111111";
const BUYER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_SELLER_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";

const ADDRESS_MARKER = "Example Fixture Street";
const address = {
  name: "Fixture Recipient",
  line1: `1 ${ADDRESS_MARKER}`,
  city: "Testville",
  postal_code: "00000",
  country: "ZZ",
};

const SHIPPING_STATES: readonly OrderStatus[] = ["sold", "label_issued"];
const NON_SHIPPING_STATES = ORDER_STATUSES.filter((status) => !SHIPPING_STATES.includes(status));

function orderInState(status: OrderStatus, overrides: Partial<OrderRow> = {}) {
  const at = new Date("2026-01-01T00:00:00Z");
  return {
    id: ORDER_ID, item_id: "55555555-5555-4555-8555-555555555555",
    seller_id: SELLER_ID, buyer_id: BUYER_ID, status, payment_mode: "stripe",
    price_cents: 1000, shipping_price_cents: 100, currency: "EUR", fulfillment: "shipping",
    shipping_address: address, carrier: null, tracking_code: null, tracker_id: null, label_url: null,
    checkout_session_id: null, payment_intent_id: null, transfer_id: null, refund_id: null,
    payment_deadline: null, dispute_deadline: null, status_changed_at: at, created_at: at, updated_at: at,
    item_title: "Fixture item", payment_url: null, ...overrides,
  } as OrderRow & { item_title: string; payment_url: string | null };
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

async function getOrderAs(callerId: string | null, wrap = false) {
  const result = await toolsFor(callerId, wrap).get("get_order")!.handler({ order_id: ORDER_ID });
  return { result, raw: result.content[0].text, body: JSON.parse(result.content[0].text) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shippingAddressForSeller", () => {
  it.each(SHIPPING_STATES)("returns the address to the seller in %s", (status) => {
    expect(orderFlow.shippingAddressForSeller(orderInState(status), SELLER_ID)).toEqual(address);
  });

  it.each(NON_SHIPPING_STATES)("returns null to the seller in %s", (status) => {
    expect(orderFlow.shippingAddressForSeller(orderInState(status), SELLER_ID)).toBeNull();
  });

  it.each(ORDER_STATUSES)("returns null to the buyer and to another seller in %s", (status) => {
    expect(orderFlow.shippingAddressForSeller(orderInState(status), BUYER_ID)).toBeNull();
    expect(orderFlow.shippingAddressForSeller(orderInState(status), OTHER_SELLER_ID)).toBeNull();
  });

  it("returns null on a pickup order even in a shipping state", () => {
    const pickup = orderInState("sold", { fulfillment: "pickup" });
    expect(orderFlow.shippingAddressForSeller(pickup, SELLER_ID)).toBeNull();
  });
});

describe("get_order shipping_address disclosure", () => {
  it.each(SHIPPING_STATES)("seller receives it in %s", async (status) => {
    vi.mocked(orderFlow.getOrderView).mockResolvedValue(orderInState(status));
    const { body } = await getOrderAs(SELLER_ID);
    expect(body.order.shipping_address).toEqual(address);
    expect(body.order.seller_id).toBeUndefined();
    expect(body.order.buyer_id).toBeUndefined();
  });

  it.each(NON_SHIPPING_STATES)("seller does not receive it in %s", async (status) => {
    vi.mocked(orderFlow.getOrderView).mockResolvedValue(orderInState(status));
    const { body, raw } = await getOrderAs(SELLER_ID);
    expect(body.order.status).toBe(status);
    expect(body.order).not.toHaveProperty("shipping_address");
    expect(raw).not.toContain(ADDRESS_MARKER);
  });

  it.each(ORDER_STATUSES)("buyer never receives it in %s", async (status) => {
    vi.mocked(orderFlow.getOrderView).mockResolvedValue(orderInState(status));
    const { body, raw } = await getOrderAs(BUYER_ID);
    expect(body.order).not.toHaveProperty("shipping_address");
    expect(raw).not.toContain(ADDRESS_MARKER);
  });

  it("a different seller does not receive it even if the row reached the handler", async () => {
    vi.mocked(orderFlow.getOrderView).mockResolvedValue(orderInState("sold"));
    const { raw } = await getOrderAs(OTHER_SELLER_ID);
    expect(raw).not.toContain(ADDRESS_MARKER);
  });

  it("a non-party gets not_found", async () => {
    vi.mocked(orderFlow.getOrderView).mockResolvedValue(null);
    const { result, body, raw } = await getOrderAs(OTHER_SELLER_ID);
    expect(result.isError).toBe(true);
    expect(body.code).toBe("not_found");
    expect(raw).not.toContain(ADDRESS_MARKER);
  });

  it("an anonymous caller is rejected before any order is read", async () => {
    vi.mocked(orderFlow.getOrderView).mockClear();
    const { result, body } = await getOrderAs(null);
    expect(result.isError).toBe(true);
    expect(body.code).toBe("unauthorized");
    expect(orderFlow.getOrderView).not.toHaveBeenCalled();
  });

  it("the seller of a pickup order does not receive it", async () => {
    vi.mocked(orderFlow.getOrderView).mockResolvedValue(orderInState("sold", { fulfillment: "pickup" }));
    const { body } = await getOrderAs(SELLER_ID);
    expect(body.order).not.toHaveProperty("shipping_address");
  });

  it("the disclosed address never reaches stdout or stderr", async () => {
    const sinks = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    vi.mocked(orderFlow.getOrderView).mockResolvedValue(orderInState("sold"));
    const { raw } = await getOrderAs(SELLER_ID, true);
    expect(raw).toContain(ADDRESS_MARKER);
    expect(sinks[0].mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(sinks.flatMap((sink) => sink.mock.calls))).not.toContain(ADDRESS_MARKER);
  });

  it("documents the output in the tool description", () => {
    const description = toolsFor(SELLER_ID).get("get_order")!.description;
    expect(description).toContain("shipping_address");
    expect(description).toContain("label_issued");
  });
});

describe("every other order tool keeps shipping_address stripped", () => {
  const sold = orderInState("sold", { shipping_address_shared_at: new Date("2026-01-02T00:00:00Z") });
  const cases: Array<[string, () => void, Record<string, unknown>]> = [
    ["create_order", () => vi.mocked(orderFlow.createOrder).mockResolvedValue({ order: sold, paymentUrl: null }), { item_id: ORDER_ID }],
    ["cancel_order", () => vi.mocked(orderFlow.cancelOrder).mockResolvedValue(sold), { order_id: ORDER_ID }],
    ["record_tracking", () => vi.mocked(fulfillment.recordTracking).mockResolvedValue({ order: sold, trackerRegistered: false }), { order_id: ORDER_ID, carrier: "DHL", tracking_code: "X" }],
    ["confirm_payment", () => vi.mocked(fulfillment.confirmPayment).mockResolvedValue(sold), { order_id: ORDER_ID }],
    ["confirm_receipt", () => vi.mocked(fulfillment.confirmReceipt).mockResolvedValue(sold), { order_id: ORDER_ID }],
    ["open_dispute", () => vi.mocked(fulfillment.openDispute).mockResolvedValue(sold), { order_id: ORDER_ID, reason: "x" }],
    ["release_funds", () => vi.mocked(fulfillment.releaseFunds).mockResolvedValue({ order: sold }), { order_id: ORDER_ID }],
  ];

  it.each(cases)("%s output omits the address for the seller", async (name, arrange, args) => {
    arrange();
    const result = await toolsFor(SELLER_ID).get(name)!.handler(args);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toContain(ADDRESS_MARKER);
    expect(result.content[0].text).not.toContain("shipping_address");
  });
});
