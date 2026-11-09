// orderToPublic is an allowlist: every tool that returns an order exposes only
// the fields named here, so a new orders column stays private unless added on
// purpose. No database: the order services are mocked so each handler receives
// a row shaped like `SELECT *`, plus a column the allowlist has never heard of.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/order-flow.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/order-flow.js")>()),
  createOrder: vi.fn(),
  getOrderView: vi.fn(),
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

import { cancelOrder, createOrder, getOrderView } from "../src/order-flow.js";
import { confirmPayment, confirmReceipt, openDispute, recordTracking, releaseFunds } from "../src/fulfillment.js";
import { registerTools } from "../src/tools.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CHECKOUT_URL = "https://pay.test/session";

const orderRow = {
  id: ORDER_ID,
  item_id: "22222222-2222-4222-8222-222222222222",
  seller_id: "33333333-3333-4333-8333-333333333333",
  buyer_id: "44444444-4444-4444-8444-444444444444",
  status: "sold",
  payment_mode: "stripe",
  price_cents: 12500,
  shipping_price_cents: 500,
  currency: "EUR",
  fulfillment: "shipping",
  shipping_address: { name: "Buyer", line1: "Via Test 1", city: "Milan", postal_code: "20121", country: "IT" },
  carrier: "DHL",
  tracking_code: "JD0001",
  tracker_id: "trk_internal",
  label_url: "https://label.test/1.pdf",
  checkout_session_id: "cs_internal",
  payment_intent_id: "pi_internal",
  transfer_id: "tr_internal",
  refund_id: "re_internal",
  payment_deadline: new Date("2026-01-02T00:00:00.000Z"),
  dispute_deadline: new Date("2026-01-09T00:00:00.000Z"),
  status_changed_at: new Date("2026-01-01T12:00:00.000Z"),
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-01T12:00:00.000Z"),
  future_internal_column: "must-not-appear",
};

const orderView = { ...orderRow, item_title: "Road bike", payment_url: CHECKOUT_URL };

const PRIVATE_FIELDS = [
  "shipping_address", "seller_id", "buyer_id",
  "tracker_id", "checkout_session_id", "payment_intent_id", "transfer_id", "refund_id",
  "future_internal_column",
];

const ROW_FIELDS = [
  "id", "item_id", "status", "payment_mode", "price_cents", "shipping_price_cents",
  "total_price_cents", "currency", "fulfillment", "carrier", "tracking_code", "label_url",
  "payment_deadline", "dispute_deadline", "status_changed_at", "created_at", "updated_at",
];
const VIEW_FIELDS = [...ROW_FIELDS, "item_title", "payment_url"];

type ToolResult = { content: { text: string }[] };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function toolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => handlers.set(name, handler),
  };
  // Only the id is read by these handlers; the rest of SellerRow is irrelevant here.
  registerTools(fakeServer as never, { seller: { id: orderRow.buyer_id } as never });
  return handlers;
}

async function orderReturnedBy(tool: string): Promise<Record<string, unknown>> {
  const handler = toolHandlers().get(tool);
  if (!handler) throw new Error(`tool not registered: ${tool}`);
  const result = await handler({ order_id: ORDER_ID, item_id: orderRow.item_id });
  const payload = JSON.parse(result.content[0].text) as { order?: Record<string, unknown> };
  if (!payload.order) throw new Error(`${tool} returned no order: ${result.content[0].text}`);
  return payload.order;
}

describe("order tools expose an explicit allowlist of fields", () => {
  beforeEach(() => {
    vi.mocked(createOrder).mockResolvedValue({ order: orderView, paymentUrl: CHECKOUT_URL } as never);
    vi.mocked(getOrderView).mockResolvedValue(orderView as never);
    vi.mocked(cancelOrder).mockResolvedValue(orderRow as never);
    vi.mocked(recordTracking).mockResolvedValue({ order: orderRow, trackerRegistered: true } as never);
    vi.mocked(confirmPayment).mockResolvedValue(orderRow as never);
    vi.mocked(confirmReceipt).mockResolvedValue(orderRow as never);
    vi.mocked(openDispute).mockResolvedValue(orderRow as never);
    vi.mocked(releaseFunds).mockResolvedValue({ order: orderRow } as never);
  });

  it.each([
    ["create_order", VIEW_FIELDS],
    ["get_order", VIEW_FIELDS],
    ["cancel_order", ROW_FIELDS],
    ["record_tracking", ROW_FIELDS],
    ["confirm_payment", ROW_FIELDS],
    ["confirm_receipt", ROW_FIELDS],
    ["open_dispute", ROW_FIELDS],
    ["release_funds", ROW_FIELDS],
  ])("%s returns exactly the public fields", async (tool, expectedFields) => {
    const order = await orderReturnedBy(tool);
    expect(Object.keys(order).sort()).toEqual([...expectedFields].sort());
    for (const field of PRIVATE_FIELDS) expect(order).not.toHaveProperty(field);
  });

  it("an unknown extra column does not appear in the serialized output", async () => {
    const result = await toolHandlers().get("get_order")!({ order_id: ORDER_ID });
    expect(result.content[0].text).not.toContain("future_internal_column");
    expect(result.content[0].text).not.toContain("must-not-appear");
  });

  it("keeps the values of the public fields", async () => {
    expect(await orderReturnedBy("get_order")).toEqual({
      id: ORDER_ID,
      item_id: orderRow.item_id,
      item_title: "Road bike",
      status: "sold",
      payment_mode: "stripe",
      price_cents: 12500,
      shipping_price_cents: 500,
      total_price_cents: 13000,
      currency: "EUR",
      fulfillment: "shipping",
      carrier: "DHL",
      tracking_code: "JD0001",
      label_url: "https://label.test/1.pdf",
      payment_url: CHECKOUT_URL,
      payment_deadline: "2026-01-02T00:00:00.000Z",
      dispute_deadline: "2026-01-09T00:00:00.000Z",
      status_changed_at: "2026-01-01T12:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T12:00:00.000Z",
    });
  });

  it("keeps a null payment_url as null on get_order", async () => {
    vi.mocked(getOrderView).mockResolvedValue({ ...orderView, payment_url: null } as never);
    expect((await orderReturnedBy("get_order")).payment_url).toBeNull();
  });
});
