// get_seller_summary (THI-923 "Who's selling", PR A; spec v2 = document
// `spec` on THI-933, revision 334d4d70). Nine groups:
//   1. Allowlist (privacy)      — the seller allowlist is exact; sensitive
//                                 columns (email, profile JSONB, stripe ids,
//                                 hashes) never reach the output.
//   2. Display-name guard (F1)  — signup-default display_name (email
//                                 local-part) is masked to "Thingery seller".
//   3. Sold-count status matrix — the sealed 12-status matrix: exactly the
//                                 8 SOLD_COUNT_STATUSES statuses count.
//   4. joined_month format      — YYYY-MM (UTC), never a full timestamp.
//   5. ships_from               — modal location, deterministic tie-break,
//                                 null when nothing is located.
//   6. Payment parity           — seller.payment_available matches the
//                                 item page (itemToPublic) across the
//                                 stripe-unconfigured / not-onboarded /
//                                 onboarded matrix.
//   7. Listings pagination      — limit/offset/has_more, feed-visible
//                                 actives only, newest first.
//   8. Errors                   — unknown seller → typed not_found; bad
//                                 input → zod rejection.
//   9. Anonymous access         — handler runs with no credentials; the tool
//                                 is NOT in PROTECTED_TOOLS and IS in the
//                                 directory profile.
//
// DB-backed (skips without a reachable Postgres); runs after scripts/migrate
// applied db/schema.sql (CI) — fileParallelism=false makes the TRUNCATE safe.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getSellerSummary,
  sellerToPublic,
  SellerNotFoundError,
  MASKED_DISPLAY_NAME,
} from "../src/sellers.js";
import { ORDER_STATUSES, SOLD_COUNT_STATUSES, type OrderStatus } from "../src/orders.js";
import { DIRECTORY_PROFILE_TOOLS, itemToPublic, PROTECTED_TOOLS, SESSION_ONLY_TOOLS, registerTools } from "../src/tools.js";

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

/** The sealed sold-count matrix, named in the test per spec v2: exactly these
 *  8 count; these 4 do not. Cross-checked against SOLD_COUNT_STATUSES below
 *  so the constant, the SQL and this matrix cannot drift apart silently. */
const COUNTING_STATUSES = [
  "sold", "label_issued", "in_transit", "delivered", "disputed",
  "payout_pending", "paid_out", "completed",
] as const satisfies readonly OrderStatus[];
const NOT_COUNTING_STATUSES = ["pending", "cancelled", "refunding", "refunded"] as const satisfies readonly OrderStatus[];

describe.skipIf(!available)("get_seller_summary (THI-923 spec v2)", () => {
  let db: pg.Client;

  interface Captured {
    config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny>; annotations?: Record<string, unknown> };
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  }
  const registered = new Map<string, Captured>();

  interface Seeded {
    sellerId: string;
    itemIds: string[];
    orderIds: string[];
  }
  const seeded: Seeded[] = [];

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    await db.query(
      "TRUNCATE order_events, webhook_events, orders, items, sellers RESTART IDENTITY CASCADE",
    );
    // Capture the anonymous registration: get_seller_summary must exist there
    // (public read) — group 9 calls its handler with seller: null.
    registerTools(
      {
        registerTool(name: string, config: Captured["config"], handler: Captured["handler"]) {
          registered.set(name, { config, handler });
        },
      },
      { seller: null },
    );
  });

  afterAll(async () => {
    for (const s of seeded) {
      await db.query("DELETE FROM orders WHERE seller_id = $1 OR buyer_id = $1", [s.sellerId]);
      await db.query("DELETE FROM items WHERE seller_id = $1", [s.sellerId]);
      await db.query("DELETE FROM sellers WHERE id = $1", [s.sellerId]);
    }
    await db.end();
  });

  // -- seed helpers ---------------------------------------------------------

  async function seedSeller(opts: {
    displayName: string;
    email?: string | null;
    profile?: Record<string, unknown>;
    passwordHash?: string;
    apiKeyHash?: string;
    sessionEpoch?: number;
    emailVerificationTokenHash?: string;
    stripeAccountId?: string;
    stripeOnboarded?: boolean;
    createdAt?: string;
  }): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sellers
         (display_name, email, profile, password_hash, api_key_hash, session_epoch,
          email_verification_token_hash, stripe_account_id, stripe_onboarded_at, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()))
       RETURNING id`,
      [
        opts.displayName,
        opts.email ?? null,
        JSON.stringify(opts.profile ?? {}),
        opts.passwordHash ?? null,
        opts.apiKeyHash ?? null,
        opts.sessionEpoch ?? 0,
        opts.emailVerificationTokenHash ?? null,
        opts.stripeAccountId ?? null,
        opts.stripeOnboarded ? new Date().toISOString() : null,
        opts.createdAt ?? null,
      ],
    );
    seeded.push({ sellerId: rows[0].id, itemIds: [], orderIds: [] });
    return rows[0].id;
  }

  async function seedItem(sellerId: string, opts: {
    title?: string;
    location?: string | null;
    status?: string;
    photoRequired?: boolean;
    images?: string[];
    createdAt?: string;
  }): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO items
         (seller_id, title, category, price_cents, currency, location, shipping_tier,
          images, status, photo_required, created_at)
       VALUES ($1, $2, 'other', 1000, 'EUR', $3, 'parcel', $4::text[], $5, $6,
               COALESCE($7::timestamptz, now()))
       RETURNING id`,
      [
        sellerId,
        opts.title ?? "Test item listing",
        opts.location ?? null,
        opts.images ?? [],
        opts.status ?? "active",
        opts.photoRequired ?? false,
        opts.createdAt ?? null,
      ],
    );
    seeded.find((s) => s.sellerId === sellerId)?.itemIds.push(rows[0].id);
    return rows[0].id;
  }

  async function seedOrder(sellerId: string, itemId: string, status: OrderStatus): Promise<string> {
    const buyerId = await seedBuyerOnce();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO orders (item_id, seller_id, buyer_id, status, price_cents, currency, fulfillment)
       VALUES ($1, $2, $3, $4, 1000, 'EUR', 'shipping') RETURNING id`,
      [itemId, sellerId, buyerId, status],
    );
    seeded.find((s) => s.sellerId === sellerId)?.orderIds.push(rows[0].id);
    return rows[0].id;
  }

  let buyerId: string | null = null;
  async function seedBuyerOnce(): Promise<string> {
    if (buyerId) return buyerId;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sellers (display_name) VALUES ('buyer-for-order-fixture') RETURNING id`,
    );
    buyerId = rows[0].id;
    // The buyer is deleted with the last seeded seller's cleanup pass —
    // track it on the first seeded entry so afterAll removes it.
    if (seeded.length > 0) seeded[0].orderIds.push("__buyer__");
    return buyerId;
  }

  /** Calls the captured get_seller_summary handler and parses the JSON body. */
  async function callTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const captured = registered.get("get_seller_summary");
    if (!captured) throw new Error("get_seller_summary was not registered");
    const result = (await captured.handler(args)) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  }

  function lastSeeded(): Seeded {
    return seeded[seeded.length - 1];
  }

  // -- group 1: allowlist (privacy) -----------------------------------------

  it("returns exactly the seller allowlist — no email, profile, stripe or hash columns leak", async () => {
    const tag = randomUUID();
    const sellerId = await seedSeller({
      displayName: "Allowlist Annie",
      email: `annie-${tag}@t.dev`,
      profile: { canary_profile_key: "CANARY-PROFILE-VALUE" },
      passwordHash: "CANARY-PWHASH",
      apiKeyHash: "CANARY-KEYHASH",
      sessionEpoch: 3,
      emailVerificationTokenHash: "CANARY-TOKENHASH",
      stripeAccountId: "CANARY-STRIPE-ACCT",
      stripeOnboarded: true,
    });
    await seedItem(sellerId, { title: "Allowlist probe item", location: "Torino, IT" });

    const body = await callTool({ seller_id: sellerId });
    const seller = body.seller as Record<string, unknown>;

    // Exact allowlist: eight fields, nothing else.
    expect(Object.keys(seller).sort()).toEqual(
      [
        "active_listings_total",
        "display_name",
        "id",
        "joined_month",
        "payment_available",
        "reviews",
        "ships_from",
        "sold_count",
      ].sort(),
    );
    expect(seller.display_name).toBe("Allowlist Annie");
    // Reviews seam (THI-925): constant zeros until real reviews land.
    expect(seller.reviews).toEqual({ count: 0, average: null });

    // The serialized boundary must not carry any sensitive column or canary.
    const serialized = JSON.stringify(body);
    for (const canary of [
      "CANARY-PROFILE-VALUE",
      "CANARY-PWHASH",
      "CANARY-KEYHASH",
      "CANARY-TOKENHASH",
      "CANARY-STRIPE-ACCT",
      `annie-${tag}`, // email local-part (and display_name, if the guard leaked it)
      "password_hash",
      "api_key_hash",
      "stripe_account_id",
      "email_verification",
    ]) {
      expect(serialized).not.toContain(canary);
    }

    // Listings are itemToPublic + content_provenance — key-set parity with a
    // row mapped straight from the DB (no extra fields, none missing).
    const listings = body.listings as Record<string, unknown>[];
    expect(listings).toHaveLength(1);
    const { rows } = await db.query(
      "SELECT i.*, (s.stripe_account_id IS NOT NULL AND s.stripe_onboarded_at IS NOT NULL) AS seller_payout_ready FROM items i LEFT JOIN sellers s ON s.id = i.seller_id WHERE i.id = $1",
      [lastSeeded().itemIds[0]],
    );
    const expectedKeys = Object.keys({
      ...itemToPublic(rows[0]),
      content_provenance: "user_generated",
    }).sort();
    expect(Object.keys(listings[0]).sort()).toEqual(expectedKeys);
    expect(listings[0].content_provenance).toBe("user_generated");
    // The item row must not carry its embedding column through either.
    expect(Object.keys(listings[0])).not.toContain("embedding");

    // Module-level call agrees with the handler path.
    const direct = await getSellerSummary(sellerId, { limit: 8, offset: 0 });
    expect(direct.seller).toEqual(seller);
  });

  // -- group 2: display-name guard (F1) --------------------------------------

  it("masks a signup-default display_name (email local-part) and never publishes the email (F1)", async () => {
    const tag = randomUUID();
    const maskedId = await seedSeller({
      // Exactly what /signup derives from the email local-part (src/routes.ts).
      displayName: `ghost1-${tag}`,
      email: `ghost1-${tag}@t.dev`,
    });
    const chosenId = await seedSeller({
      displayName: "Alice's Attic",
      email: `alice-${tag}@t.dev`,
    });
    const nullEmailId = await seedSeller({ displayName: "Null Email Ned", email: null });

    const masked = (await callTool({ seller_id: maskedId })).seller as Record<string, unknown>;
    expect(masked.display_name).toBe(MASKED_DISPLAY_NAME);
    expect(JSON.stringify(masked)).not.toContain(`ghost1-${tag}`);

    const chosen = (await callTool({ seller_id: chosenId })).seller as Record<string, unknown>;
    expect(chosen.display_name).toBe("Alice's Attic");

    // NULL email → nothing to match → the chosen name passes verbatim.
    const nullEmail = (await callTool({ seller_id: nullEmailId })).seller as Record<string, unknown>;
    expect(nullEmail.display_name).toBe("Null Email Ned");

    // sellerToPublic is pure — assert the guard's exact-match semantics.
    expect(
      sellerToPublic(
        { id: "x", display_name: "ghost1", email: "ghost1@t.dev", joined_month: "2026-11" },
        { ships_from: null, sold_count: 0, active_listings_total: 0, payment_available: false },
      ).display_name,
    ).toBe(MASKED_DISPLAY_NAME);
    // Same-by-coincidence chosen names are masked too (accepted over-blocking).
    expect(
      sellerToPublic(
        { id: "x", display_name: "sam", email: "sam@other.test", joined_month: "2026-11" },
        { ships_from: null, sold_count: 0, active_listings_total: 0, payment_available: false },
      ).display_name,
    ).toBe(MASKED_DISPLAY_NAME);
    // Partial local-part matches are NOT masked (exact match only).
    expect(
      sellerToPublic(
        { id: "x", display_name: "ghost1-plus", email: "ghost1@t.dev", joined_month: "2026-11" },
        { ships_from: null, sold_count: 0, active_listings_total: 0, payment_available: false },
      ).display_name,
    ).toBe("ghost1-plus");
  });

  // -- group 3: sold-count status matrix --------------------------------------

  it("counts exactly the 8 SOLD_COUNT_STATUSES statuses of the sealed 12-status matrix (F3)", async () => {
    const tag = randomUUID();
    const sellerId = await seedSeller({ displayName: "Seller Matrix", email: `matrix-${tag}@t.dev` });

    // F3: the constant is the single source of truth — sealed and complete.
    expect(SOLD_COUNT_STATUSES.length).toBe(8);
    expect(new Set(SOLD_COUNT_STATUSES).size).toBe(SOLD_COUNT_STATUSES.length);
    expect([...SOLD_COUNT_STATUSES].sort()).toEqual([...COUNTING_STATUSES].sort());
    expect([...ORDER_STATUSES].sort()).toEqual(
      [...COUNTING_STATUSES, ...NOT_COUNTING_STATUSES].sort(),
    );

    // One order in every one of the 12 statuses → count = 8.
    for (const status of ORDER_STATUSES) {
      const itemId = await seedItem(sellerId, { title: `Matrix item ${status}` });
      await seedOrder(sellerId, itemId, status);
    }
    const body = await callTool({ seller_id: sellerId });
    expect((body.seller as Record<string, unknown>).sold_count).toBe(8);
  });

  // -- group 4: joined_month format -------------------------------------------

  it("returns joined_month as YYYY-MM (UTC), never a full timestamp", async () => {
    const tag = randomUUID();
    const sellerId = await seedSeller({
      displayName: "March Seller",
      email: `march-${tag}@t.dev`,
      // 23:30 in +02:00 is 21:30 UTC on 2026-03-31 — still March in UTC.
      createdAt: "2026-03-31T23:30:00+02:00",
    });
    const seller = (await callTool({ seller_id: sellerId })).seller as Record<string, unknown>;
    expect(seller.joined_month).toBe("2026-03");
    expect(JSON.stringify(seller)).not.toContain("2026-03-31");
    expect(JSON.stringify(seller)).not.toContain("T2"); // no time component anywhere
  });

  // -- group 5: ships_from ------------------------------------------------------

  it("ships_from is the modal location (deterministic tie-break), null when nothing is located", async () => {
    const tag = randomUUID();

    // Mode wins: Milano x2, Roma x1, unlocated x1.
    const modeSeller = await seedSeller({ displayName: "Mode Seller", email: `mode-${tag}@t.dev` });
    await seedItem(modeSeller, { location: "Milano, IT", createdAt: "2026-01-01" });
    await seedItem(modeSeller, { location: "Milano, IT", createdAt: "2026-01-02" });
    await seedItem(modeSeller, { location: "Roma, IT", createdAt: "2026-01-03" });
    await seedItem(modeSeller, { location: null, createdAt: "2026-01-04" });
    let seller = (await callTool({ seller_id: modeSeller })).seller as Record<string, unknown>;
    expect(seller.ships_from).toBe("Milano, IT");

    // Tie 1–1 → lexicographically first.
    const tieSeller = await seedSeller({ displayName: "Tie Seller", email: `tie-${tag}@t.dev` });
    await seedItem(tieSeller, { location: "Roma, IT" });
    await seedItem(tieSeller, { location: "Milano, IT" });
    seller = (await callTool({ seller_id: tieSeller })).seller as Record<string, unknown>;
    expect(seller.ships_from).toBe("Milano, IT");

    // No locations at all → null.
    const noneSeller = await seedSeller({ displayName: "No Location", email: `none-${tag}@t.dev` });
    await seedItem(noneSeller, { location: null });
    seller = (await callTool({ seller_id: noneSeller })).seller as Record<string, unknown>;
    expect(seller.ships_from).toBeNull();

    // Empty-string locations are not locations.
    const emptySeller = await seedSeller({ displayName: "Empty Location", email: `empty-${tag}@t.dev` });
    await seedItem(emptySeller, { location: "" });
    seller = (await callTool({ seller_id: emptySeller })).seller as Record<string, unknown>;
    expect(seller.ships_from).toBeNull();
  });

  // -- group 6: payment parity ---------------------------------------------------

  it("payment_available matches the item page across the stripe/onboarding matrix", async () => {
    const tag = randomUUID();
    const unsetSeller = await seedSeller({ displayName: "No Stripe", email: `nos-${tag}@t.dev` });
    const partialSeller = await seedSeller({
      displayName: "Half Onboarded",
      email: `half-${tag}@t.dev`,
      stripeAccountId: "acct_HALF",
      stripeOnboarded: false,
    });
    const readySeller = await seedSeller({
      displayName: "Fully Onboarded",
      email: `full-${tag}@t.dev`,
      stripeAccountId: "acct_FULL",
      stripeOnboarded: true,
    });
    for (const s of [unsetSeller, partialSeller, readySeller]) {
      await seedItem(s, { title: "Parity probe item" });
    }

    const savedKey = process.env.STRIPE_SECRET_KEY;
    try {
      // (a) Stripe unconfigured — kill switch: everything false.
      delete process.env.STRIPE_SECRET_KEY;
      for (const s of [unsetSeller, partialSeller, readySeller]) {
        const body = await callTool({ seller_id: s });
        const seller = body.seller as Record<string, unknown>;
        expect(seller.payment_available).toBe(false);
        const listing = (body.listings as Record<string, unknown>[])[0];
        // Parity with the item page (get_item → itemToPublic).
        expect(listing.payment_available).toBe(false);
        expect(seller.payment_available).toBe(listing.payment_available);
      }

      // (b/c) Stripe configured — only fully-onboarded sellers sell with card.
      process.env.STRIPE_SECRET_KEY = "sk_test_parity";
      const expected: Record<string, boolean> = {
        [unsetSeller]: false,
        [partialSeller]: false,
        [readySeller]: true,
      };
      for (const s of [unsetSeller, partialSeller, readySeller]) {
        const body = await callTool({ seller_id: s });
        const seller = body.seller as Record<string, unknown>;
        expect(seller.payment_available).toBe(expected[s]);
        const listing = (body.listings as Record<string, unknown>[])[0];
        expect(listing.payment_available).toBe(expected[s]);
        expect(seller.payment_available).toBe(listing.payment_available);
      }
    } finally {
      if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = savedKey;
    }
  });

  // -- group 7: listings pagination ---------------------------------------------

  it("paginates feed-visible active listings newest-first with honest has_more", async () => {
    const tag = randomUUID();
    const sellerId = await seedSeller({ displayName: "Pager Seller", email: `pager-${tag}@t.dev` });
    // Five visible listings, oldest first; created_at drives the order.
    const visibleIds: string[] = [];
    for (let i = 1; i <= 5; i++) {
      visibleIds.push(
        await seedItem(sellerId, {
          title: `Pager item ${i}`,
          createdAt: `2026-01-0${i}T12:00:00Z`,
        }),
      );
    }
    // The invisibles: stored, reserved, sold, deleted, and a photo-gated
    // active item — none may appear on any page or in the totals.
    await seedItem(sellerId, { title: "Stored private item", status: "stored" });
    await seedItem(sellerId, { title: "Reserved item", status: "reserved" });
    await seedItem(sellerId, { title: "Sold item", status: "sold" });
    await seedItem(sellerId, { title: "Deleted item", status: "deleted" });
    await seedItem(sellerId, { title: "Photo gated item", photoRequired: true, images: [] });

    const page1 = await callTool({ seller_id: sellerId, limit: 2, offset: 0 });
    expect(page1.count).toBe(2);
    expect(page1.has_more).toBe(true);
    let listings = page1.listings as { id: string }[];
    expect(listings.map((l) => l.id)).toEqual([visibleIds[4], visibleIds[3]]);

    const page2 = await callTool({ seller_id: sellerId, limit: 2, offset: 2 });
    expect(page2.count).toBe(2);
    expect(page2.has_more).toBe(true);
    listings = page2.listings as { id: string }[];
    expect(listings.map((l) => l.id)).toEqual([visibleIds[2], visibleIds[1]]);

    const page3 = await callTool({ seller_id: sellerId, limit: 2, offset: 4 });
    expect(page3.count).toBe(1);
    expect(page3.has_more).toBe(false);
    listings = page3.listings as { id: string }[];
    expect(listings.map((l) => l.id)).toEqual([visibleIds[0]]);

    // Totals are page-independent: 5 feed-visible actives, no matter the page.
    for (const offset of [0, 2, 4]) {
      const body = await callTool({ seller_id: sellerId, limit: 2, offset });
      expect((body.seller as Record<string, unknown>).active_listings_total).toBe(5);
    }
    // Off-page statuses must not leak into any page.
    const all = JSON.stringify(
      (await callTool({ seller_id: sellerId, limit: 5, offset: 0 })).listings,
    );
    expect(all).not.toContain("Stored private item");
    expect(all).not.toContain("Reserved item");
    expect(all).not.toContain("Sold item");
    expect(all).not.toContain("Deleted item");
    expect(all).not.toContain("Photo gated item");
  });

  // -- group 8: errors -------------------------------------------------------------

  it("unknown seller → typed not_found; bad input → zod rejection", async () => {
    // Module level.
    let caught: unknown;
    try {
      await getSellerSummary(randomUUID(), { limit: 8, offset: 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SellerNotFoundError);
    expect((caught as SellerNotFoundError).code).toBe("not_found");

    // Handler level: typed error payload.
    const captured = registered.get("get_seller_summary");
    if (!captured) throw new Error("get_seller_summary was not registered");
    const result = (await captured.handler({ seller_id: randomUUID() })) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content?.[0]?.text ?? "{}");
    expect(body.code).toBe("not_found");

    // Input schema: uuid required; limit/offset bounded with zod defaults.
    const schema = z.object(captured.config.inputSchema ?? {});
    expect(schema.safeParse({ seller_id: "not-a-uuid" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    const okParse = schema.safeParse({ seller_id: randomUUID() });
    expect(okParse.success).toBe(true);
    if (okParse.success) expect(okParse.data.limit).toBe(8); // zod default
    expect(schema.safeParse({ seller_id: randomUUID(), limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ seller_id: randomUUID(), limit: 51 }).success).toBe(false);
    expect(schema.safeParse({ seller_id: randomUUID(), offset: 451 }).success).toBe(false);
  });

  // -- group 9: anonymous access ------------------------------------------------

  it("is anonymous-readable: not PROTECTED/SESSION_ONLY, in the directory profile, handler runs with no credentials", async () => {
    const tag = randomUUID();
    const sellerId = await seedSeller({ displayName: "Anonymous Annie", email: `anon-${tag}@t.dev` });
    await seedItem(sellerId, { title: "Anonymous probe item" });

    expect(PROTECTED_TOOLS.has("get_seller_summary")).toBe(false);
    expect(SESSION_ONLY_TOOLS.has("get_seller_summary")).toBe(false);
    expect(DIRECTORY_PROFILE_TOOLS.has("get_seller_summary")).toBe(true);

    // The registration captured in beforeAll used { seller: null } — the
    // anonymous context. The handler must succeed without any credential.
    const body = await callTool({ seller_id: sellerId });
    expect((body.seller as Record<string, unknown>).display_name).toBe("Anonymous Annie");
    expect(body.count).toBe(1);
    expect(body.has_more).toBe(false);
    expect(typeof body.note).toBe("string");
  });
});
