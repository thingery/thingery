// Card-only orderability surfaces (THI-1625 B-2; thi1611 spec §B2). One
// predicate (cardOnlyOrderability / cardOnlyPaymentsBlocker, order-flow.ts)
// drives create_order refusals (B-1), get_item flags + reason, publish-time
// seller warnings (create_listing / update_listing), get_payout_setup, and
// the chat order preview — a preview can never contradict an execute
// (THI-1788 advisory). Flag off ⇒ byte-for-byte today's output.
// DB-backed; Stripe faked via setStripeForTests (no network).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type Stripe from "stripe";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setStripeForTests } from "../src/stripe.js";
import { cardOnlyOrderability, cardOnlyPaymentsBlocker, createOrder, OrderFlowError } from "../src/order-flow.js";
import { itemToPublic } from "../src/tools.js";
import { registerTools } from "../src/tools.js";
import { orderFlowConfig } from "../src/config.js";
import type { ItemRow } from "../src/db.js";

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

const KEYS = ["CARD_ONLY_MODE", "SELLER_COUNTRY_ALLOWLIST", "STRIPE_SECRET_KEY"] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  setStripeForTests(null);
});

// --- Shared predicate (no DB) ----------------------------------------------

describe("cardOnlyPaymentsBlocker / cardOnlyOrderability precedence (THI-1625 B-2)", () => {
  const cfg = (stripe: boolean, allowlist: string[] | null) => ({
    stripePaymentsEnabled: stripe,
    sellerCountryAllowlist: allowlist ? new Set(allowlist) : null,
  });

  it("payments-side precedence: payments → payout → country", () => {
    expect(cardOnlyPaymentsBlocker(cfg(false, ["NL"]), { payoutReady: true, country: "NL" })).toBe(
      "payments_not_configured",
    );
    expect(cardOnlyPaymentsBlocker(cfg(true, ["NL"]), { payoutReady: false, country: "NL" })).toBe(
      "seller_not_payout_ready",
    );
    expect(cardOnlyPaymentsBlocker(cfg(true, ["NL"]), { payoutReady: true, country: "US" })).toBe(
      "seller_country_not_allowed",
    );
    expect(cardOnlyPaymentsBlocker(cfg(true, ["NL"]), { payoutReady: true, country: null })).toBe(
      "seller_country_not_allowed",
    ); // NULL country fails closed under a configured allowlist
    expect(cardOnlyPaymentsBlocker(cfg(true, null), { payoutReady: true, country: null })).toBeNull();
    expect(cardOnlyPaymentsBlocker(cfg(true, ["NL"]), { payoutReady: true, country: "nl " })).toBeNull(); // normalize compare
  });

  it("orderability adds the price-0 rule last (D5: free after payments pass)", () => {
    expect(cardOnlyOrderability(cfg(true, null), { priceCents: 0, payoutReady: true, country: null })).toEqual({
      orderable: false,
      reason: "free_item_not_orderable",
      paymentAvailable: false,
    });
    // deeper blocker wins over free: an unconfigured deployment never blames the price
    expect(cardOnlyOrderability(cfg(false, null), { priceCents: 0, payoutReady: true, country: null })).toEqual({
      orderable: false,
      reason: "payments_not_configured",
      paymentAvailable: false,
    });
    expect(cardOnlyOrderability(cfg(true, ["NL"]), { priceCents: 100, payoutReady: true, country: "NL" })).toEqual({
      orderable: true,
      reason: null,
      paymentAvailable: true,
    });
  });
});

// --- itemToPublic surfaces (no DB) ------------------------------------------

function row(overrides: Partial<ItemRow> & { seller_payout_ready?: boolean; seller_stripe_country?: string | null } = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    seller_id: "00000000-0000-0000-0000-000000000002",
    title: "Test item",
    description: "",
    category: "other",
    condition: "good",
    brand: null,
    price_cents: 10000,
    currency: "EUR",
    location: null,
    weight_grams: null,
    dimensions_mm: null,
    shipping_tier: "local",
    shipping_price_cents: 0,
    images: [],
    attributes: {},
    status: "active",
    photo_required: false,
    created_at: new Date(),
    updated_at: new Date(),
    published_at: null,
    ...overrides,
  } as unknown as ItemRow & { seller_payout_ready?: boolean; seller_stripe_country?: string | null };
}

describe.skipIf(!available)("itemToPublic card-only surfaces", () => {
  it("flag OFF: today's output byte-for-byte — no payment_unavailable_reason key ever", () => {
    const out = itemToPublic(row({ seller_payout_ready: false, seller_stripe_country: "US" }));
    expect(out.payment_available).toBe(false);
    expect(out.orderable).toBe(true); // status-only
    expect(out).not.toHaveProperty("payment_unavailable_reason");
    // rows that never join sellers keep today's shape too
    const bare = itemToPublic(row()) as Record<string, unknown>;
    expect(bare).not.toHaveProperty("payment_available");
    expect(bare.orderable).toBe(true);
  });

  it("flag ON: orderable + reason matrix mirrors the create_order refusals", () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.SELLER_COUNTRY_ALLOWLIST = "NL,DE";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";

    const ok = itemToPublic(row({ seller_payout_ready: true, seller_stripe_country: "NL" }));
    expect(ok).toMatchObject({ orderable: true, payment_available: true });
    expect(ok).not.toHaveProperty("payment_unavailable_reason");

    const notReady = itemToPublic(row({ seller_payout_ready: false, seller_stripe_country: null }));
    expect(notReady).toMatchObject({
      orderable: false,
      payment_available: false,
      payment_unavailable_reason: "seller_not_payout_ready",
    });

    const countryNull = itemToPublic(row({ seller_payout_ready: true, seller_stripe_country: null }));
    expect(countryNull).toMatchObject({
      orderable: false,
      payment_unavailable_reason: "seller_country_not_allowed",
    });

    const blocked = itemToPublic(row({ seller_payout_ready: true, seller_stripe_country: "US" }));
    expect(blocked).toMatchObject({
      orderable: false,
      payment_unavailable_reason: "seller_country_not_allowed",
    });

    const free = itemToPublic(row({ price_cents: 0, seller_payout_ready: true, seller_stripe_country: "NL" }));
    expect(free).toMatchObject({
      orderable: false,
      payment_available: false,
      payment_unavailable_reason: "free_item_not_orderable",
    });

    // non-active statuses stay unorderable for the status reason (no card-only reason attached)
    const reserved = itemToPublic(row({ status: "reserved", seller_payout_ready: true, seller_stripe_country: "NL" }));
    expect(reserved).toMatchObject({ orderable: false, payment_available: true });
    expect(reserved).not.toHaveProperty("payment_unavailable_reason");
  });

  it("flag ON: rows without seller data keep today's shape (no card-only fields)", () => {
    process.env.CARD_ONLY_MODE = "true";
    const bare = itemToPublic(row()) as Record<string, unknown>;
    expect(bare).not.toHaveProperty("payment_unavailable_reason");
    expect(bare).not.toHaveProperty("payment_available");
    expect(bare.orderable).toBe(true);
  });

  it("flag ON with an unconfigured deployment: nothing orderable (payments_not_configured)", () => {
    process.env.CARD_ONLY_MODE = "true";
    delete process.env.STRIPE_SECRET_KEY;
    const out = itemToPublic(row({ seller_payout_ready: true, seller_stripe_country: "NL" }));
    expect(out).toMatchObject({
      orderable: false,
      payment_available: false,
      payment_unavailable_reason: "payments_not_configured",
    });
  });
});

// --- Tool surfaces (DB) ------------------------------------------------------

describe.skipIf(!available)("card-only tool surfaces (DB): create_listing/update_listing/get_payout_setup", () => {
  let db: pg.Client;
  let n = 0;
  let sellerId = "";
  const registered = new Map<string, (a: Record<string, unknown>) => Promise<{ isError?: boolean; content?: { text?: string }[] }>>();

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await registered.get(name)!(args);
    return {
      isError: result.isError === true,
      body: result.content?.[0]?.text ? JSON.parse(result.content[0].text) : null,
    };
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
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    n += 1;
    const s = `co${n}`;
    await db.query("INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1,$2,$3)", [
      `thg_${s}`,
      s,
      `${s}@t.dev`,
    ]);
    sellerId = (await db.query("SELECT id FROM sellers WHERE email = $1", [`${s}@t.dev`])).rows[0].id;
    registered.clear();
    registerTools(
      {
        registerTool(name: string, _c: unknown, handler: never) {
          registered.set(name, handler as never);
        },
      } as never,
      { seller: { id: sellerId, display_name: s } } as never,
    );
    for (const k of KEYS) delete process.env[k];
    setStripeForTests(null);
  });

  const createArgs = (price = 10000, status?: string) => ({
    title: `Card only item ${n}`,
    description: "desc",
    category: "other",
    condition: "good" as const,
    price_cents: price,
    shipping_tier: "local" as const,
    currency: "EUR",
    images: [] as string[],
    attributes: {},
    ...(status ? { status } : {}),
  });

  it("flag OFF: create_listing/update_listing responses carry no warning key (regression)", async () => {
    const { body } = await callTool("create_listing", createArgs());
    expect(body.created).toBe(true);
    expect(body).not.toHaveProperty("warning");
    const upd = await callTool("update_listing", { id: body.item.id, status: "reserved" });
    expect(upd.body.updated).toBe(true);
    expect(upd.body).not.toHaveProperty("warning");
  });

  it("flag ON: create_listing warns (not rejects) for a not-payout-ready seller", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    const { body } = await callTool("create_listing", createArgs());
    expect(body.created).toBe(true); // publish succeeds — warning, not rejection
    expect(body.warning).toMatch(/Card-only deployment/);
    expect(body.warning).toMatch(/seller_not_payout_ready|payout onboarding/);
  });

  it("flag ON: no warning when the seller is onboarded within the allowlist", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await db.query(
      "UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now(), stripe_account_country = 'NL' WHERE id = $1",
      [sellerId],
    );
    const { body } = await callTool("create_listing", createArgs());
    expect(body.created).toBe(true);
    expect(body).not.toHaveProperty("warning");
  });

  it("flag ON: orderable flip stays quiet; a price-0 edit on an active listing warns (D5)", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    // seller fully payout-clear so the price-0 rule (D5) is the only blocker
    await db.query(
      "UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now(), stripe_account_country = 'NL' WHERE id = $1",
      [sellerId],
    );
    const { body } = await callTool("create_listing", createArgs(10000, "stored"));
    expect(body.item.status).toBe("stored");
    expect(body).not.toHaveProperty("warning"); // not published yet
    // payout-clear seller flipping to active: orderable, no warning
    const flip = await callTool("update_listing", { id: body.item.id, status: "active" });
    expect(flip.body.updated).toBe(true);
    expect(flip.body).not.toHaveProperty("warning");
    // price → 0 on an active listing under flag: unorderable, seller told
    const zero = await callTool("update_listing", { id: body.item.id, price_cents: 0 });
    expect(zero.body.updated).toBe(true);
    expect(zero.body.warning).toMatch(/price-0/);
    // THI-1798 F3: the update echo joins the seller's payout gate, so the
    // status-only orderable=true no longer sits beside a contradiction.
    expect(zero.body.item.orderable).toBe(false);
    expect(zero.body.item.payment_unavailable_reason).toBe("free_item_not_orderable");
  });

  it("flag ON: create echo pairs narrowed orderable flags with the warning (THI-1798 F3)", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    const { body } = await callTool("create_listing", createArgs());
    expect(body.warning).toMatch(/Card-only deployment/);
    // Pre-F3 this echo carried status-only orderable=true beside the warning.
    expect(body.item.orderable).toBe(false);
    expect(body.item.payment_unavailable_reason).toBe("seller_not_payout_ready");
    expect(body.item.card_only_mode).toBe(true);
  });

  it("flag ON: update_listing (stored→active) echo carries the same narrowed flags", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    const { body } = await callTool("create_listing", createArgs(10000, "stored"));
    const flip = await callTool("update_listing", { id: body.item.id, status: "active" });
    expect(flip.body.warning).toMatch(/Card-only deployment/);
    expect(flip.body.item.orderable).toBe(false);
    expect(flip.body.item.payment_unavailable_reason).toBe("seller_not_payout_ready");
    expect(flip.body.item.card_only_mode).toBe(true);
  });

  it("get_item: card_only_mode marker under the flag, absent flag-off", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await db.query(
      "UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now(), stripe_account_country = 'NL' WHERE id = $1",
      [sellerId],
    );
    const created = await callTool("create_listing", createArgs());
    const on = await callTool("get_item", { id: created.body.item.id });
    expect(on.body.item.card_only_mode).toBe(true);
    expect(on.body.item.orderable).toBe(true);
    expect(on.body.item).not.toHaveProperty("payment_unavailable_reason");
    for (const k of KEYS) delete process.env[k];
    const off = await callTool("get_item", { id: created.body.item.id });
    expect(off.body.item).not.toHaveProperty("card_only_mode");
    expect(off.body.item.orderable).toBe(true);
  });

  it("flag ON: get_payout_setup names the country block after onboarding (D4)", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.SELLER_COUNTRY_ALLOWLIST = "NL,DE";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await db.query(
      "UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now(), stripe_account_country = 'US' WHERE id = $1",
      [sellerId],
    );
    const fake = {
      accounts: { retrieve: async () => ({ id: "acct_x", type: "none", country: "US", capabilities: {} }) },
      v2: { core: { accounts: { create: async () => ({ id: "acct_x" }), update: async () => ({}) }, accountLinks: { create: async () => ({ url: "https://onboard.test/1" }) } } },
      checkout: { sessions: { create: async () => ({ id: "cs_1", url: "https://pay.test/1" }), expire: async () => ({}) } },
      transfers: { create: async () => ({}) },
      refunds: { create: async () => ({}) },
    } as unknown as Stripe;
    setStripeForTests(fake);
    const { body } = await callTool("get_payout_setup");
    expect(body.onboarded).toBe(true);
    expect(body.card_orders_blocked_reason).toBe("seller_country_not_allowed");
    expect(body.note).toMatch(/country is not enabled for card orders/);
    // allowlist cleared → no country note, no field
    delete process.env.SELLER_COUNTRY_ALLOWLIST;
    const cleared = await callTool("get_payout_setup");
    expect(cleared.body).not.toHaveProperty("card_orders_blocked_reason");
    expect(cleared.body.note).not.toMatch(/country is not enabled/);
  });

  it("flag ON: unconfigured deployment error no longer promises off-platform orders", async () => {
    process.env.CARD_ONLY_MODE = "true";
    delete process.env.STRIPE_SECRET_KEY;
    const { isError, body } = await callTool("get_payout_setup");
    expect(isError).toBe(true);
    expect(body.code).toBe("payments_not_configured");
    expect(body.error).toMatch(/Card-only mode is on/);
    expect(body.error).not.toMatch(/off-platform orders/);
  });
});

// --- create_order refactor regression (same predicate drives refusals) ------

describe.skipIf(!available)("create_order via the shared predicate (B-1 regression, DB)", () => {
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
  });
  beforeEach(async () => {
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    n += 1;
    const s = `cp${n}`, b = `cq${n}`;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    const r = await db.query(
      "SELECT (SELECT id FROM sellers WHERE email=$1) AS seller, (SELECT id FROM sellers WHERE email=$2) AS buyer",
      [`${s}@t.dev`, `${b}@t.dev`],
    );
    ids.sellerId = r.rows[0].seller;
    ids.buyerId = r.rows[0].buyer;
    for (const k of KEYS) delete process.env[k];
    setStripeForTests(null);
  });

  const seedItem = async (price = 10000) => {
    const item = await db.query(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, shipping_tier, status) VALUES ($1,$2,$3,500,'local','active') RETURNING id",
      [ids.sellerId, `Item ${n}`, price],
    );
    return item.rows[0].id as string;
  };

  it("flag ON: refusals keep B-1 codes/messages via the shared predicate", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    process.env.SELLER_COUNTRY_ALLOWLIST = "NL,DE";

    const freeId = await seedItem(0);
    await expect(createOrder({ buyerId: ids.buyerId, itemId: freeId })).rejects.toMatchObject({
      code: "free_item_not_orderable",
    });

    const blockedId = await seedItem();
    await db.query(
      "UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now(), stripe_account_country = 'US' WHERE id = $1",
      [ids.sellerId],
    );
    await expect(createOrder({ buyerId: ids.buyerId, itemId: blockedId })).rejects.toBeInstanceOf(OrderFlowError);
    await expect(createOrder({ buyerId: ids.buyerId, itemId: blockedId })).rejects.toMatchObject({
      code: "seller_country_not_allowed",
    });
    await expect(createOrder({ buyerId: ids.buyerId, itemId: blockedId })).rejects.toMatchObject({
      message: "The seller's payout country is not enabled for card orders on this deployment.",
    });

    // allowlist cleared → same seller now orderable via stripe (pickup, no address)
    delete process.env.SELLER_COUNTRY_ALLOWLIST;
    const fake = {
      accounts: { retrieve: async () => ({ id: "acct_x", type: "none", country: "US", capabilities: {} }) },
      v2: { core: { accounts: { create: async () => ({ id: "acct_x" }), update: async () => ({}) }, accountLinks: { create: async () => ({ url: "https://onboard.test/1" }) } } },
      checkout: { sessions: { create: async () => ({ id: "cs_1", url: "https://pay.test/1" }), expire: async () => ({}) } },
      transfers: { create: async () => ({}) },
      refunds: { create: async () => ({}) },
    } as unknown as Stripe;
    setStripeForTests(fake);
    const { order, paymentUrl } = await createOrder({ buyerId: ids.buyerId, itemId: blockedId });
    expect(order.payment_mode).toBe("stripe");
    expect(paymentUrl).toBe("https://pay.test/1");
  });

  it("config still parses fresh from env (flag mechanics unchanged)", () => {
    process.env.CARD_ONLY_MODE = "true";
    expect(orderFlowConfig().cardOnlyMode).toBe(true);
    delete process.env.CARD_ONLY_MODE;
    expect(orderFlowConfig().cardOnlyMode).toBe(false);
  });
});

// --- THI-1798 F1: get_seller_summary / my_matches carry the country --------

// F1 (THI-1798): itemToPublic's card-only branch triggers on any row with
// seller_payout_ready. The two payout-joining selects missed by the B-2
// surface inventory (get_seller_summary listings, my_matches) rendered every
// listing unorderable with seller_country_not_allowed under an allowlist —
// while get_item on the same item said orderable — because the predicate
// received country=null. These assertions fail on the pre-fix selects.
describe.skipIf(!available)("card-only orderability on get_seller_summary and my_matches (THI-1798 F1, DB)", () => {
  let db: pg.Client;
  let n = 0;
  let sellerName = "";
  const ids = { sellerId: "", buyerId: "", itemId: "" };
  const registered = new Map<string, (a: Record<string, unknown>) => Promise<{ isError?: boolean; content?: { text?: string }[] }>>();

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await registered.get(name)!(args);
    return {
      isError: result.isError === true,
      body: result.content?.[0]?.text ? JSON.parse(result.content[0].text) : null,
    };
  };

  const registerAs = (sellerId: string, displayName: string) => {
    registered.clear();
    registerTools(
      {
        registerTool(name: string, _c: unknown, handler: never) {
          registered.set(name, handler as never);
        },
      } as never,
      { seller: { id: sellerId, display_name: displayName } } as never,
    );
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
    await db.query("TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE");
    n += 1;
    const s = `cs${n}`, b = `ct${n}`;
    sellerName = s;
    await db.query(
      "INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1,$2,$3), ($4,$5,$6)",
      [`thg_${s}`, s, `${s}@t.dev`, `thg_${b}`, b, `${b}@t.dev`],
    );
    const r = await db.query(
      "SELECT (SELECT id FROM sellers WHERE email=$1) AS seller, (SELECT id FROM sellers WHERE email=$2) AS buyer",
      [`${s}@t.dev`, `${b}@t.dev`],
    );
    ids.sellerId = r.rows[0].seller;
    ids.buyerId = r.rows[0].buyer;
    const item = await db.query(
      "INSERT INTO items (seller_id, title, price_cents, shipping_price_cents, shipping_tier, status, photo_required) VALUES ($1,$2,10000,500,'local','active',false) RETURNING id",
      [ids.sellerId, `F1 item ${n}`],
    );
    ids.itemId = item.rows[0].id as string;
    registerAs(ids.sellerId, s);
    for (const k of KEYS) delete process.env[k];
    setStripeForTests(null);
  });

  const onboardSeller = async (country: string | null) =>
    db.query(
      "UPDATE sellers SET stripe_account_id = 'acct_x', stripe_onboarded_at = now(), stripe_account_country = $2 WHERE id = $1",
      [ids.sellerId, country],
    );

  const seedMatch = async () => {
    const intent = await db.query(
      "INSERT INTO buyer_intents (buyer_id, q, currency) VALUES ($1,$2,'EUR') RETURNING id",
      [ids.buyerId, `f1 wanted thing ${n}`],
    );
    await db.query("INSERT INTO intent_matches (intent_id, buyer_id, item_id, score) VALUES ($1,$2,$3,0.9)", [
      intent.rows[0].id,
      ids.buyerId,
      ids.itemId,
    ]);
  };

  it("flag ON + allowlist: onboarded in-allowlist seller is orderable on BOTH surfaces", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.SELLER_COUNTRY_ALLOWLIST = "NL,DE";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await onboardSeller("NL");
    await seedMatch();

    const summary = await callTool("get_seller_summary", { seller_id: ids.sellerId, limit: 8 });
    expect(summary.isError).toBe(false);
    const listing = summary.body.listings[0];
    expect(listing.id).toBe(ids.itemId);
    expect(listing).toMatchObject({ orderable: true, payment_available: true });
    expect(listing).not.toHaveProperty("payment_unavailable_reason");

    registerAs(ids.buyerId, `ct${n}`);
    const matches = await callTool("my_matches", {});
    expect(matches.isError).toBe(false);
    const matchItem = matches.body.matches[0].item;
    expect(matchItem.id).toBe(ids.itemId);
    expect(matchItem).toMatchObject({ orderable: true, payment_available: true });
    expect(matchItem).not.toHaveProperty("payment_unavailable_reason");
  });

  it("flag ON + allowlist: blocked-country seller shows seller_country_not_allowed on BOTH surfaces", async () => {
    process.env.CARD_ONLY_MODE = "true";
    process.env.SELLER_COUNTRY_ALLOWLIST = "NL,DE";
    process.env.STRIPE_SECRET_KEY = "sk_test_k1";
    await onboardSeller("US");
    await seedMatch();

    const summary = await callTool("get_seller_summary", { seller_id: ids.sellerId, limit: 8 });
    expect(summary.body.listings[0]).toMatchObject({
      orderable: false,
      payment_unavailable_reason: "seller_country_not_allowed",
    });

    registerAs(ids.buyerId, `ct${n}`);
    const matches = await callTool("my_matches", {});
    expect(matches.body.matches[0].item).toMatchObject({
      orderable: false,
      payment_unavailable_reason: "seller_country_not_allowed",
    });
  });

  it("flag OFF: neither surface ever gains card-only fields (byte-for-byte regression)", async () => {
    await onboardSeller("NL");
    await seedMatch();

    const summary = await callTool("get_seller_summary", { seller_id: ids.sellerId, limit: 8 });
    expect(summary.body.listings[0]).not.toHaveProperty("payment_unavailable_reason");

    registerAs(ids.buyerId, `ct${n}`);
    const matches = await callTool("my_matches", {});
    expect(matches.body.matches[0].item).not.toHaveProperty("payment_unavailable_reason");
  });
});
