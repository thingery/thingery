// Buyer↔seller order messaging (spec docs/specs/order-messaging.md, THI-562
// work item 1, THI-567 PR-A): party-to-party text messages scoped to one
// order. No notifications, read receipts or attachments in v1.
//
// Who may send: the order's buyer or seller while the order is non-terminal
// (TERMINAL_STATUSES cutoff — history becomes read-only once the sale is
// over). Who may read: the parties, in any status. A missing order and
// another party's order are the same `not_found` — no oracle (spec).
//
// sender_role is derived from the locked order row at insert time, never
// client-supplied. Messages are NOT written to order_events (that table is
// the transition audit log); message rows are their own record.
//
// Abuse is bounded by two layers (spec §rate limits), neither of which
// blocks reads: 30 messages per order per sender (count+insert in one
// transaction) and 20 messages per account per hour (rate-limit.ts bucket
// keyed `ordermsg:acct:<id>`). Parties legitimately exchange shipping
// details here — contact-scrub does not apply; content stays unfiltered.

import { pool } from "./db.js";
import { RateLimiter } from "./rate-limit.js";
import { TERMINAL_STATUSES, type OrderStatus } from "./orders.js";
import { logSecurityEvent } from "./security-events.js";

/** Spec: text only, 1–2000 chars. The DB CHECK mirrors this exactly;
 *  Postgres char_length never counts more than JS string length, so a body
 *  accepted here can never violate the column constraint. */
export const MAX_MESSAGE_BODY_CHARS = 2000;

/** Rate-limit layer 1 (spec): per order per sender. */
export const MESSAGES_PER_ORDER_PER_SENDER = 30;

/** Rate-limit layer 2 (spec): per account per hour. Injectable so tests can
 *  exercise the DB-side caps without tripping the shared bucket. */
export const orderMessageLimiter = new RateLimiter(20, 60 * 60_000);

export const MAX_MESSAGE_LIST_LIMIT = 50;
export const DEFAULT_MESSAGE_LIST_LIMIT = 20;

export type OrderMessageErrorCode =
  | "not_found" // bad order id or non-party viewer — identical message, no oracle
  | "forbidden" // terminal order: reads stay open, sends are cut off
  | "rate_limited" // either abuse layer (per-order cap or hourly account bucket)
  | "validation" // body shape
  | "invalid_cursor"; // list pagination cursor that never came from a result

export class OrderMessageError extends Error {
  constructor(readonly code: OrderMessageErrorCode, message: string) {
    super(message);
    this.name = "OrderMessageError";
  }
}

/** One message row as the spec's list shape returns it. */
export interface OrderMessage {
  id: string;
  sender_id: string;
  sender_role: "buyer" | "seller";
  body: string;
  created_at: Date;
}

const NOT_FOUND = () => new OrderMessageError("not_found", "Order not found.");

export async function sendOrderMessage(
  input: { orderId: string; senderAccountId: string; body: string },
  limiter: RateLimiter = orderMessageLimiter,
): Promise<OrderMessage> {
  // Validation before any I/O — defense in depth under the MCP schema
  // (zod min(1) cannot see whitespace-only bodies, so it is checked here).
  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    throw new OrderMessageError("validation", "Message body must be 1–2000 characters, not only whitespace.");
  }
  if (input.body.length > MAX_MESSAGE_BODY_CHARS) {
    throw new OrderMessageError("validation", `Message body is limited to ${MAX_MESSAGE_BODY_CHARS} characters.`);
  }

  // Layer 2 — per-account hourly bucket (spec key: ordermsg:acct:<id>).
  if (!limiter.allow(`ordermsg:acct:${input.senderAccountId}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/mcp" }, { sellerId: input.senderAccountId });
    throw new OrderMessageError("rate_limited", "Too many messages sent in the last hour. Try again later.");
  }

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    try {
      // Locking the order row does three things at once: the party check,
      // the terminal cutoff and the sender_role derivation all read the
      // locked row (no TOCTOU), and concurrent senders to the same order
      // serialize here, which makes the count+insert below atomic. (The
      // spec sketches "SELECT count(*) … FOR UPDATE"; Postgres forbids
      // FOR UPDATE with aggregates, and the single order-row lock covers
      // the same writers with one lock instead of the whole message set.)
      const order = await db.query<{ buyer_id: string; seller_id: string; status: OrderStatus }>(
        "SELECT buyer_id, seller_id, status FROM orders WHERE id = $1 FOR UPDATE",
        [input.orderId],
      );
      const row = order.rows[0];
      if (!row || (row.buyer_id !== input.senderAccountId && row.seller_id !== input.senderAccountId)) {
        throw NOT_FOUND();
      }
      if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
        throw new OrderMessageError(
          "forbidden",
          "This order is finished; its messages are read-only.",
        );
      }

      // Layer 1 — per order per sender cap (spec: 30).
      const count = await db.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM order_messages WHERE order_id = $1 AND sender_id = $2",
        [input.orderId, input.senderAccountId],
      );
      if (count.rows[0].n >= MESSAGES_PER_ORDER_PER_SENDER) {
        throw new OrderMessageError(
          "rate_limited",
          `Message limit for this order reached (${MESSAGES_PER_ORDER_PER_SENDER} per party).`,
        );
      }

      // sender_role derived from the locked order row — never client input.
      const senderRole = row.buyer_id === input.senderAccountId ? "buyer" : "seller";
      const inserted = await db.query<OrderMessage>(
        `INSERT INTO order_messages (order_id, sender_id, sender_role, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id, sender_id, sender_role, body, created_at`,
        [input.orderId, input.senderAccountId, senderRole, input.body],
      );
      await db.query("COMMIT");
      return inserted.rows[0];
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    db.release();
  }
}

/**
 * One order's message thread, newest first, keyset-paginated on
 * (created_at, id). Party-only, every status — history stays readable after
 * completion. The cursor is the last message id of the previous page; its
 * (created_at, id) is immutable and looked up scoped to this order, so a
 * message id from another thread cannot be used to probe this one.
 */
export async function listOrderMessages(params: {
  orderId: string;
  viewerAccountId: string;
  limit?: number;
  cursor?: string;
}): Promise<{ messages: OrderMessage[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_MESSAGE_LIST_LIMIT, 1), MAX_MESSAGE_LIST_LIMIT);
  const cursor = params.cursor ?? null;

  // Party check first, uniform not_found (same message as a bad id).
  const party = await pool.query(
    "SELECT 1 FROM orders WHERE id = $1 AND (buyer_id = $2 OR seller_id = $2)",
    [params.orderId, params.viewerAccountId],
  );
  if (party.rows.length === 0) throw NOT_FOUND();

  const { rows } = await pool.query<OrderMessage>(
    `SELECT id, sender_id, sender_role, body, created_at
     FROM order_messages
     WHERE order_id = $1
       AND ($3::uuid IS NULL OR (created_at, id) < (
         SELECT m.created_at, m.id FROM order_messages m
         WHERE m.id = $3 AND m.order_id = $1
       ))
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    // One extra row reveals whether another page exists.
    [params.orderId, limit + 1, cursor],
  );
  if (rows.length === 0 && cursor && !(await isThreadCursor(params.orderId, cursor))) {
    throw new OrderMessageError(
      "invalid_cursor",
      "Unknown cursor — pass next_cursor from a previous list_order_messages result.",
    );
  }
  const messages = rows.slice(0, limit);
  return { messages, nextCursor: rows.length > limit ? messages[messages.length - 1].id : null };
}

async function isThreadCursor(orderId: string, cursor: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM order_messages WHERE id = $1 AND order_id = $2",
    [cursor, orderId],
  );
  return rows.length > 0;
}
