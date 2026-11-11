// Order messaging service (spec docs/specs/order-messaging.md, THI-567 PR-A).
// DB-backed; covers the spec's test plan: party checks with uniform
// not_found, terminal cutoff, 30/order/sender cap, body validation, role
// derivation, keyset pagination, send→list round-trip, the 20/hour account
// bucket, and concurrent sends staying under the cap.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  listOrderMessages,
  MESSAGES_PER_ORDER_PER_SENDER,
  OrderMessageError,
  orderMessageLimiter,
  sendOrderMessage,
} from "../src/order-messages.js";
import { TERMINAL_STATUSES } from "../src/orders.js";
import { RateLimiter } from "../src/rate-limit.js";

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

/** Permissive stand-in for the shared hourly bucket, so DB-side caps can be
 *  exercised in isolation (spec layer 2 has its own test below). */
const unlimited = () => new RateLimiter(100_000, 60_000);

describe.skipIf(!available)("order messages (DB)", () => {
  let db: pg.Client;
  let n = 0;
  const ids: { sellerId: string; buyerId: string; outsiderId: string } = {
    sellerId: "", buyerId: "", outsiderId: "",
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
    const s = `ms${n}`, b = `mb${n}`, o = `mo${n}`;
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

  /** A pending order between the seeded buyer and seller (direct insert:
   *  status is fixture data here, not a state-machine outcome). */
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

  const expectCode = async (p: Promise<unknown>, code: string, message?: string) => {
    await expect(p).rejects.toBeInstanceOf(OrderMessageError);
    await expect(p).rejects.toMatchObject(message ? { code, message } : { code });
  };

  describe("send: parties, roles, cutoff", () => {
    it("buyer and seller can send while non-terminal; sender_role is derived server-side", async () => {
      const orderId = await seedOrder("sold");
      const fromBuyer = await sendOrderMessage(
        { orderId, senderAccountId: ids.buyerId, body: "When will you ship?" }, unlimited());
      expect(fromBuyer.sender_role).toBe("buyer");
      expect(fromBuyer.sender_id).toBe(ids.buyerId);
      expect(fromBuyer.body).toBe("When will you ship?");
      expect(fromBuyer.created_at).toBeInstanceOf(Date);

      const fromSeller = await sendOrderMessage(
        { orderId, senderAccountId: ids.sellerId, body: "Tomorrow morning." }, unlimited())
      expect(fromSeller.sender_role).toBe("seller");
      expect(fromSeller.sender_id).toBe(ids.sellerId);
    });

    it("each non-terminal status allows sends (incl. disputed and refunding)", async () => {
      for (const status of ["pending", "sold", "label_issued", "in_transit", "delivered", "disputed", "refunding", "payout_pending"]) {
        const orderId = await seedOrder(status);
        const sent = await sendOrderMessage(
          { orderId, senderAccountId: ids.buyerId, body: `note from ${status}` }, unlimited());
        expect(sent.sender_role).toBe("buyer");
      }
    });

    it("every terminal status rejects sends with forbidden", async () => {
      expect(TERMINAL_STATUSES).toEqual(["refunded", "paid_out", "cancelled", "completed"]);
      for (const status of TERMINAL_STATUSES) {
        const orderId = await seedOrder(status);
        await expectCode(
          sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body: "hello?" }, unlimited()),
          "forbidden",
        );
      }
    });

    it("non-party and unknown order are the same not_found (no oracle)", async () => {
      const orderId = await seedOrder();
      const nonParty = sendOrderMessage(
        { orderId, senderAccountId: ids.outsiderId, body: "hi" }, unlimited());
      const unknown = sendOrderMessage(
        { orderId: "00000000-0000-0000-0000-000000000000", senderAccountId: ids.buyerId, body: "hi" }, unlimited());
      await expectCode(nonParty, "not_found", "Order not found.");
      await expectCode(unknown, "not_found", "Order not found.");
    });

    it("rejects empty, whitespace-only and over-length bodies", async () => {
      const orderId = await seedOrder();
      for (const body of ["", "   ", "\n\t ", "a".repeat(2001)]) {
        await expectCode(
          sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body }, unlimited()),
          "validation",
        );
      }
      // 2000 exactly is the boundary that still passes.
      const edge = await sendOrderMessage(
        { orderId, senderAccountId: ids.buyerId, body: "a".repeat(2000) }, unlimited());
      expect(edge.body).toHaveLength(2000);
    });
  });

  describe("send: caps", () => {
    it("30 per order per sender; the other party keeps their own 30", async () => {
      const orderId = await seedOrder();
      for (let i = 0; i < MESSAGES_PER_ORDER_PER_SENDER; i += 1) {
        await sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body: `m${i}` }, unlimited());
      }
      await expectCode(
        sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body: "one too many" }, unlimited()),
        "rate_limited",
      );
      const sellerSend = await sendOrderMessage(
        { orderId, senderAccountId: ids.sellerId, body: "still fine" }, unlimited());
      expect(sellerSend.sender_role).toBe("seller");
      const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM order_messages WHERE order_id = $1", [orderId]);
      expect(rows[0].n).toBe(MESSAGES_PER_ORDER_PER_SENDER + 1);
    });

    it("concurrent sends stay under the cap (count+insert in one transaction)", async () => {
      const orderId = await seedOrder();
      const attempts = MESSAGES_PER_ORDER_PER_SENDER + 10;
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, (_, i) =>
          sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body: `c${i}` }, unlimited())),
      );
      const sent = results.filter((r) => r.status === "fulfilled").length;
      const rejected = results.filter((r) => r.status === "rejected" && (r.reason as OrderMessageError).code === "rate_limited");
      expect(sent).toBe(MESSAGES_PER_ORDER_PER_SENDER);
      expect(rejected).toHaveLength(attempts - MESSAGES_PER_ORDER_PER_SENDER);
      const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM order_messages WHERE order_id = $1", [orderId]);
      expect(rows[0].n).toBe(MESSAGES_PER_ORDER_PER_SENDER);
    });

    it("account bucket trips at the 21st message in an hour (rate-limit.ts)", async () => {
      const orderId = await seedOrder();
      for (let i = 0; i < 20; i += 1) {
        await sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body: `h${i}` });
      }
      await expectCode(
        sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body: "21st" }),
        "rate_limited",
        "Too many messages sent in the last hour. Try again later.",
      );
      // A different account is unaffected: the bucket is per account.
      const other = await sendOrderMessage({ orderId, senderAccountId: ids.sellerId, body: "other acct" });
      expect(other.sender_role).toBe("seller");
    });
  });

  describe("list", () => {
    it("send → list round-trip for both parties, newest first", async () => {
      const orderId = await seedOrder("delivered");
      await sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body: "first" }, unlimited());
      await sendOrderMessage({ orderId, senderAccountId: ids.sellerId, body: "second" }, unlimited());
      for (const viewer of [ids.buyerId, ids.sellerId]) {
        const { messages, nextCursor } = await listOrderMessages({ orderId, viewerAccountId: viewer });
        expect(nextCursor).toBeNull();
        expect(messages.map((m) => m.body)).toEqual(["second", "first"]);
        expect(messages[0]).toMatchObject({ sender_role: "seller", sender_id: ids.sellerId });
      }
    });

    it("terminal orders stay readable (history)", async () => {
      const orderId = await seedOrder("in_transit");
      await sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body: "early" }, unlimited());
      await db.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
      const { messages } = await listOrderMessages({ orderId, viewerAccountId: ids.buyerId });
      expect(messages.map((m) => m.body)).toEqual(["early"]);
    });

    it("non-party and unknown order are the same not_found", async () => {
      const orderId = await seedOrder();
      await expectCode(
        listOrderMessages({ orderId, viewerAccountId: ids.outsiderId }),
        "not_found", "Order not found.");
      await expectCode(
        listOrderMessages({ orderId: "00000000-0000-0000-0000-000000000000", viewerAccountId: ids.buyerId }),
        "not_found", "Order not found.");
    });

    it("keyset pagination across >50 messages, cursor stability, empty pages", async () => {
      const orderId = await seedOrder();
      // Buyer 30 + seller 25 = 55 messages; distinct created_at is not
      // guaranteed under now(), so ordering must hold via (created_at, id).
      for (let i = 0; i < 30; i += 1) {
        await sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body: `b${i}` }, unlimited());
      }
      for (let i = 0; i < 25; i += 1) {
        await sendOrderMessage({ orderId, senderAccountId: ids.sellerId, body: `s${i}` }, unlimited());
      }

      const page1 = await listOrderMessages({ orderId, viewerAccountId: ids.buyerId, limit: 50 });
      expect(page1.messages).toHaveLength(50);
      expect(page1.nextCursor).toBe(page1.messages[49].id);

      // Cursor stability: a new message lands, but the page boundary does not move.
      await sendOrderMessage({ orderId, senderAccountId: ids.sellerId, body: "latecomer" }, unlimited());
      const page2 = await listOrderMessages({
        orderId, viewerAccountId: ids.buyerId, limit: 50, cursor: page1.nextCursor,
      });
      expect(page2.messages.map((m) => m.body)).not.toContain("latecomer");
      expect(page2.messages).toHaveLength(5); // the 5 oldest of the original 55
      expect(page2.nextCursor).toBeNull();

      // The page after the end is empty, not an error.
      const beyond = await listOrderMessages({
        orderId, viewerAccountId: ids.buyerId, limit: 50, cursor: page2.messages[4].id,
      });
      expect(beyond.messages).toEqual([]);
      expect(beyond.nextCursor).toBeNull();
    });

    it("rejects cursors that never came from this thread", async () => {
      const orderId = await seedOrder();
      const otherOrderId = await seedOrder();
      const sent = await sendOrderMessage({ orderId, senderAccountId: ids.buyerId, body: "x" }, unlimited());
      await sendOrderMessage({ orderId: otherOrderId, senderAccountId: ids.buyerId, body: "y" }, unlimited());
      // A valid uuid that is not a message id:
      await expectCode(
        listOrderMessages({ orderId, viewerAccountId: ids.buyerId, cursor: "00000000-0000-0000-0000-000000000000" }),
        "invalid_cursor");
      // A real message id from a different thread:
      const other = await db.query("SELECT id FROM order_messages WHERE order_id = $1", [otherOrderId]);
      await expectCode(
        listOrderMessages({ orderId, viewerAccountId: ids.buyerId, cursor: other.rows[0].id }),
        "invalid_cursor");
      // The thread's own newest message as cursor = oldest boundary: empty page, no error.
      const last = await listOrderMessages({ orderId, viewerAccountId: ids.buyerId, cursor: sent.id });
      expect(last.messages).toEqual([]);
    });
  });
});
