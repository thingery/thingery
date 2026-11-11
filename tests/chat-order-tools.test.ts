// Website chat order parity — spec docs/specs/chat-order-parity.md (THI-570).
// PR-A scope: read tools (my_orders, get_order) + the "Completing a sale"
// prompt section + the chat page parity footer line.
//
// Pure parts: manifest presence, prompt regression, footer line, and the
// manifest parity table (chat normalizeOrderArgs vs the MCP tools' zod
// schemas — same rejects for the same input).
// DB-backed parts (skipped when no Postgres is reachable): output parity
// and address-hiding parity between the chat executor and the MCP handlers
// on the same order.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, normalizeOrderArgs, TOOLS, chatTurn, signChatConfirmToken, verifyChatConfirmToken, decodeOrderPayload, orderOpVerb } from "../src/chat.js";
import { registerTools } from "../src/tools.js";
import { confirmPayment, recordTracking } from "../src/fulfillment.js";
import { createOrder, shareShippingAddress, getOrderView } from "../src/order-flow.js";
import type { SellerRow } from "../src/db.js";

// Same seam pattern as tests/chat.test.ts: getOrderView mockable so a test
// can simulate a FAILED read (rejection) — the fail-closed gate path. All
// other order-flow exports stay real (the wrapper delegates).
vi.mock("../src/order-flow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/order-flow.js")>();
  return { ...actual, getOrderView: vi.fn(actual.getOrderView) };
});
const realGetOrderView = (await vi.importActual<typeof import("../src/order-flow.js")>("../src/order-flow.js")).getOrderView;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

const available = await dbAvailable();

const sellerA = { id: "11111111-1111-1111-1111-111111111111", display_name: "chat-a" } as SellerRow;
const sellerB = { id: "22222222-2222-2222-2222-222222222222", display_name: "chat-b" } as SellerRow;

/** Captures the MCP tools' zod schemas + handlers via a fake server, for a
 *  given acting seller — the parity tests run both surfaces on the same
 *  input and compare. */
function mcpTools(seller: SellerRow | null) {
  const shapes = new Map<string, z.ZodTypeAny>();
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ isError?: boolean; content?: { text?: string }[] }>>();
  registerTools(
    {
      registerTool(name: string, config: { inputSchema?: z.ZodRawShape }, handler: never) {
        shapes.set(name, z.object(config.inputSchema ?? {}));
        handlers.set(name, handler as never);
      },
    } as never,
    { seller },
  );
  return {
    shape: (name: string) => shapes.get(name)!,
    /** Runs the MCP handler and returns its parsed JSON payload. */
    call: async (name: string, args: Record<string, unknown>) => {
      const r = await handlers.get(name)!(args);
      return { isError: r.isError === true, payload: JSON.parse(r.content![0].text!) as Record<string, unknown> };
    },
  };
}

// ---------------------------------------------------------------------------
// Pure: manifest, prompt, footer

describe("chat order manifest (pure)", () => {
  it("my_orders and get_order are declared with the MCP-mirroring parameters", () => {
    const names = TOOLS.map((t) => t.function.name);
    expect(names).toContain("my_orders");
    expect(names).toContain("get_order");
    const myOrders = TOOLS.find((t) => t.function.name === "my_orders")!.function;
    expect(Object.keys(myOrders.parameters.properties)).toEqual(["role", "status", "limit", "cursor"]);
    const getOrder = TOOLS.find((t) => t.function.name === "get_order")!.function;
    expect(getOrder.parameters.required).toEqual(["order_id"]);
  });

  it("prompt regression: the system prompt carries the completing-a-sale section and the no-card-details rule", async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
      }),
    );
    await chatTurn([], "where are my orders", sellerA);
    vi.unstubAllGlobals();
    const system = bodies[0].messages.find((m) => m.role === "system")!.content!;
    expect(system).toContain("Completing a sale");
    expect(system).toContain("my_orders");
    expect(system).toContain("get_order");
    // The never-ask-for-card-details rule (spec §System prompt).
    expect(system).toMatch(/NEVER ask the user for card details/i);
    expect(system).toMatch(/payment link/i);
  });
});

// ---------------------------------------------------------------------------
// Pure: manifest parity table — chat arg validation vs the MCP zod schemas.
// Spec §Test plan: "each order function's validation errors match the MCP
// tool's for the same input".

describe("manifest parity table (chat vs MCP arg validation)", () => {
  const mcp = mcpTools(null);

  const cases: Array<{ tool: string; args: Record<string, unknown>; why: string }> = [
    { tool: "my_orders", args: { role: "admin" }, why: "role outside the enum" },
    { tool: "my_orders", args: { status: "weird" }, why: "status outside the enum" },
    { tool: "my_orders", args: { limit: 0 }, why: "limit below 1" },
    { tool: "my_orders", args: { limit: 101 }, why: "limit above MAX_ORDER_LIST_LIMIT" },
    { tool: "my_orders", args: { limit: "10" }, why: "non-integer limit" },
    { tool: "my_orders", args: { cursor: "not-a-uuid" }, why: "malformed cursor" },
    { tool: "get_order", args: {}, why: "missing order_id" },
    { tool: "get_order", args: { order_id: 42 }, why: "non-string order_id" },
    { tool: "get_order", args: { order_id: "zzz" }, why: "malformed uuid" },
    { tool: "get_order", args: { order_id: "11111111-1111-1111-1111-111111111111" }, why: "uuid without RFC 9562 version/variant nibbles" },
    { tool: "open_dispute", args: { order_id: "11111111-1111-4111-8111-111111111111" }, why: "missing reason" },
    { tool: "open_dispute", args: { order_id: "11111111-1111-4111-8111-111111111111", reason: "" }, why: "empty reason" },
    { tool: "open_dispute", args: { order_id: "11111111-1111-4111-8111-111111111111", reason: "x".repeat(1001) }, why: "reason over 1000 chars" },
    { tool: "cancel_order", args: { order_id: "11111111-1111-4111-8111-111111111111", reason: "x".repeat(501) }, why: "reason over 500 chars" },
    { tool: "create_order", args: { item_id: "zzz" }, why: "malformed item uuid" },
    { tool: "create_order", args: {}, why: "missing item_id" },
    { tool: "create_order", args: { item_id: "11111111-1111-4111-8111-111111111111", payment_mode: "paypal" }, why: "payment_mode outside the enum" },
    { tool: "create_order", args: { item_id: "11111111-1111-4111-8111-111111111111", shipping_address: { name: "A", line1: "B", city: "C", postal_code: "D", country: "ITA" } }, why: "3-letter country" },
    { tool: "create_order", args: { item_id: "11111111-1111-4111-8111-111111111111", shipping_address: { name: "A", line1: "B", city: "C", postal_code: "D", country: "IT", phone: "123" } }, why: "unknown key in strict address object" },
    { tool: "create_order", args: { item_id: "11111111-1111-4111-8111-111111111111", shipping_address: { line1: "B", city: "C", postal_code: "D", country: "IT" } }, why: "address missing name" },
    { tool: "confirm_receipt", args: {}, why: "missing order_id (receipt)" },
    { tool: "release_funds", args: { order_id: 7 }, why: "non-string order_id (release)" },
    { tool: "share_shipping_address", args: { order_id: "nope" }, why: "malformed uuid (address)" },
  ];

  for (const c of cases) {
    it(`${c.tool} rejects ${c.why} on both surfaces`, () => {
      const zodVerdict = mcp.shape(c.tool).safeParse(c.args);
      const chatVerdict = normalizeOrderArgs(c.tool, c.args);
      expect(zodVerdict.success).toBe(false);
      expect(chatVerdict.ok).toBe(false);
    });
  }

  it("valid args pass both surfaces", () => {

    const okArgs = { order_id: "11111111-1111-4111-8111-111111111111" };
    expect(mcp.shape("get_order").safeParse(okArgs).success).toBe(true);
    expect(normalizeOrderArgs("get_order", okArgs).ok).toBe(true);
    expect(mcp.shape("my_orders").safeParse({ role: "buyer", limit: 5 }).success).toBe(true);
    expect(normalizeOrderArgs("my_orders", { role: "buyer", limit: 5 }).ok).toBe(true);
    const okAddress = { name: "A", line1: "B", city: "C", postal_code: "D", country: "IT" };
    expect(mcp.shape("create_order").safeParse({ item_id: "11111111-1111-4111-8111-111111111111", shipping_address: okAddress }).success).toBe(true);
    expect(normalizeOrderArgs("create_order", { item_id: "11111111-1111-4111-8111-111111111111", shipping_address: okAddress }).ok).toBe(true);
    expect(mcp.shape("open_dispute").safeParse({ order_id: "11111111-1111-4111-8111-111111111111", reason: "never arrived" }).success).toBe(true);
    expect(normalizeOrderArgs("open_dispute", { order_id: "11111111-1111-4111-8111-111111111111", reason: "never arrived" }).ok).toBe(true);
    expect(mcp.shape("cancel_order").safeParse({ order_id: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
    expect(normalizeOrderArgs("cancel_order", { order_id: "11111111-1111-4111-8111-111111111111" }).ok).toBe(true);
    expect(mcp.shape("confirm_receipt").safeParse(okArgs).success).toBe(true);
    expect(normalizeOrderArgs("confirm_receipt", okArgs).ok).toBe(true);
    expect(mcp.shape("release_funds").safeParse(okArgs).success).toBe(true);
    expect(normalizeOrderArgs("release_funds", okArgs).ok).toBe(true);
    expect(mcp.shape("share_shipping_address").safeParse(okArgs).success).toBe(true);
    expect(normalizeOrderArgs("share_shipping_address", okArgs).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure: confirm-op verbs for order writes (spec §Confirm gate)

describe("order confirm-op verbs (pure)", () => {
  const NOW = 1_760_000_000_000;
  const payload = { order_id: "11111111-1111-4111-8111-111111111111", reason: "never arrived" };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  it("round-trips every buyer-write verb through a token", () => {
    for (const op of ["receipt", "release", "address", `dispute=${encoded}`, `cancel=${encoded}`, "order=eyJwYXltZW50X21vZGUiOiJvZmZfcGxhdGZvcm0ifQ"]) {
      const token = signChatConfirmToken("11111111-1111-4111-8111-111111111111", op, (NOW + 60_000) / 1000);
      expect(verifyChatConfirmToken(token, NOW)).toEqual({ itemId: "11111111-1111-4111-8111-111111111111", op });
    }
  });

  it("rejects unknown or malformed order ops", () => {
    for (const op of ["message", "payment", "tracking", "label", "order=has spaces!", "order=", "dispute==x", "refund"]) {
      const token = signChatConfirmToken("a", op, (NOW + 60_000) / 1000);
      expect(verifyChatConfirmToken(token, NOW)).toBeNull();
    }
  });

  it("tampering the payload inside a verb breaks the MAC", () => {
    const token = signChatConfirmToken("a", `dispute=${encoded}`, (NOW + 60_000) / 1000);
    const other = Buffer.from(JSON.stringify({ ...payload, reason: "different" }), "utf8").toString("base64url");
    expect(verifyChatConfirmToken(token.replace(encoded, other), NOW)).toBeNull();
  });

  it("decodeOrderPayload/orderOpVerb split op strings", () => {
    expect(orderOpVerb(`dispute=${encoded}`)).toBe("dispute");
    expect(orderOpVerb("receipt")).toBe("receipt");
    expect(decodeOrderPayload(`dispute=${encoded}`)).toEqual(payload);
    expect(decodeOrderPayload("receipt")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// DB-backed: output parity + address-hiding parity

describe.skipIf(!available)("chat vs MCP order reads (DB)", () => {
  let client: pg.Client;
  let orderId = "";

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    await client.query(
      `INSERT INTO sellers (id, api_key_hash, display_name, email) VALUES
        ($1, 'thg_a', 'chat-a', 'chat-a@t.dev'),
        ($2, 'thg_b', 'chat-b', 'chat-b@t.dev')`,
      [sellerA.id, sellerB.id],
    );
    // sellerA sells a shippable item; sellerB buys it off-platform.
    const item = await client.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, attributes, status, shipping_tier)
       VALUES ($1, 'Vintage Sofa', 10000, 1500, 'furniture', '{}'::jsonb, 'active', 'parcel') RETURNING id`,
      [sellerA.id],
    );
    const { order } = await createOrder({
      buyerId: sellerB.id,
      itemId: item.rows[0].id,
      shippingAddress: { name: "Bee Buyer", line1: "Via Roma 1", city: "Milan", postal_code: "20121", country: "IT" },
      paymentMode: "off_platform",
    });
    orderId = order.id;
  });

  afterAll(async () => {
    await client.end();
  });

  it("get_order output is identical between chat and MCP for both parties", async () => {
    for (const viewer of [sellerA, sellerB]) {
      const mcp = mcpTools(viewer);
      const viaMcp = await mcp.call("get_order", { order_id: orderId });
      const viaChat = (await executeTool("get_order", { order_id: orderId }, viewer)) as { order: unknown };
      expect(viaMcp.isError).toBe(false);
      expect(viaChat.error).toBeUndefined();
      // JSON round-trip = what the chat model actually sees via wrapToolResult
      // (Dates as ISO strings, undefined fields dropped) — same as the MCP
      // tool's own serialization.
      expect(JSON.parse(JSON.stringify(viaChat.order))).toEqual(viaMcp.payload.order);
    }
  });

  it("my_orders output is identical between chat and MCP (role filter, pagination fields)", async () => {
    for (const viewer of [sellerA, sellerB]) {
      const mcp = mcpTools(viewer);
      const viaMcp = await mcp.call("my_orders", { role: "buyer", limit: 10 });
      const viaChat = (await executeTool("my_orders", { role: "buyer", limit: 10 }, viewer)) as { count: number; orders: unknown[] };
      expect(viaMcp.isError).toBe(false);
      expect(viaChat.count).toBe(viaMcp.payload.count);
      expect(JSON.parse(JSON.stringify(viaChat.orders))).toEqual(viaMcp.payload.orders);
      expect(viaChat.next_cursor).toBe(viaMcp.payload.next_cursor);
    }
  });

  it("service errors are verbatim-identical: unknown order → not found on both surfaces", async () => {
    const mcp = mcpTools(sellerA);
    const viaMcp = await mcp.call("get_order", { order_id: "99999999-9999-9999-9999-999999999999" });
    const viaChat = (await executeTool("get_order", { order_id: "99999999-9999-9999-9999-999999999999" }, sellerA)) as { error?: string };
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.payload.error).toBe("Order not found.");
    expect(viaChat.error).toBe("Order not found.");
  });

  it("anonymous chat callers get the login error, like MCP's unauthorized", async () => {
    await expect(executeTool("get_order", { order_id: orderId }, null)).rejects.toThrow(/not logged in/);
    const mcp = mcpTools(null);
    const viaMcp = await mcp.call("get_order", { order_id: orderId });
    expect(viaMcp.payload.code).toBe("unauthorized");
  });

  // Spec §Test plan: "get_order in chat hides the address exactly when the
  // MCP tool would" — walk the off_platform disclosure ladder and compare
  // the two surfaces at every rung.
  it("address hiding parity across the off_platform disclosure ladder", async () => {
    const addressPresence = async (): Promise<{ chat: boolean; mcp: boolean; chatBuyer: boolean; mcpBuyer: boolean }> => {
      const sellerTools = mcpTools(sellerA);
      const buyerTools = mcpTools(sellerB);
      const chatSeller = (await executeTool("get_order", { order_id: orderId }, sellerA)) as { order?: { shipping_address?: unknown } };
      const chatBuyer = (await executeTool("get_order", { order_id: orderId }, sellerB)) as { order?: { shipping_address?: unknown } };
      const mcpSeller = await sellerTools.call("get_order", { order_id: orderId });
      const mcpBuyer = await buyerTools.call("get_order", { order_id: orderId });
      return {
        chat: chatSeller.order?.shipping_address !== undefined,
        mcp: (mcpSeller.payload.order as { shipping_address?: unknown }).shipping_address !== undefined,
        chatBuyer: chatBuyer.order?.shipping_address !== undefined,
        mcpBuyer: (mcpBuyer.payload.order as { shipping_address?: unknown }).shipping_address !== undefined,
      };
    };

    // pending: hidden from the seller (off_platform, no consent yet).
    let p = await addressPresence();
    expect(p).toMatchObject({ chat: false, mcp: false, chatBuyer: false, mcpBuyer: false });

    // sold (seller confirmed off-platform payment): still hidden — the
    // seller's own claim cannot release the address.
    await confirmPayment(orderId, sellerA.id, "bank transfer received");
    p = await addressPresence();
    expect(p).toMatchObject({ chat: false, mcp: false, chatBuyer: false, mcpBuyer: false });

    // buyer consents: visible to the seller on both surfaces, still never
    // to the buyer.
    await shareShippingAddress(orderId, sellerB.id);
    p = await addressPresence();
    expect(p).toMatchObject({ chat: true, mcp: true, chatBuyer: false, mcpBuyer: false });
    // The visible address is the buyer's actual address, on both surfaces.
    const chatSeller = (await executeTool("get_order", { order_id: orderId }, sellerA)) as { order: { shipping_address: { name: string } } };
    expect(chatSeller.order.shipping_address.name).toBe("Bee Buyer");
  });
});

// ---------------------------------------------------------------------------
// Pure: chatTurn normalization wiring (THI-603, THI-602 review item 1).
// Before the fix the read tools executed with raw model args; junk was
// absorbed by the service layer's defensive clamps and never counted in
// toolArgErrors. Now the same manifest-parity rejection the writes get
// happens in-turn: model-facing error, no executor run, accounted.

/** Scripted LLM (same pattern as tests/chat.test.ts): each fetch returns
 *  script[i] and records every request body for assertions. */
function mockLlm(script: unknown[]) {
  const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const step = Math.min(bodies.length - 1, script.length - 1);
      return new Response(JSON.stringify({ choices: [{ message: script[step] }] }), { status: 200 });
    }),
  );
  return bodies;
}

function toolCallMsg(id: string, name: string, args: Record<string, unknown>): unknown {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

const FINAL = { role: "assistant", content: "Done." };

/** Captures the chat_turn_usage console lines emitted during fn(). */
async function withUsageLog(fn: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((o): o is Record<string, unknown> => o !== null && o.type === "chat_turn_usage");
}

const toolResults = (bodies: Array<{ messages: Array<{ role: string; content: string | null }> }>) =>
  bodies.flatMap((b) => b.messages.filter((m) => m.role === "tool").map((m) => m.content ?? "")).join("\n");

describe("chatTurn order-read normalization wiring (THI-603, pure)", () => {
  it("my_orders junk role: parity error to the model, no execution, counted in toolArgErrors", async () => {
    const bodies = mockLlm([toolCallMsg("c1", "my_orders", { role: "admin" }), FINAL]);
    const usage = await withUsageLog(() => chatTurn([], "show my orders", sellerA));
    const content = toolResults(bodies);
    expect(content).toContain("my_orders: role must be one of");
    // Rejected args never reach the executor — no orders payload came back.
    expect(content).not.toContain("\"count\"");
    expect(usage.length).toBe(1);
    expect(usage[0].tool_arg_errors).toBe(1);
    expect(usage[0].tool_names).toContain("my_orders");
  });

  it("get_order malformed id: UUID parity error (not a raw Postgres cast error), accounted", async () => {
    const bodies = mockLlm([toolCallMsg("c1", "get_order", { order_id: "not-a-uuid" }), FINAL]);
    const usage = await withUsageLog(() => chatTurn([], "show the order", sellerA));
    const content = toolResults(bodies);
    expect(content).toContain("get_order: order_id must be a UUID string");
    expect(content).not.toContain("invalid input syntax"); // no executor/DB path was taken
    expect(usage[0].tool_arg_errors).toBe(1);
  });

  it("my_orders junk limit is a model-arg rejection, not a service-layer clamp", async () => {
    const bodies = mockLlm([toolCallMsg("c1", "my_orders", { limit: "10" }), FINAL]);
    const usage = await withUsageLog(() => chatTurn([], "show my orders", sellerA));
    expect(toolResults(bodies)).toContain("my_orders: limit must be an integer from 1 to");
    expect(usage[0].tool_arg_errors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DB-backed: valid read calls through the turn — canonical args reach the
// executor (whitespace-trimmed ids, defaulted role/limit) and execute.

describe.skipIf(!available)("chatTurn order-read canonical args reach the executor (THI-603, DB)", () => {
  let client: pg.Client;
  let orderId = "";

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    await client.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    await client.query(
      `INSERT INTO sellers (id, api_key_hash, display_name, email) VALUES
        ($1, 'thg_a', 'chat-a', 'chat-a@t.dev'),
        ($2, 'thg_b', 'chat-b', 'chat-b@t.dev')`,
      [sellerA.id, sellerB.id],
    );
    const item = await client.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, category, attributes, status, shipping_tier)
       VALUES ($1, 'Canonic Lamp', 3000, 200, 'furniture', '{}'::jsonb, 'active', 'parcel') RETURNING id`,
      [sellerA.id],
    );
    const { order } = await createOrder({
      buyerId: sellerB.id,
      itemId: item.rows[0].id,
      shippingAddress: { name: "Bee Buyer", line1: "Via Roma 1", city: "Milan", postal_code: "20121", country: "IT" },
      paymentMode: "off_platform",
    });
    orderId = order.id as string;
  });

  afterAll(async () => {
    await client.end();
  });

  it("valid my_orders executes through the turn with canonical defaults (no arg errors)", async () => {
    const bodies = mockLlm([toolCallMsg("c1", "my_orders", {}), FINAL]);
    const usage = await withUsageLog(() => chatTurn([], "my orders please", sellerA));
    const content = toolResults(bodies);
    expect(content).toContain("\"count\":1"); // executed — role both / limit 20 defaults
    expect(usage[0].tool_arg_errors).toBe(0);
  });

  it("a whitespace-padded order_id is canonicalized (trimmed) before the executor", async () => {
    const bodies = mockLlm([toolCallMsg("c1", "get_order", { order_id: ` ${orderId} ` }), FINAL]);
    const usage = await withUsageLog(() => chatTurn([], "that order", sellerA));
    const content = toolResults(bodies);
    // The pad would fail the ::uuid cast in the executor — only the trim
    // makes this read succeed.
    expect(content).toContain("\"order\"");
    expect(content).not.toContain("not found");
    expect(content).not.toContain("invalid input syntax");
    expect(usage[0].tool_arg_errors).toBe(0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Defensive: restore the real DB read if a test died before consuming
  // its mockRejectedValueOnce.
  vi.mocked(getOrderView).mockReset();
  vi.mocked(getOrderView).mockImplementation(realGetOrderView);
});

// ---------------------------------------------------------------------------
// DB-backed: the confirm gate around buyer order writes (spec §Confirm gate)

describe.skipIf(!available)("chat buyer order writes behind the confirm gate (DB)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await client.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    await client.query(
      "INSERT INTO sellers (id, api_key_hash, display_name, email) VALUES ($1, 'gate-a', 'chat-a', 'a@x') , ($2, 'gate-b', 'chat-b', 'b@x')",
      [sellerA.id, sellerB.id],
    );
  });

  /** A fresh sold off-platform order: sellerA sells, sellerB buys and pays
   *  off-platform, seller confirms payment. Ready for the address share. */
  async function soldOrder(): Promise<string> {
    const item = await client.query(
      `INSERT INTO items (seller_id, title, description, price_cents, shipping_price_cents, currency, shipping_tier, status)
       VALUES ($1, 'Gate Lamp', 'l', 5000, 300, 'EUR', 'parcel', 'active') RETURNING id`,
      [sellerA.id],
    );
    const { order } = await createOrder({
      itemId: item.rows[0].id,
      buyerId: sellerB.id,
      shippingAddress: { name: "Bee Buyer", line1: "1 Way", city: "Town", postal_code: "00000", country: "IT" },
      paymentMode: "off_platform",
    });
    await confirmPayment(order.id, sellerA.id, "cash received");
    return order.id as string;
  }

  it("every buyer write holds for a card first and does not mutate the DB", async () => {
    const orderId = await soldOrder();
    const item = await client.query("SELECT id FROM items LIMIT 1");
    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "confirm_receipt", args: { order_id: orderId } },
      { name: "release_funds", args: { order_id: orderId } },
      { name: "open_dispute", args: { order_id: orderId, reason: "box is empty" } },
      { name: "share_shipping_address", args: { order_id: orderId } },
      { name: "cancel_order", args: { order_id: orderId, reason: "changed my mind" } },
      { name: "create_order", args: { item_id: item.rows[0].id } },
    ];
    for (const c of cases) {
      mockLlm([toolCallMsg("c1", c.name, c.args), FINAL]);
      const turn = await chatTurn([], `do it: ${c.name}`, sellerB);
      expect(turn.confirm, c.name).toBeDefined();
      expect(turn.confirm!.op, c.name).toMatch(/^(order|receipt|release|dispute|address|cancel)(=|$)/);
      expect(turn.confirm!.summary, c.name).toMatch(/.+/); // concrete effect, not just a verb
      const row = await client.query("SELECT status FROM orders WHERE id = $1", [orderId]);
      expect(row.rows[0].status, c.name).toBe("sold"); // untouched
      const shared = await client.query("SELECT shipping_address_shared_at IS NOT NULL AS s FROM orders WHERE id = $1", [orderId]);
      expect(shared.rows[0].s, c.name).toBe(false);
    }
  });

  it("confirming the card executes the op (share_shipping_address end-to-end)", async () => {
    const orderId = await soldOrder();
    mockLlm([toolCallMsg("c1", "share_shipping_address", { order_id: orderId }), FINAL]);
    const turn = await chatTurn([], "share my address please", sellerB);
    expect(turn.confirm!.op).toBe("address");
    // execute via chat-confirm, as the UI does
    const done = await chatTurn([], `chat-confirm ${turn.confirm!.token}`, sellerB);
    expect(done.text).toMatch(/✅ .*address shared/s);
    // the seller now sees it through the surfaced (allowlisted) path
    const res = (await executeTool("get_order", { order_id: orderId }, sellerA)) as { order: { shipping_address?: { name: string } } };
    expect(res.order.shipping_address?.name).toBe("Bee Buyer");
  });

  it("create_order card carries the price and the payload binds payment mode", async () => {
    const item = await client.query(
      `INSERT INTO items (seller_id, title, description, price_cents, shipping_price_cents, currency, shipping_tier, status)
       VALUES ($1, 'Pay Boat', 'b', 12000, 800, 'EUR', 'parcel', 'active') RETURNING id`,
      [sellerA.id],
    );
    const address = { name: "Bee Buyer", line1: "1 Way", city: "Town", postal_code: "00000", country: "IT" };
    mockLlm([toolCallMsg("c1", "create_order", { item_id: item.rows[0].id, payment_mode: "off_platform", shipping_address: address }), FINAL]);
    const turn = await chatTurn([], "buy the boat", sellerB);
    expect(turn.confirm!.summary).toContain("EUR 128.00");
    expect(decodeOrderPayload(turn.confirm!.op)).toEqual({ payment_mode: "off_platform", shipping_address: address });
    const done = await chatTurn([], `chat-confirm ${turn.confirm!.token}`, sellerB);
    expect(done.text).toMatch(/✅ Order placed/);
    const row = await client.query("SELECT payment_mode, status FROM orders ORDER BY created_at DESC LIMIT 1");
    expect(row.rows[0].payment_mode).toBe("off_platform");
    expect(row.rows[0].status).toBe("pending");
  });

  it("second order write in the same turn is still_pending (one card per turn)", async () => {
    const orderId = await soldOrder();
    const bodies = mockLlm([
      toolCallMsg("c1", "share_shipping_address", { order_id: orderId }),
      toolCallMsg("c2", "cancel_order", { order_id: orderId }),
      FINAL,
    ]);
    const turn = await chatTurn([], "share then cancel", sellerB);
    expect(turn.confirm!.op).toBe("address");
    // The model was TOLD the second op is still pending (it must guide the
    // user to settle the first card) — find the cancel's tool result across
    // the recorded request bodies.
    const toolResults = bodies.flatMap((b) => b.messages.filter((m) => m.role === "tool").map((m) => m.content ?? ""));
    expect(toolResults.join("\n")).toContain("still_pending");
    // and the cancel never ran
    const row = await client.query("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(row.rows[0].status).toBe("sold");
  });

  it("fail-closed: an unreadable order produces an error, never a card", async () => {
    const orderId = await soldOrder();
    vi.mocked(getOrderView).mockRejectedValueOnce(new Error("db down"));
    mockLlm([toolCallMsg("c1", "cancel_order", { order_id: orderId }), FINAL]);
    const turn = await chatTurn([], "cancel it", sellerB);
    expect(turn.confirm).toBeUndefined();
    const row = await client.query("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(row.rows[0].status).toBe("sold");
  });

  it("unknown order → model-facing not-found error, no card", async () => {
    mockLlm([toolCallMsg("c1", "cancel_order", { order_id: "99999999-9999-4999-8999-999999999999" }), FINAL]);
    const turn = await chatTurn([], "cancel it", sellerB);
    expect(turn.confirm).toBeUndefined();
  });

  it("anonymous callers get the login error for order writes", async () => {
    const orderId = await soldOrder();
    mockLlm([toolCallMsg("c1", "cancel_order", { order_id: orderId }), FINAL]);
    const turn = await chatTurn([], "cancel it", null);
    expect(turn.confirm).toBeUndefined();
    const row = await client.query("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(row.rows[0].status).toBe("sold");
  });
});
