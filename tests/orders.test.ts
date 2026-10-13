// Order state machine core tests (spec THI-3 rev 2 §2.3 + rev 3 §11.2).
// Part 1 is pure (no DB): the transition matrix itself is normative — every
// entry validated, mode splits asserted, terminal states terminal.
// Part 2 is DB-backed (skipped when no Postgres is reachable): lifecycle
// walks, illegal transitions, the conditional-UPDATE race, dedupe replay.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  applyTransition,
  IllegalTransitionError,
  ORDER_STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  transitionsFrom,
  type OrderStatus,
  type PaymentMode,
} from "../src/orders.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");

// ---------------------------------------------------------------------------
// Part 1 — the matrix (pure)

describe("transition matrix integrity", () => {
  it("every from/to is a known status", () => {
    for (const t of TRANSITIONS) {
      for (const s of t.from) expect(ORDER_STATUSES).toContain(s);
      expect(ORDER_STATUSES).toContain(t.to);
    }
  });

  it("terminal states have no outgoing transitions", () => {
    for (const term of TERMINAL_STATUSES) {
      expect(TRANSITIONS.filter((t) => t.from.includes(term))).toEqual([]);
    }
  });

  it("non-terminal statuses (except refunding) can reach a terminal state", () => {
    // reachability sanity: walk any outgoing edge until terminal or loop.
    const reachesTerminal = (s: OrderStatus, seen = new Set<string>()): boolean => {
      if (TERMINAL_STATUSES.includes(s)) return true;
      if (seen.has(s)) return false;
      seen.add(s);
      return TRANSITIONS.filter((t) => t.from.includes(s)).some((t) => reachesTerminal(t.to, seen));
    };
    for (const s of ORDER_STATUSES) {
      if (!TERMINAL_STATUSES.includes(s)) expect(reachesTerminal(s)).toBe(true);
    }
  });

  it("(from, trigger, mode, actor) keys are unambiguous", () => {
    const keys = new Set<string>();
    for (const t of TRANSITIONS) {
      for (const from of t.from.length ? t.from : (["-creation-"] as const)) {
        const key = [from, t.trigger, t.mode ?? "any", t.actors.join("|")].join("→");
        expect(keys.has(key), `duplicate transition key: ${key}`).toBe(false);
        keys.add(key);
      }
    }
  });
});

describe("payment-mode splits (rev 3 §11.2)", () => {
  const triggers = (status: OrderStatus, mode: PaymentMode) =>
    [...new Set(transitionsFrom(status, mode).map((t) => t.trigger))].sort();

  it("pending: stripe pays via webhook, off_platform via seller confirm_payment", () => {
    expect(triggers("pending", "stripe")).toContain("stripe_payment");
    expect(triggers("pending", "stripe")).not.toContain("confirm_payment");
    expect(triggers("pending", "off_platform")).toContain("confirm_payment");
    expect(triggers("pending", "off_platform")).not.toContain("stripe_payment");
  });

  it("delivered: stripe releases to payout_pending, off_platform to completed", () => {
    expect(triggers("delivered", "stripe")).toContain("release_funds");
    expect(transitionsFrom("delivered", "stripe").find((t) => t.trigger === "release_funds")?.to).toBe("payout_pending");
    expect(transitionsFrom("delivered", "off_platform").find((t) => t.trigger === "release_funds")?.to).toBe("completed");
    expect(transitionsFrom("delivered", "off_platform").find((t) => t.trigger === "dispute_window_elapsed")?.to).toBe("completed");
  });

  it("money states are unreachable for off_platform orders", () => {
    for (const status of ["refunding", "payout_pending"] as const) {
      expect(transitionsFrom(status, "off_platform")).toEqual([]);
    }
    expect(transitionsFrom("sold", "off_platform").map((t) => t.to)).not.toContain("refunding");
    expect(transitionsFrom("in_transit", "off_platform").map((t) => t.to)).not.toContain("refunding");
  });

  it("chargeback only disputes stripe orders, never from refunding", () => {
    expect(transitionsFrom("pending", "stripe").find((t) => t.trigger === "chargeback")).toBeTruthy();
    expect(transitionsFrom("refunding", "stripe").find((t) => t.trigger === "chargeback")).toBeUndefined();
    expect(transitionsFrom("pending", "off_platform").find((t) => t.trigger === "chargeback")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — DB-backed protocol (skips without a reachable Postgres)

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    connectionTimeoutMillis: 1500,
  });
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

describe.skipIf(!available)("applyTransition (DB)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
    // Fresh state per run: seed keys/emails are deterministic (UNIQUE), so
    // leftovers from a previous run would collide. Order-flow tables only —
    // oauth/categories registries belong to their own test files.
    await client.query(
      "TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await client.end();
  });

  let n = 0;
  /** Seeds seller/seller/item + a fresh pending order; returns ids. */
  async function seedOrder(mode: PaymentMode): Promise<{ orderId: string; itemId: string; buyerKey: string; sellerKey: string }> {
    n += 1;
    const s = `s${n}`;
    const b = `b${n}`;
    await client.query(
      "INSERT INTO sellers (api_key, display_name, email) VALUES ($1, $2, $3), ($4, $5, $6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    const item = await client.query(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents) SELECT id, $1, 10000, 500 FROM sellers WHERE email = $2 RETURNING id",
      [`Item ${n}`, `${s}@t.dev`],
    );
    const order = await client.query(
      `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, shipping_price_cents, currency, fulfillment, payment_mode)
       SELECT $1, s.id, b.id, 10000, 500, 'EUR', 'shipping', $2
       FROM sellers s, sellers b WHERE s.email = $3 AND b.email = $4 RETURNING id`,
      [item.rows[0].id, mode, `${s}@t.dev`, `${b}@t.dev`],
    );
    await client.query("UPDATE items SET status = 'reserved' WHERE id = $1", [item.rows[0].id]);
    return { orderId: order.rows[0].id, itemId: item.rows[0].id, buyerKey: `thg_${b}`, sellerKey: `thg_${s}` };
  }

  const accountBy = async (key: string) => {
    const r = await client.query("SELECT id FROM sellers WHERE api_key = $1", [key]);
    return r.rows[0].id as string;
  };

  it("walks the full stripe happy path with item side effects and events", async () => {
    const { orderId, itemId, buyerKey } = await seedOrder("stripe");
    const buyer = await accountBy(buyerKey);
    const steps: Array<[Parameters<typeof applyTransition>[0]["trigger"], string, Parameters<typeof applyTransition>[0]["actor"]["type"]]> = [
      ["stripe_payment", "sold", "stripe"],
      ["record_tracking", "label_issued", "seller"],
      ["carrier_update", "in_transit", "carrier"],
      ["carrier_update", "delivered", "carrier"],
      ["release_funds", "payout_pending", "buyer"],
      ["transfer_paid", "paid_out", "stripe"],
    ];
    for (const [trigger, expected, actor] of steps) {
      const row = await applyTransition({ orderId, trigger, actor: { type: actor, id: buyer }, sets: trigger === "record_tracking" ? { carrier: "DHL", tracking_code: "XYZ", tracker_id: "trk_1" } : undefined });
      expect(row.status).toBe(expected);
    }
    const item = await client.query("SELECT status FROM items WHERE id = $1", [itemId]);
    expect(item.rows[0].status).toBe("sold"); // reserved → sold at payment; stays sold at paid_out
    const events = await client.query(
      "SELECT from_status, to_status FROM order_events WHERE order_id = $1 AND event_type = 'transition' ORDER BY created_at",
      [orderId],
    );
    expect(events.rows.map((r: { to_status: string }) => r.to_status)).toEqual(
      ["sold", "label_issued", "in_transit", "delivered", "payout_pending", "paid_out"],
    );
    expect(events.rows[0].from_status).toBe("pending");
  });

  it("walks the off_platform path: confirm_payment → delivered → completed", async () => {
    const { orderId, itemId, sellerKey } = await seedOrder("off_platform");
    const seller = await accountBy(sellerKey);
    let row = await applyTransition({ orderId, trigger: "confirm_payment", actor: { type: "seller", id: seller }, reason: "cash on collection" });
    expect(row.status).toBe("sold");
    row = await applyTransition({ orderId, trigger: "confirm_receipt", actor: { type: "buyer", id: "x" } });
    expect(row.status).toBe("delivered");
    row = await applyTransition({ orderId, trigger: "dispute_window_elapsed", actor: { type: "system", id: "sweep:dispute_window" }, dedupeKey: `sweep:dispute_window:${orderId}` });
    expect(row.status).toBe("completed");
    const item = await client.query("SELECT status FROM items WHERE id = $1", [itemId]);
    expect(item.rows[0].status).toBe("sold");
  });

  it("off_platform cancel from sold ends cancelled with the item back active", async () => {
    const { orderId, itemId, sellerKey } = await seedOrder("off_platform");
    const seller = await accountBy(sellerKey);
    await applyTransition({ orderId, trigger: "confirm_payment", actor: { type: "seller", id: seller } });
    const row = await applyTransition({ orderId, trigger: "cancel_order", actor: { type: "seller", id: seller }, reason: "mutual" });
    expect(row.status).toBe("cancelled");
    const item = await client.query("SELECT status FROM items WHERE id = $1", [itemId]);
    expect(item.rows[0].status).toBe("active");
  });

  it("rejects illegal transitions naming the current state and allowed triggers", async () => {
    const { orderId } = await seedOrder("stripe");
    const err = await applyTransition({ orderId, trigger: "confirm_payment", actor: { type: "seller", id: "x" } })
      .catch((e: unknown) => e as IllegalTransitionError);
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect((err as IllegalTransitionError).code).toBe("invalid_transition");
    expect((err as IllegalTransitionError).message).toContain("pending");
    expect((err as IllegalTransitionError).message).toContain("stripe_payment");

    const wrongActor = await applyTransition({ orderId, trigger: "stripe_payment", actor: { type: "seller", id: "x" } })
      .catch((e: unknown) => e as IllegalTransitionError);
    expect(wrongActor).toBeInstanceOf(IllegalTransitionError);
  });

  it("mode-restricted triggers are illegal in the other mode (chargeback on off_platform)", async () => {
    const { orderId } = await seedOrder("off_platform");
    const err = await applyTransition({ orderId, trigger: "chargeback", actor: { type: "stripe", id: "evt" } })
      .catch((e: unknown) => e as IllegalTransitionError);
    expect(err).toBeInstanceOf(IllegalTransitionError);
    const allowedList = (err as IllegalTransitionError).message.split("(requested")[0];
    expect(allowedList).not.toContain("chargeback"); // not among the allowed triggers
  });

  it("terminal states reject everything", async () => {
    const { orderId, sellerKey } = await seedOrder("off_platform");
    const seller = await accountBy(sellerKey);
    await applyTransition({ orderId, trigger: "payment_expired", actor: { type: "system", id: "sweep:payment_deadline" }, dedupeKey: `sweep:payment_expired:${orderId}` });
    const err = await applyTransition({ orderId, trigger: "confirm_payment", actor: { type: "seller", id: seller } })
      .catch((e: unknown) => e as IllegalTransitionError);
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect((err as IllegalTransitionError).message).toContain("no transitions leave this state");
  });

  it("conditional UPDATE arbitrates races: exactly one writer wins", async () => {
    const { orderId } = await seedOrder("stripe");
    const [a, b] = await Promise.allSettled([
      applyTransition({ orderId, trigger: "stripe_payment", actor: { type: "stripe", id: "evt_a" } }),
      applyTransition({ orderId, trigger: "payment_expired", actor: { type: "system", id: "sweep" }, dedupeKey: `sweep:payment_expired:${orderId}` }),
    ]);
    const statuses = [a, b].map((r) => (r.status === "fulfilled" ? r.value.status : (r.reason as IllegalTransitionError).code));
    expect(statuses).toContain("invalid_transition");
    expect(statuses.filter((s) => s === "sold" || s === "cancelled")).toHaveLength(1);
    const row = await client.query("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(["sold", "cancelled"]).toContain(row.rows[0].status);
  });

  it("dedupe_key conflict replays safe: returns current row, no second event", async () => {
    const { orderId } = await seedOrder("off_platform");
    await applyTransition({ orderId, trigger: "confirm_payment", actor: { type: "seller", id: "x" } });
    await applyTransition({ orderId, trigger: "confirm_receipt", actor: { type: "buyer", id: "x" } });
    // simulate a prior sweep firing that recorded the same dedupe key
    await client.query(
      "INSERT INTO order_events (order_id, event_type, to_status, actor_type, actor_id, dedupe_key) VALUES ($1, 'transition', 'completed', 'system', 'sweep', $2)",
      [orderId, `sweep:dispute_window:${orderId}`],
    );
    const row = await applyTransition({
      orderId, trigger: "dispute_window_elapsed",
      actor: { type: "system", id: "sweep:dispute_window" },
      dedupeKey: `sweep:dispute_window:${orderId}`,
    });
    expect(row.status).toBe("delivered"); // unchanged — the earlier firing stands
    const evts = await client.query(
      "SELECT count(*)::int AS c FROM order_events WHERE order_id = $1 AND dedupe_key = $2",
      [orderId, `sweep:dispute_window:${orderId}`],
    );
    expect(evts.rows[0].c).toBe(1);
  });

  it("item status override beats the matrix default (lost vs RTS)", async () => {
    const { orderId, itemId } = await seedOrder("stripe");
    await applyTransition({ orderId, trigger: "stripe_payment", actor: { type: "stripe", id: "e" } });
    await applyTransition({ orderId, trigger: "record_tracking", actor: { type: "seller", id: "x" }, sets: { tracking_code: "T1" } });
    await applyTransition({ orderId, trigger: "carrier_update", actor: { type: "carrier", id: "evt" } });
    const row = await applyTransition({ orderId, trigger: "carrier_failure", actor: { type: "carrier", id: "evt2" }, itemStatusOverride: "active" });
    expect(row.status).toBe("refunding");
    const item = await client.query("SELECT status FROM items WHERE id = $1", [itemId]);
    expect(item.rows[0].status).toBe("active"); // RTS: back to active, not the 'deleted' default
  });
});
