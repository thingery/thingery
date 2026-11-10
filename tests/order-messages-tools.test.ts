// Order messaging MCP tools (spec docs/specs/order-messaging.md, THI-567
// PR-B): contract tests for send_order_message / list_order_messages —
// registration, anonymous refusal, party scoping, error codes through the
// tool seam, pagination with next_cursor, and the rate-limit surface.
// Handlers are called directly (repo convention); the zod schemas are
// exercised by the SDK layer and mirrored by service-level validation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { orderMessageLimiter } from "../src/order-messages.js";
import { PROTECTED_TOOLS, registerTools } from "../src/tools.js";

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

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
interface ToolResult {
  isError?: boolean;
  content?: { text?: string }[];
}

const parse = (result: unknown) => {
  const r = result as ToolResult;
  return { isError: r.isError === true, body: JSON.parse((r.content?.[0]?.text ?? "null") as string) };
};

describe.skipIf(!available)("order message tools (DB)", () => {
  let db: pg.Client;
  let n = 0;
  const ids: { sellerId: string; buyerId: string; outsiderId: string } = {
    sellerId: "", buyerId: "", outsiderId: "",
  };

  const toolsFor = (sellerId: string | null) => {
    const handlers = new Map<string, Handler>();
    registerTools(
      {
        registerTool(name: string, _config: unknown, handler: Handler) {
          handlers.set(name, handler);
        },
      },
      { seller: sellerId ? ({ id: sellerId } as never) : null },
    );
    return handlers;
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
  });
  afterAll(async () => {
    await db.end();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE order_messages, order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    orderMessageLimiter.reset();
    n += 1;
    const s = `ts${n}`, b = `tb${n}`, o = `to${n}`;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6), ($7,$8,$9)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`, `thg_${o}`, o, `${o}@t.dev`],
    );
    const r = await db.query(
      `SELECT (SELECT id FROM sellers WHERE email=$1) AS seller,
              (SELECT id FROM sellers WHERE email=$2) AS buyer,
              (SELECT id FROM sellers WHERE email=$3) AS outsider`,
      [`${s}@t.dev`, `${b}@t.dev`, `${o}@t.dev`],
    );
    ids.sellerId = r.rows[0].seller;
    ids.buyerId = r.rows[0].buyer;
    ids.outsiderId = r.rows[0].outsider;
  });

  const seedOrder = async (status = "pending"): Promise<string> => {
    const item = await db.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_tier, status)
       VALUES ($1, $2, 10000, 'parcel', 'sold') RETURNING id`,
      [ids.sellerId, `Item ${n}`],
    );
    const order = await db.query(
      `INSERT INTO orders (item_id, seller_id, buyer_id, status, price_cents, currency, fulfillment)
       VALUES ($1, $2, $3, $4, 10000, 'EUR', 'shipping') RETURNING id`,
      [item.rows[0].id, ids.sellerId, ids.buyerId, status],
    );
    return order.rows[0].id as string;
  };

  it("registers both tools and challenges anonymous callers (PROTECTED_TOOLS)", async () => {
    expect([...PROTECTED_TOOLS]).toEqual(expect.arrayContaining(["send_order_message", "list_order_messages"]));
    const anonymous = toolsFor(null);
    for (const tool of ["send_order_message", "list_order_messages"]) {
      const { isError, body } = parse(await anonymous.get(tool)!({
        order_id: "00000000-0000-0000-0000-000000000000",
        body: "hi",
      }));
      expect(isError).toBe(true);
      expect(body.code).toBe("unauthorized");
    }
  });

  it("buyer sends, both parties list; message shape matches the spec", async () => {
    const orderId = await seedOrder("sold");
    const buyer = toolsFor(ids.buyerId);
    const seller = toolsFor(ids.sellerId);

    const sent = parse(await buyer.get("send_order_message")!({ order_id: orderId, body: "Any news on shipping?" }));
    expect(sent.isError).toBe(false);
    expect(sent.body.message).toMatchObject({
      sender_id: ids.buyerId,
      sender_role: "buyer",
      body: "Any news on shipping?",
    });
    expect(typeof sent.body.message.id).toBe("string");
    expect(typeof sent.body.message.created_at).toBe("string");

    const listed = parse(await seller.get("list_order_messages")!({ order_id: orderId }));
    expect(listed.isError).toBe(false);
    expect(listed.body.count).toBe(1);
    expect(listed.body.next_cursor).toBeNull();
    expect(listed.body.messages[0]).toMatchObject({ sender_role: "buyer", body: "Any news on shipping?" });
  });

  it("non-party callers get not_found on both tools (uniform, no oracle)", async () => {
    const orderId = await seedOrder();
    const outsider = toolsFor(ids.outsiderId);
    const send = parse(await outsider.get("send_order_message")!({ order_id: orderId, body: "hi" }));
    const list = parse(await outsider.get("list_order_messages")!({ order_id: orderId }));
    expect(send.body).toMatchObject({ code: "not_found" });
    expect(list.body).toMatchObject({ code: "not_found" });
    expect(send.body.error).toBe(list.body.error);
  });

  it("terminal orders: send forbidden, list still works", async () => {
    const orderId = await seedOrder("in_transit");
    const buyer = toolsFor(ids.buyerId);
    await buyer.get("send_order_message")!({ order_id: orderId, body: "on my way" });
    await db.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
    const rejected = parse(await buyer.get("send_order_message")!({ order_id: orderId, body: "thanks!" }));
    expect(rejected.body).toMatchObject({ code: "forbidden" });
    const history = parse(await buyer.get("list_order_messages")!({ order_id: orderId }));
    expect(history.body.messages.map((m: { body: string }) => m.body)).toEqual(["on my way"]);
  });

  it("surfaces typed errors: validation for bad bodies, rate_limited for the hourly bucket", async () => {
    const orderId = await seedOrder();
    const buyer = toolsFor(ids.buyerId);
    for (const body of ["", "   ", "x".repeat(2001)]) {
      const { isError, body: out } = parse(await buyer.get("send_order_message")!({ order_id: orderId, body }));
      expect(isError).toBe(true);
      expect(out.code).toBe("validation");
    }
    for (let i = 0; i < 20; i += 1) {
      const okResult = parse(await buyer.get("send_order_message")!({ order_id: orderId, body: `m${i}` }));
      expect(okResult.isError).toBe(false);
    }
    const limited = parse(await buyer.get("send_order_message")!({ order_id: orderId, body: "21st" }));
    expect(limited.body).toMatchObject({ code: "rate_limited" });
  });

  it("newest-first keyset pagination through the tool seam", async () => {
    const orderId = await seedOrder();
    const buyer = toolsFor(ids.buyerId);
    const seller = toolsFor(ids.sellerId);
    // 55 messages: buyer 30 (own cap) + seller 25; the hourly bucket is
    // reset between sends so only pagination is under test here.
    for (let i = 0; i < 30; i += 1) {
      orderMessageLimiter.reset();
      await buyer.get("send_order_message")!({ order_id: orderId, body: `b${i}` });
    }
    for (let i = 0; i < 25; i += 1) {
      orderMessageLimiter.reset();
      await seller.get("send_order_message")!({ order_id: orderId, body: `s${i}` });
    }

    const page1 = parse(await buyer.get("list_order_messages")!({ order_id: orderId, limit: 50 }));
    expect(page1.body.count).toBe(50);
    expect(page1.body.next_cursor).toBe(page1.body.messages[49].id);

    const page2 = parse(await buyer.get("list_order_messages")!({ order_id: orderId, limit: 50, cursor: page1.body.next_cursor }));
    expect(page2.body.count).toBe(5);
    expect(page2.body.next_cursor).toBeNull();

    const bad = parse(await buyer.get("list_order_messages")!({ order_id: orderId, cursor: "00000000-0000-0000-0000-000000000000" }));
    expect(bad.body).toMatchObject({ code: "invalid_cursor" });
  });
});
