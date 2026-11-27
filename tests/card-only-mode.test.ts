// Card-only native listings (THI-1625 B-1; thi1611 spec §B1/B2): the
// CARD_ONLY_MODE deployment flag gates create_order — never a new off_platform
// order, stripe-only fallback with machine-readable reasons, D4 country
// allowlist, D5 no-free-native. Flag off ⇒ byte-for-byte today's behavior.
// DB-backed; Stripe faked via setStripeForTests (no network).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setStripeForTests } from "../src/stripe.js";
import { createOrder, OrderFlowError } from "../src/order-flow.js";
import { orderFlowConfig } from "../src/config.js";

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

function fakeStripe(): { client: Stripe; calls: string[] } {
  const calls: string[] = [];
  const n = Math.random().toString(36).slice(2, 8);
  const client = {
    checkout: {
      sessions: {
        create: async () => {
          calls.push("sessions.create");
          return { id: `cs_${n}`, url: `https://pay.test/${n}` };
        },
      },
    },
  } as unknown as Stripe;
  return { client, calls };
}

// --- Config parsing (no DB needed) -----------------------------------------

describe("CARD_ONLY_MODE / SELLER_COUNTRY_ALLOWLIST config parsing (THI-1625 B-1)", () => {
  const KEYS = ["CARD_ONLY_MODE", "SELLER_COUNTRY_ALLOWLIST"] as const;

  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("defaults: flag off, allowlist null (no restriction)", () => {
    const cfg = orderFlowConfig();
    expect(cfg.cardOnlyMode).toBe(false);
    expect(cfg.sellerCountryAllowlist).toBeNull();
  });

  it("flag accepts 1/true case-insensitively, rejects anything else", () => {
    process.env.CARD_ONLY_MODE = "TRUE";
    expect(orderFlowConfig().cardOnlyMode).toBe(true);
    process.env.CARD_ONLY_MODE = "1";
    expect(orderFlowConfig().cardOnlyMode).toBe(true);
    process.env.CARD_ONLY_MODE = "yes";
    expect(orderFlowConfig().cardOnlyMode).toBe(false);
    process.env.CARD_ONLY_MODE = "";
    expect(orderFlowConfig().cardOnlyMode).toBe(false); // F1: empty = unset
  });

  it("allowlist normalizes (trim + uppercase) and drops invalid entries fail-closed", () => {
    process.env.SELLER_COUNTRY_ALLOWLIST = " nl , de , NLD , 12 ";
    const cfg = orderFlowConfig();
    expect([...cfg.sellerCountryAllowlist!].sort()).toEqual(["DE", "NL"]);
  });

  it("allowlist validating to zero entries is an empty set (blocks all), not null", () => {
    process.env.SELLER_COUNTRY_ALLOWLIST = "NLD,XX";
    const cfg = orderFlowConfig();
    expect(cfg.sellerCountryAllowlist).not.toBeNull();
    expect(cfg.sellerCountryAllowlist!.size).toBe(0);
  });
});

// --- create_order gate (DB) ------------------------------------------------

describe.skipIf(!available)("card-only create_order gate (DB)", () => {
  let db: pg.Client;
  let n = 0;
  const ids = { sellerId: "", buyerId: "" };

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
  });
  afterAll(async () => {
    await db.end();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.CARD_ONLY_MODE;
    delete process.env.SELLER_COUNTRY_ALLOWLIST;
    setStripeForTests(null);
  });
  beforeEach(async () => {
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    n += 1;
    const s = `cb${n}`, b = `cc${n}`;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    const r = await db.query(
      `SELECT (SELECT id FROM sellers WHERE email=$1) AS seller, (SELECT id FROM sellers WHERE email=$2) AS buyer`,
      [`${s}@t.dev`, `${b}@t.dev`],
    );
    ids.sellerId = r.rows[0].seller;
    ids.buyerId = r.rows[0].buyer;
    delete process.env.CARD_ONLY_MODE;
    delete process.env.SELLER_COUNTRY_ALLOWLIST;
    delete process.env.STRIPE_SECRET_KEY;
    setStripeForTests(null);
  });

  /** Pickup item owned by the seeded seller (no address / quote path). */
  const seedItem = async (opts: { price?: number } = {}) => {
    const item = await db.query(
      `INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, shipping_tier, status)
       VALUES ($1, $2, $3, 500, 'local', 'active') RETURNING id`,
      [ids.sellerId, `Item ${n}`, opts.price ?? 10000],
    );
    return item.rows[0].id as string;
  };

  const onboardSeller = async (country: string | null = null) => {
    await db.query(
      `UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now(), stripe_account_country = $2
       WHERE id = $1`,
      [ids.sellerId, country],
    );
  };

  const expectCode = async (p: Promise<unknown>, code: string) => {
    await expect(p).rejects.toMatchObject({ code });
    await expect(p).rejects.toBeInstanceOf(OrderFlowError);
  };

  it("flag OFF: implicit fallback still creates an off_platform order (regression guard)", async () => {
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId });
    expect(order.payment_mode).toBe("off_platform");
    expect(order.payment_url).toBeNull();
  });

  it("flag OFF: explicit off_platform still works", async () => {
    const itemId = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId, paymentMode: "off_platform" });
    expect(order.payment_mode).toBe("off_platform");
  });

  it("flag ON: explicit off_platform is refused (off_platform_disabled)", async () => {
    process.env.CARD_ONLY_MODE = "true";
    const itemId = await seedItem();
    await expectCode(
      createOrder({ buyerId: ids.buyerId, itemId, paymentMode: "off_platform" }),
      "off_platform_disabled",
    );
    // nothing reserved, nothing created
    const item = await db.query("SELECT status FROM items WHERE id = $1", [itemId]);
    expect(item.rows[0].status).toBe("active");
    const orders = await db.query("SELECT COUNT(*)::int AS n FROM orders");
    expect(orders.rows[0].n).toBe(0);
  });

  it("flag ON: implicit fallback refuses with seller_not_payout_ready (never silent off_platform)", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    const itemId = await seedItem();
    await expectCode(createOrder({ buyerId: ids.buyerId, itemId }), "seller_not_payout_ready");
  });

  it("flag ON: payout-ready seller without allowlist config orders via stripe (pickup, no address)", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await onboardSeller();
    const fake = fakeStripe();
    setStripeForTests(fake.client);
    const itemId = await seedItem();
    const { order, paymentUrl } = await createOrder({ buyerId: ids.buyerId, itemId });
    expect(order.payment_mode).toBe("stripe");
    expect(order.fulfillment).toBe("pickup");
    expect(paymentUrl).toBe("https://pay.test/" + paymentUrl!.split("/").pop());
    expect(fake.calls).toEqual(["sessions.create"]);
  });

  it("flag ON: NULL country under a configured allowlist is refused fail-closed", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    process.env.SELLER_COUNTRY_ALLOWLIST = "NL,BE";
    await onboardSeller(null);
    const itemId = await seedItem();
    await expectCode(createOrder({ buyerId: ids.buyerId, itemId }), "seller_country_not_allowed");
  });

  it("flag ON: allowlist membership decides orderability (NL in, DE out)", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    process.env.SELLER_COUNTRY_ALLOWLIST = "NL,BE";
    await onboardSeller("NL");
    setStripeForTests(fakeStripe().client);
    const inItem = await seedItem();
    const { order } = await createOrder({ buyerId: ids.buyerId, itemId: inItem });
    expect(order.payment_mode).toBe("stripe");

    await db.query("UPDATE sellers SET stripe_account_country = 'DE' WHERE id = $1", [ids.sellerId]);
    const outItem = await seedItem();
    await expectCode(createOrder({ buyerId: ids.buyerId, itemId: outItem }), "seller_country_not_allowed");
  });

  it("flag ON: a price-0 item is refused regardless of seller state (free_item_not_orderable)", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    process.env.SELLER_COUNTRY_ALLOWLIST = "NL";
    await onboardSeller("NL");
    setStripeForTests(fakeStripe().client);
    const itemId = await seedItem({ price: 0 });
    await expectCode(createOrder({ buyerId: ids.buyerId, itemId }), "free_item_not_orderable");
  });

  it("flag ON without Stripe configured: payments_not_configured", async () => {
    process.env.CARD_ONLY_MODE = "true";
    const itemId = await seedItem();
    await expectCode(createOrder({ buyerId: ids.buyerId, itemId }), "payments_not_configured");
  });
});
