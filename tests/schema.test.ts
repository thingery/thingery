// Schema migration test (spec THI-11 rev 2, PR 1).
// Applies db/schema.sql to a fresh database and asserts the OAuth tables exist
// with the normative columns; re-applies to prove idempotency (expand-only).
// Skips when no Postgres is reachable so bare `npm test` stays green locally.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");

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

describe.skipIf(!available)("db schema", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it("applies the schema to a fresh database without error", async () => {
    // Hermetic: drop the OAuth tables so every run exercises a true fresh apply
    // (the file uses CREATE TABLE IF NOT EXISTS, which would otherwise no-op).
    // Wrapped in a transaction: vitest runs test files in parallel workers, so
    // the drop/recreate must be atomic to concurrent DB users (THI-31) — without
    // the txn, oauth-register.test.ts can observe a window with no oauth
    // tables and fail with 42P01-driven 500s.
    await client.query("BEGIN");
    try {
      await client.query(
        `DROP TABLE IF EXISTS oauth_codes, oauth_tokens, oauth_grants, oauth_clients CASCADE`,
      );
      await client.query(readFileSync(schemaPath, "utf8"));
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  it("is idempotent: re-applying the schema is a no-op", async () => {
    await client.query(readFileSync(schemaPath, "utf8"));
  });

  it("creates the OAuth tables with the normative columns (THI-11 §3)", async () => {
    const expected: Record<string, string[]> = {
      oauth_clients: ["client_id", "client_name", "client_uri", "redirect_uris", "created_at", "authorized_at"],
      oauth_grants: ["id", "seller_id", "client_id", "scope", "created_at", "revoked_at"],
      oauth_tokens: [
        "id",
        "grant_id",
        "kind",
        "token_hash",
        "expires_at",
        "revoked_at",
        "created_at",
        "last_used_at",
      ],
      oauth_codes: [
        "code_hash",
        "grant_id",
        "client_id",
        "seller_id",
        "redirect_uri",
        "code_challenge",
        "resource",
        "scope",
        "expires_at",
        "consumed_at",
        "created_at",
      ],
      // THI-189 §data-model + THI-193 §4 expand: the BYO LLM credential
      // store columns; access_expires_at/oauth_sub land with the OAuth
      // bundle kind (NULL for api_key rows).
      llm_credentials: [
        "id",
        "seller_id",
        "kind",
        "label",
        "base_url",
        "model",
        "ciphertext",
        "key_fingerprint",
        "access_expires_at",
        "oauth_sub",
        "created_at",
        "updated_at",
      ],
      // Saved shipping addresses (spec docs/specs/saved-addresses.md,
      // rollout step 1): the account-owned address store.
      account_addresses: [
        "id",
        "account_id",
        "label",
        "name",
        "line1",
        "line2",
        "city",
        "postal_code",
        "country",
        "is_default",
        "verification",
        "created_at",
        "updated_at",
        "last_used_at",
      ],
      // Order reviews (spec docs/specs/order-reviews.md, PR 1): one review
      // per order, server-side snapshots, published|hidden status.
      order_reviews: [
        "id",
        "order_id",
        "seller_id",
        "buyer_id",
        "item_id",
        "rating",
        "text",
        "status",
        "buyer_first_name",
        "item_title",
        "created_at",
        "edited_at",
      ],
      // Reports, widened (order-reviews spec PR 3): exactly one target per
      // row — item or review — enforced by reports_one_target_check.
      reports: [
        "id",
        "reporter_account_id",
        "target_item_id",
        "target_review_id",
        "reason",
        "motivation",
        "status",
        "board_issue_ref",
        "created_at",
      ],
    };
    for (const [table, columns] of Object.entries(expected)) {
      const { rows } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const actual = rows.map((r) => r.column_name).sort();
      expect(actual).toEqual([...columns].sort());
    }
  });

  it("enforces the token kind CHECK and unique token hash", async () => {
    await expect(
      client.query(`INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at)
                    VALUES (gen_random_uuid(), 'macaroon', 'x', now())`),
    ).rejects.toThrow();
  });

  // Saved addresses (spec docs/specs/saved-addresses.md, rollout step 1):
  // the verification-status CHECK makes illegal states unrepresentable and
  // the partial unique index pins one default per account.
  it("enforces the account_addresses verification CHECK and one-default index", async () => {
    const seller = await client.query<{ id: string }>(
      `INSERT INTO sellers (display_name, email) VALUES ($1, $2) RETURNING id`,
      ["schema-addresses", `schema-addr-${Date.now()}@test.thingery.dev`],
    );
    const sellerId = seller.rows[0].id;
    const address = {
      label: "Home",
      name: "Ada Lovelace",
      line1: "Via Roma 1",
      city: "Milano",
      postal_code: "20121",
      country: "IT",
    };
    // An illegal verification status is rejected by the CHECK.
    await expect(
      client.query(
        `INSERT INTO account_addresses (account_id, label, name, line1, city, postal_code, country, verification)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '{"status":"definitely"}'::jsonb)`,
        [sellerId, address.label, address.name, address.line1, address.city, address.postal_code, address.country],
      ),
    ).rejects.toThrow();
    // Two defaults for one account violate the partial unique index.
    await client.query(
      `INSERT INTO account_addresses (account_id, label, name, line1, city, postal_code, country, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [sellerId, address.label, address.name, address.line1, address.city, address.postal_code, address.country],
    );
    await expect(
      client.query(
        `INSERT INTO account_addresses (account_id, label, name, line1, city, postal_code, country, is_default)
         VALUES ($1, 'Work', $3, $4, $5, $6, $7, true)`,
        [sellerId, address.name, address.line1, address.city, address.postal_code, address.country],
      ),
    ).rejects.toThrow();
    await client.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]);
  });

  // Order reviews (spec docs/specs/order-reviews.md, PR 1): the rating /
  // status / snapshot CHECKs make illegal values unrepresentable and the
  // UNIQUE (order_id) barrier (one review per order, ever) is enforced at
  // the schema layer.
  it("enforces the order_reviews CHECKs and one-review-per-order UNIQUE", async () => {
    const seller = await client.query<{ id: string }>(
      `INSERT INTO sellers (display_name, email) VALUES ($1, $2) RETURNING id`,
      ["schema-reviews", `schema-reviews-${Date.now()}@test.thingery.dev`],
    );
    const sellerId = seller.rows[0].id;
    const item = await client.query<{ id: string }>(
      `INSERT INTO items (seller_id, title, price_cents) VALUES ($1, 'Schema review fixture', 100) RETURNING id`,
      [sellerId],
    );
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, shipping_price_cents, currency, fulfillment, payment_mode, status)
       VALUES ($1, $2, $2, 100, 0, 'EUR', 'pickup', 'off_platform', 'completed') RETURNING id`,
      [item.rows[0].id, sellerId],
    );
    const insert = (cols: string, values: string, params: unknown[]) =>
      client.query(
        `INSERT INTO order_reviews (order_id, seller_id, buyer_id, item_id, buyer_first_name, item_title, ${cols})
         VALUES ($1, $2, $3, $4, 'Luca', 'Schema review fixture', ${values})`,
        [order.rows[0].id, sellerId, sellerId, item.rows[0].id, ...params],
      );
    // A legal row lands published.
    await insert("rating", "5", []);
    // rating outside 1–5, an illegal status, and illegal snapshot lengths
    // are all CHECKed out (parameterized — values are literals below only
    // where not bindable).
    await expect(insert("rating", "$5", [0])).rejects.toThrow();
    await expect(insert("rating", "$5", [6])).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO order_reviews (order_id, seller_id, buyer_id, item_id, rating, status, buyer_first_name, item_title)
         VALUES ($1, $2, $3, $4, 5, 'draft', 'Luca', 'Schema review fixture')`,
        [order.rows[0].id, sellerId, sellerId, item.rows[0].id],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO order_reviews (order_id, seller_id, buyer_id, item_id, rating, buyer_first_name, item_title)
         VALUES ($1, $2, $3, $4, 5, '', 'Schema review fixture')`,
        [order.rows[0].id, sellerId, sellerId, item.rows[0].id],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO order_reviews (order_id, seller_id, buyer_id, item_id, rating, buyer_first_name, item_title)
         VALUES ($1, $2, $3, $4, 5, 'Luca', 'x')`,
        [order.rows[0].id, sellerId, sellerId, item.rows[0].id],
      ),
    ).rejects.toThrow();
    // text longer than 500 chars violates its CHECK.
    await expect(insert("rating, text", "$5, $6", [4, "x".repeat(501)])).rejects.toThrow();
    // One review per order, ever: a second row for the same order 23505s.
    await expect(insert("rating", "4", [])).rejects.toThrow();
    // Cleanup: orders.seller_id/items.seller_id FKs don't cascade to sellers,
    // so remove the order (cascades the review) and the item first.
    await client.query(`DELETE FROM orders WHERE id = $1`, [order.rows[0].id]);
    await client.query(`DELETE FROM items WHERE id = $1`, [item.rows[0].id]);
    await client.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]);
  });

  // THI-193 §4 expand step (rev fa3288ff): the kind CHECK is widened to
  // chatgpt_oauth, the two OAuth metadata columns exist, and exactly one
  // chatgpt_oauth row per seller is enforced (partial unique index).
  it("widens the llm_credentials kind CHECK to chatgpt_oauth (THI-193)", async () => {
    const seller = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name) VALUES ($1, $2) RETURNING id`,
      [`thg_schema_cg_${Date.now()}`, "schema-chatgpt"],
    );
    const sellerId = seller.rows[0].id;
    // Widened kind accepted (with the normative OAuth columns set)…
    await client.query(
      `INSERT INTO llm_credentials (seller_id, kind, label, model, ciphertext, key_fingerprint, access_expires_at, oauth_sub)
       VALUES ($1, 'chatgpt_oauth', 'ChatGPT plan', 'gpt-5.1', 'v1.stub', '000000000000', now(), 'auth0|chatgpt_test_sub')`,
      [sellerId],
    );
    // …anything else still rejected.
    await expect(
      client.query(
        `INSERT INTO llm_credentials (seller_id, kind, label, model, ciphertext, key_fingerprint)
         VALUES ($1, 'oauth_access', '', 'gpt-5.1', 'v1.stub', '000000000000')`,
        [sellerId],
      ),
    ).rejects.toThrow();
    // One chatgpt_oauth row per seller: a second insert conflicts.
    await expect(
      client.query(
        `INSERT INTO llm_credentials (seller_id, kind, label, model, ciphertext, key_fingerprint)
         VALUES ($1, 'chatgpt_oauth', 'ChatGPT plan', 'gpt-5.1', 'v1.stub2', '000000000001')`,
        [sellerId],
      ),
    ).rejects.toThrow();
    // api_key rows still coexist (separate partial index).
    await client.query(
      `INSERT INTO llm_credentials (seller_id, kind, label, model, ciphertext, key_fingerprint)
       VALUES ($1, 'api_key', '', 'gpt-4o-mini', 'v1.stub3', '000000000002')`,
      [sellerId],
    );
    await client.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]);
  });

  it("cascades seller deletion through grants and tokens", async () => {
    const seller = await client.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name) VALUES ($1, $2) RETURNING id`,
      [`thg_schema_${Date.now()}`, "schema-test"],
    );
    const sellerId = seller.rows[0].id;
    const oauthClient = await client.query<{ client_id: string }>(
      `INSERT INTO oauth_clients (client_id, redirect_uris) VALUES ($1, $2) RETURNING client_id`,
      [`thgc_schema_${Date.now()}`, ["http://localhost:6274/callback"]],
    );
    const grant = await client.query<{ id: string }>(
      `INSERT INTO oauth_grants (seller_id, client_id) VALUES ($1, $2) RETURNING id`,
      [sellerId, oauthClient.rows[0].client_id],
    );
    await client.query(
      `INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at) VALUES ($1, 'access', $2, now())`,
      [grant.rows[0].id, `hash_${Date.now()}`],
    );
    await client.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]);
    const tokens = await client.query(`SELECT 1 FROM oauth_tokens WHERE grant_id = $1`, [grant.rows[0].id]);
    expect(tokens.rowCount).toBe(0);
  });

  // Order-reviews spec PR 3, test item 14: the reports widening replay
  // converges a legacy (pre-widening) database — the exact shape production
  // carries — without touching existing rows, then enforces the XOR target
  // CHECK and the per-kind partial uniques. Wrapped in a transaction so the
  // drop/recreate is invisible to parallel DB users (THI-31) and rolled
  // back to the canonical table for any later assertions.
  it("converges a legacy reports table and enforces the widened shape", async () => {
    await client.query("BEGIN");
    try {
      await client.query("DROP TABLE reports CASCADE");
      // The pre-widening shape (item-reports spec, THI-788 step 2).
      await client.query(`
        CREATE TABLE reports (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          reporter_account_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
          target_item_id      UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
          reason              TEXT NOT NULL CHECK (reason IN ('explicit_images','scam_fraud','other')),
          motivation          TEXT NOT NULL CHECK (char_length(motivation) BETWEEN 10 AND 1000),
          status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
          board_issue_ref     TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (reporter_account_id, target_item_id)
        )`);
      await client.query("CREATE INDEX reports_target_created_idx ON reports (target_item_id, created_at)");

      const reporter = await client.query<{ id: string }>(
        `INSERT INTO sellers (display_name) VALUES ('legacy-reporter') RETURNING id`,
      );
      const itemOwner = await client.query<{ id: string }>(
        `INSERT INTO sellers (display_name) VALUES ('legacy-owner') RETURNING id`,
      );
      const legacyItem = await client.query<{ id: string }>(
        `INSERT INTO items (seller_id, title, price_cents, category) VALUES ($1, 'Legacy lens', 100, 'other') RETURNING id`,
        [itemOwner.rows[0].id],
      );
      await client.query(
        `INSERT INTO reports (reporter_account_id, target_item_id, reason, motivation)
         VALUES ($1, $2, 'other', 'legacy row that must survive')`,
        [reporter.rows[0].id, legacyItem.rows[0].id],
      );

      // The widening replay: schema.sql applied to the legacy shape.
      await client.query(readFileSync(schemaPath, "utf8"));

      // The legacy row is intact.
      const legacy = await client.query<{ target_item_id: string | null; motivation: string }>(
        "SELECT target_item_id, motivation FROM reports WHERE reporter_account_id = $1",
        [reporter.rows[0].id],
      );
      expect(legacy.rows).toHaveLength(1);
      expect(legacy.rows[0]).toEqual({ target_item_id: legacyItem.rows[0].id, motivation: "legacy row that must survive" });

      // Converged shape: nullable item target + the review column.
      const nullable = await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'reports' AND column_name = 'target_item_id'`,
      );
      expect(nullable.rows[0].is_nullable).toBe("YES");

      // The XOR CHECK: no target and both targets are unrepresentable.
      // Each expected failure rides its own savepoint — a failed statement
      // aborts the surrounding transaction otherwise.
      await client.query("SAVEPOINT xor_no_target");
      await expect(client.query(
        `INSERT INTO reports (reporter_account_id, reason, motivation) VALUES ($1, 'other', 'no target at all here')`,
        [reporter.rows[0].id],
      )).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT xor_no_target");

      // A review report now lands (and dedupes) per kind.
      const buyer = await client.query<{ id: string }>(
        `INSERT INTO sellers (display_name) VALUES ('legacy-buyer') RETURNING id`,
      );
      const reviewItem = await client.query<{ id: string }>(
        `INSERT INTO items (seller_id, title, price_cents, category) VALUES ($1, 'Legacy camera', 100, 'other') RETURNING id`,
        [itemOwner.rows[0].id],
      );
      const order = await client.query<{ id: string }>(
        `INSERT INTO orders (item_id, seller_id, buyer_id, price_cents, shipping_price_cents, currency, fulfillment, payment_mode, status)
         VALUES ($1, $2, $3, 100, 0, 'EUR', 'pickup', 'off_platform', 'completed') RETURNING id`,
        [reviewItem.rows[0].id, itemOwner.rows[0].id, buyer.rows[0].id],
      );
      const review = await client.query<{ id: string }>(
        `INSERT INTO order_reviews (order_id, seller_id, buyer_id, item_id, rating, buyer_first_name, item_title)
         VALUES ($1, $2, $3, $4, 5, 'Luca', 'Legacy camera') RETURNING id`,
        [order.rows[0].id, itemOwner.rows[0].id, buyer.rows[0].id, reviewItem.rows[0].id],
      );
      await client.query(
        `INSERT INTO reports (reporter_account_id, target_review_id, reason, motivation)
         VALUES ($1, $2, 'other', 'first review report lands')`,
        [reporter.rows[0].id, review.rows[0].id],
      );
      await client.query("SAVEPOINT xor_dup");
      await expect(client.query(
        `INSERT INTO reports (reporter_account_id, target_review_id, reason, motivation)
         VALUES ($1, $2, 'other', 'duplicate review report rejected')`,
        [reporter.rows[0].id, review.rows[0].id],
      )).rejects.toThrow(/duplicate/i);
      await client.query("ROLLBACK TO SAVEPOINT xor_dup");

      // Two targets on one row are equally unrepresentable.
      await client.query("SAVEPOINT xor_two_targets");
      await expect(client.query(
        `INSERT INTO reports (reporter_account_id, target_item_id, target_review_id, reason, motivation)
         VALUES ($1, $2, $3, 'other', 'two targets at once rejected')`,
        [reporter.rows[0].id, legacyItem.rows[0].id, review.rows[0].id],
      )).rejects.toThrow();
      await client.query("ROLLBACK TO SAVEPOINT xor_two_targets");

      await client.query("ROLLBACK");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  });
});
