-- Thingery Item Graph schema v0.1
-- Requires Postgres with pgvector (image: pgvector/pgvector:pg16)

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sellers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- API keys live only as sha256 hex in api_key_hash (added below). The
  -- plaintext api_key column (v0.1 → THI-114 expand) is dropped by the
  -- contract block below on legacy databases; fresh databases never get it.
  display_name TEXT NOT NULL,
  profile      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- flexible per-seller fields: locale, currency,
                                                    -- notification prefs, negotiation mandates, ...
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Account system (chat/signup, v0.2). Idempotent ALTERs: safe on existing databases.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS password_hash TEXT;
-- Session revocation groundwork (spec THI-115 §3, docs/security.md §6 H2 fix 4):
-- per-seller epoch mixed into the session-cookie MAC (src/auth.ts). Bumping it
-- (the key-regeneration endpoint) invalidates every outstanding session cookie
-- for that seller at once. Default 0 keeps seeded/existing sellers usable.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS session_epoch INT NOT NULL DEFAULT 0;

-- Email verification groundwork (THI-760 plan Phase 0 / THI-762; board-approved
-- plan revision aad0e354). One accounts table (sellers) holds buyers and sellers
-- alike, and `email` has never been verified (docs/security.md §4 H4): no
-- notification email may ever be sent to an address that is unverified or NULL.
-- Phase 0 lays the columns and mints the token only — nothing gates sending on
-- email_verified_at yet (all sending arrives in later phases; this deploy is
-- dark by construction). Additive, expand-only, idempotent:
--   email_verified_at               set once, by consuming a valid token
--   email_verification_token_hash   sha256 hex of the live single-use token;
--                                   NULL when none is outstanding (also cleared
--                                   on consumption — a reused token must fail)
--   email_verification_expires_at   the live token's TTL anchor (48h,
--                                   src/auth.ts). Extension of the plan's
--                                   three-column list: its own acceptance
--                                   criteria require expiring tokens, and the
--                                   codebase convention for expiring single-use
--                                   credentials is an explicit timestamp column
--                                   (oauth_codes.expires_at) — noted in the PR.
--   email_bounced_at                groundwork for Phase 1 bounce suppression
--                                   (delivery sweep marks hard bounces and
--                                   suppresses further sends); never set yet.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS email_verification_token_hash TEXT;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS email_bounced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS sellers_email_verification_token_hash_idx
  ON sellers (email_verification_token_hash) WHERE email_verification_token_hash IS NOT NULL;

-- API key hash at rest (security doc §6 H2 fix 1; THI-114 expand → THI-158
-- contract). Fresh databases store only the sha256 hash. Legacy databases
-- are migrated hash-before-drop so no seller key is ever invalidated:
--   1. ADD api_key_hash (no-op on expand-phase databases).
--   2. Guarded backfill: hash any plaintext key that has no hash yet — this
--      is what protects direct upgraders from a pre-expand schema (plaintext
--      key, no hash column). The DO block also tolerates the steady state
--      where api_key is already gone (undefined_column → skip), keeping the
--      whole file idempotent.
--   3. Unique partial index on the hash.
--   4. DROP the plaintext column. No rollback after this (the deploy ran
--      only after a verified clean nightly backup, THI-158 gate).
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS api_key_hash TEXT;
DO $$
BEGIN
  UPDATE sellers
     SET api_key_hash = encode(sha256(convert_to(api_key, 'utf8')), 'hex')
   WHERE api_key_hash IS NULL AND api_key IS NOT NULL;
EXCEPTION WHEN undefined_column THEN NULL;  -- steady state: column already dropped
END $$;
-- R4 (THI-125 note N2): the build deliberately stays a plain CREATE ... IF
-- NOT EXISTS, not CONCURRENTLY. Expand-phase databases already have the
-- index (no-op, no lock); fresh databases build it on an empty table
-- (instant). CONCURRENTLY cannot run inside a transaction, and this file is
-- applied as one multi-statement query by the test suite and
-- scripts/migrate.ts — a split-apply rework is its own ticket if sellers
-- ever grows enough that a fresh plain build's lock matters.
CREATE UNIQUE INDEX IF NOT EXISTS sellers_api_key_hash_idx
  ON sellers (api_key_hash) WHERE api_key_hash IS NOT NULL;
ALTER TABLE sellers DROP COLUMN IF EXISTS api_key;
-- API key display metadata for the web Settings page. Never the secret:
-- api_key_prefix is the key's first 8 characters ("thg_" + 4 random base64url
-- chars = 24 of the key's 192 random bits), written with the hash on
-- create/rotate. api_key_last_used_at is stamped by thg_ authentication at
-- most once an hour (src/auth.ts). Keys issued before these columns existed
-- keep NULLs: a prefix cannot be recovered from a hash, so no backfill.
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS api_key_prefix TEXT;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS api_key_created_at TIMESTAMPTZ;
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS api_key_last_used_at TIMESTAMPTZ;

-- Category registry: declares the expected attribute fields per category so
-- agents can self-serve the schema (describe_category tool). Items are NOT
-- locked to these definitions — unknown attribute keys pass through, which
-- keeps the graph flexible and federation-friendly.
CREATE TABLE IF NOT EXISTS categories (
  name                 TEXT PRIMARY KEY,      -- lowercase slug, e.g. 'sneakers'
  description          TEXT NOT NULL DEFAULT '',
  attribute_definitions JSONB NOT NULL DEFAULT '[]',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Two-level taxonomy (spec THI-734 / GH #218): departments (parent NULL) over
-- leaves (parent = department name). Departments are assignable — parent NULL
-- means "valid category in its own right, top of tree"; 'other' is parentless
-- and childless (fallback leaf-dept). The FK guarantees a parent exists; the
-- two-level invariant (a parent's parent is always NULL) is enforced by seed
-- order and asserted by tests — no trigger (registry is code-owned, no runtime
-- writer exists). aliases (D4): lowercase slug synonyms resolved to canonical
-- at every write/read edge (e.g. trainers -> sneakers).
ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent TEXT REFERENCES categories(name);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'other',
  condition     TEXT NOT NULL DEFAULT 'good'
                CHECK (condition IN ('new','like_new','good','fair','poor')),
  brand         TEXT,
  price_cents   INTEGER NOT NULL CHECK (price_cents >= 0),
  currency      CHAR(3) NOT NULL DEFAULT 'EUR',
  location      TEXT,
  weight_grams  INTEGER,
  dimensions_mm TEXT,                          -- "300x200x150" (LxWxH), for shipping estimation
  shipping_tier TEXT NOT NULL DEFAULT 'unknown'
                CHECK (shipping_tier IN ('locker','parcel','bulky','local','unknown')),
  images        TEXT[] NOT NULL DEFAULT '{}',
  attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- category-specific fields (size, colorway,
                                                     -- ISBN, shutter_count, ...) — free-form
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','reserved','sold','deleted')),
  embedding     vector(1536),                  -- text-embedding-3-small by default
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS items_status_created_idx ON items (status, created_at DESC);
CREATE INDEX IF NOT EXISTS items_seller_idx ON items (seller_id);
CREATE INDEX IF NOT EXISTS items_category_idx ON items (category);
CREATE INDEX IF NOT EXISTS items_price_idx ON items (price_cents);
CREATE INDEX IF NOT EXISTS items_attributes_idx ON items USING gin (attributes jsonb_path_ops);

-- Seller-published shipping price (spec rev 3 §11.4, OQ5): charged to the buyer on top of
-- price_cents when fulfillment = shipping. 0 = free shipping; ignored for pickup items
-- (shipping_tier = 'local'). Snapshotted onto orders at creation.
ALTER TABLE items ADD COLUMN IF NOT EXISTS shipping_price_cents INTEGER NOT NULL DEFAULT 0
                      CHECK (shipping_price_cents >= 0);

-- Registry as code (THI-734 D7): the seed CONVERGES the registry to schema.sql
-- on every apply — description, attribute_definitions, parent and aliases are
-- updated in place (created_at untouched). This replaces ON CONFLICT DO
-- NOTHING, under which shipped registry edits never reached an existing
-- database (latent bug, spec §1). The registry has no admin write path, so
-- convergence cannot clobber runtime state; self-hosted hand-edits are a
-- documented behavior change (spec §5.6, release-noted in PR 3).
--
-- Taxonomy content (THI-736 / PR 2, spec §5.1–5.3): 29 rows — 7 departments
-- over 21 leaves, plus parentless and childless 'other' as the fallback
-- leaf-dept. All 14 legacy slugs keep their names and attribute definitions
-- (D3); new leaves and facet attributes (department enum on the fashion rows,
-- size_letter on clothing) are purely additive (D6). Departments are inserted
-- BEFORE leaves so per-row FK checks on parent succeed inside this one
-- statement (spec §4.1); the wrapper SELECT keeps the VALUES block untouched
-- for review. Aliases per §5.3: sneakers←trainers; baby←stroller, pram;
-- accessories←jewelry; phones←smartphone; computers←laptop; music←vinyl,
-- records.
INSERT INTO categories (name, description, attribute_definitions, parent, aliases)
SELECT s.name, s.description, s.attribute_definitions::jsonb, s.parent::text, s.aliases::text[]
FROM (
  VALUES
  -- Departments (parent NULL — assignable in their own right; 'other' is the
  -- parentless, childless fallback leaf-dept).
  ('fashion', 'Clothing, footwear, bags, accessories, beauty (leaf unspecified)',
   '[{"key":"department","type":"string","enum":["women","men","unisex","kids"],"description":"who the item is for"}]',
   NULL::text, '{}'::text[]),
  ('kids', 'Baby and kids: gear, clothing, toys (leaf unspecified)', '[]',
   NULL::text, '{}'::text[]),
  ('electronics', 'Consumer electronics (misc; see phones, computers, cameras, games)',
   '[{"key":"model","type":"string","description":"Model name/number"},
     {"key":"warranty_months","type":"number"}]',
   NULL::text, '{}'::text[]),
  ('home', 'Furniture and household (incl. appliances; DIY/garden → tools)',
   '[{"key":"material","type":"string"},
     {"key":"color","type":"string"}]',
   NULL::text, '{}'::text[]),
  ('media', 'Books and recorded media (leaf unspecified)', '[]',
   NULL::text, '{}'::text[]),
  ('hobbies', 'Collectibles, tabletop games, instruments (leaf unspecified)', '[]',
   NULL::text, '{}'::text[]),
  ('sports', 'Sports and outdoor gear (bikes → bikes)',
   '[{"key":"sport","type":"string"}]',
   NULL::text, '{}'::text[]),
  ('other', 'Everything else (fallback)', '[]',
   NULL::text, '{}'::text[]),
  -- fashion leaves
  ('clothing', 'Clothes; sizes: size_letter or free-text size',
   '[{"key":"size","type":"string","required":true,"description":"e.g. M, 42, One Size"},
     {"key":"size_letter","type":"string","enum":["XS","S","M","L","XL","XXL"],"description":"letter size; use with or instead of free-text size"},
     {"key":"material","type":"string"},
     {"key":"color","type":"string"},
     {"key":"department","type":"string","enum":["women","men","unisex","kids"],"description":"who the item is for"}]',
   'fashion', '{}'::text[]),
  ('shoes', 'Non-sneaker footwear',
   '[{"key":"size_eu","type":"number","required":true,"description":"EU shoe size"},
     {"key":"material","type":"string"},
     {"key":"department","type":"string","enum":["women","men","unisex","kids"],"description":"who the item is for"}]',
   'fashion', '{}'::text[]),
  ('sneakers', 'Trainers and sneakers',
   '[{"key":"size_eu","type":"number","required":true,"description":"EU shoe size, e.g. 43"},
     {"key":"colorway","type":"string","description":"e.g. white/grey"},
     {"key":"has_original_box","type":"boolean"},
     {"key":"department","type":"string","enum":["women","men","unisex","kids"],"description":"who the item is for"}]',
   'fashion', '{"trainers"}'::text[]),
  ('bags', 'Handbags, backpacks, luggage',
   '[{"key":"material","type":"string"},
     {"key":"color","type":"string"},
     {"key":"department","type":"string","enum":["women","men","unisex","kids"],"description":"who the item is for"}]',
   'fashion', '{}'::text[]),
  ('accessories', 'Jewellery, watches, belts, sunglasses, scarves',
   '[{"key":"type","type":"string","enum":["jewellery","watch","belt","sunglasses","scarf","other"]},
     {"key":"department","type":"string","enum":["women","men","unisex","kids"],"description":"who the item is for"}]',
   'fashion', '{"jewelry"}'::text[]),
  ('beauty', 'Makeup, skincare, fragrance',
   '[{"key":"type","type":"string","enum":["makeup","skincare","fragrance","haircare","other"]}]',
   'fashion', '{}'::text[]),
  -- kids leaves
  ('baby', 'Pushchairs, car seats, nursery',
   '[{"key":"type","type":"string","enum":["pushchair","car_seat","nursery","other"]}]',
   'kids', '{"stroller","pram"}'::text[]),
  ('kids-clothing', 'Children''s clothing; size in years or height (e.g. 6Y, 104)',
   '[{"key":"size","type":"string","required":true,"description":"age or height size, e.g. 6Y, 104"},
     {"key":"color","type":"string"}]',
   'kids', '{}'::text[]),
  ('toys', 'Toys and playthings (tabletop games → board-games)',
   '[{"key":"age_range","type":"string","description":"e.g. 6+, 12+"}]',
   'kids', '{}'::text[]),
  -- electronics leaves
  ('phones', 'Mobile phones',
   '[{"key":"model","type":"string","required":true},
     {"key":"storage_gb","type":"number"},
     {"key":"battery_health_pct","type":"number"}]',
   'electronics', '{"smartphone"}'::text[]),
  ('computers', 'Laptops and desktops',
   '[{"key":"model","type":"string","required":true},
     {"key":"ram_gb","type":"number"},
     {"key":"storage_gb","type":"number"}]',
   'electronics', '{"laptop"}'::text[]),
  ('cameras', 'Cameras, lenses, drones',
   '[{"key":"model","type":"string"},
     {"key":"shutter_count","type":"number"}]',
   'electronics', '{}'::text[]),
  ('games', 'Video games and consoles (tabletop → board-games)',
   '[{"key":"platform","type":"string","enum":["nintendo_switch","ps4","ps5","xbox_one","xbox_series","pc","other"],"required":true}]',
   'electronics', '{}'::text[]),
  -- home leaves
  ('tools', 'DIY, power tools, garden',
   '[{"key":"type","type":"string","enum":["power","hand","garden","other"]}]',
   'home', '{}'::text[]),
  ('pets', 'Pet supplies: beds, carriers, aquariums',
   '[{"key":"type","type":"string","enum":["dog","cat","bird","small_animal","aquarium","other"]}]',
   'home', '{}'::text[]),
  -- media leaves
  ('books', 'Books and magazines',
   '[{"key":"author","type":"string"},
     {"key":"isbn","type":"string"},
     {"key":"language","type":"string"}]',
   'media', '{}'::text[]),
  ('music', 'Recorded music: vinyl, CDs, cassettes (instruments → hobbies)',
   '[{"key":"format","type":"string","enum":["vinyl","cd","cassette","instrument","other"]},
     {"key":"artist","type":"string"}]',
   'media', '{"vinyl","records"}'::text[]),
  -- hobbies leaves
  ('collectibles', 'Collectibles and memorabilia',
   '[{"key":"franchise","type":"string"}]',
   'hobbies', '{}'::text[]),
  ('board-games', 'Tabletop and board games',
   '[{"key":"players","type":"string","description":"e.g. 2-4"},
     {"key":"language","type":"string"}]',
   'hobbies', '{}'::text[]),
  ('instruments', 'Musical instruments and gear',
   '[{"key":"instrument","type":"string","required":true}]',
   'hobbies', '{}'::text[]),
  -- sports leaves
  ('bikes', 'Bicycles: road, MTB, city, e-bikes',
   '[{"key":"type","type":"string","enum":["road","mtb","city","bmx","ebike","kids","other"]},
     {"key":"frame_size","type":"string"},
     {"key":"wheel_size_inches","type":"number"}]',
   'sports', '{}'::text[])
) AS s(name, description, attribute_definitions, parent, aliases)
ON CONFLICT (name) DO UPDATE SET
  description           = EXCLUDED.description,
  attribute_definitions = EXCLUDED.attribute_definitions,
  parent                = EXCLUDED.parent,
  aliases               = EXCLUDED.aliases;

-- Approximate nearest neighbour index; safe to create before rows exist
CREATE INDEX IF NOT EXISTS items_embedding_idx
  ON items USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_set_updated_at ON items;
CREATE TRIGGER items_set_updated_at BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- MCP OAuth one-click onboarding (spec THI-11 rev 2, §3).
-- Dynamic clients (RFC 7591), grants, hashed tokens, hashed authorization codes.
-- All additive and idempotent (expand-only migration); no columns are added to
-- sellers — OAuth state hangs off seller_id FKs and cascades on seller delete.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,            -- 'thgc_...' random; public identifier
  client_name   TEXT,                        -- from DCR, e.g. 'Claude Desktop'; data, not HTML
  client_uri    TEXT,                        -- from DCR; stored as data, never rendered as a link
  redirect_uris TEXT[] NOT NULL,             -- exact-match list; loopback http allowed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  authorized_at TIMESTAMPTZ                  -- set on first code issuance; NULL + old → sweep
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id   UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope       TEXT NOT NULL DEFAULT 'mcp',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ                    -- family-revocation flag; one row per "Allow" click
);
CREATE INDEX IF NOT EXISTS oauth_grants_seller_idx ON oauth_grants (seller_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id     UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  token_hash   TEXT UNIQUE NOT NULL,         -- sha256 hex of the full 'thgo_...'/'thgr_...' string
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ                   -- throttled update (>= 10 min granularity)
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_sweep_idx ON oauth_tokens (kind, expires_at);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash       TEXT PRIMARY KEY,          -- sha256 hex of the full 'thga_...' string
  grant_id        UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  seller_id       UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,              -- bound at issuance (normalized form)
  code_challenge  TEXT NOT NULL,              -- PKCE S256 digest, bound at issuance
  resource        TEXT,                        -- RFC 8707 audience, bound at issuance when sent
  scope           TEXT NOT NULL DEFAULT 'mcp',
  expires_at      TIMESTAMPTZ NOT NULL,       -- now() + 60s
  consumed_at     TIMESTAMPTZ,                -- single-use flag; replay detection
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Order flow (spec THI-3 rev 2 §3 + rev 3 §11 addendum, THI-10). One item, one
-- seller, one buyer, an explicit 12-state machine (§2 + §11.2), an append-only
-- audit log, and a raw webhook event store backing idempotency + replay (§5.4).
-- All additive and idempotent (expand-only migration).
CREATE TABLE IF NOT EXISTS orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id             UUID NOT NULL REFERENCES items(id),
  seller_id           UUID NOT NULL REFERENCES sellers(id),  -- snapshot of item owner at creation
  buyer_id            UUID NOT NULL REFERENCES sellers(id),  -- buyer account; sellers IS the accounts table
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sold','label_issued','in_transit','delivered',
                                        'disputed','refunding','refunded','payout_pending',
                                        'paid_out','cancelled','completed')),
  payment_mode        TEXT NOT NULL DEFAULT 'stripe'
                      CHECK (payment_mode IN ('stripe','off_platform')),  -- §11.2 (OQ4): off_platform =
                      -- order tracking without platform money; parties settle payment themselves
  price_cents         INTEGER NOT NULL CHECK (price_cents >= 0),  -- snapshot of item price at creation
  shipping_price_cents INTEGER NOT NULL DEFAULT 0
                      CHECK (shipping_price_cents >= 0),  -- §11.4 (OQ5): snapshot of
                      -- items.shipping_price_cents; 0 for pickup or free shipping
  currency            CHAR(3) NOT NULL,
  fulfillment         TEXT NOT NULL CHECK (fulfillment IN ('shipping','pickup')),
  shipping_address    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- PII; zod-validated at ingest (max
                                                            -- lengths, unknown keys rejected — F16);
                                                            -- visible only to order parties (§4.1)
  carrier             TEXT,
  tracking_code       TEXT,
  tracker_id          TEXT UNIQUE,     -- carrier-aggregator tracker id (EasyPost result.id) —
                                       -- PRIMARY webhook event-resolution key (F4, §5.2)
  label_url           TEXT,            -- https-only; stored and returned as data, never a link (F16)
  shipping_address_shared_at TIMESTAMPTZ,  -- off_platform only: when the buyer agreed to show the seller
                                           -- this order's address; NULL = not agreed, the seller cannot read it
  checkout_session_id TEXT UNIQUE,
  payment_intent_id   TEXT UNIQUE,
  transfer_id         TEXT,
  refund_id           TEXT,
  payment_deadline    TIMESTAMPTZ,        -- pending expiry
  dispute_deadline    TIMESTAMPTZ,        -- set on delivered
  status_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- drives stale-sold / stuck-transit sweeps
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_item_idx   ON orders (item_id);
CREATE INDEX IF NOT EXISTS orders_buyer_idx  ON orders (buyer_id);
CREATE INDEX IF NOT EXISTS orders_seller_idx ON orders (seller_id);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
-- Webhook event→order resolution fallback + handler performance (F4):
CREATE INDEX IF NOT EXISTS orders_carrier_tracking_idx ON orders (carrier, tracking_code);
-- One live order per item at a time (spec §2.3 transition #1 guard, DB-backed):
CREATE UNIQUE INDEX IF NOT EXISTS one_live_order_per_item
  ON orders (item_id)
  WHERE status IN ('pending','sold','label_issued','in_transit','delivered',
                   'disputed','refunding','payout_pending');

-- Rev 3 expand block (§11.2/§11.4): databases that already carry the PR-1 orders
-- table (CREATE TABLE IF NOT EXISTS skips it) get the new columns and the widened
-- status CHECK here. Idempotent — safe on every replay.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_mode TEXT NOT NULL DEFAULT 'stripe'
                      CHECK (payment_mode IN ('stripe','off_platform'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_price_cents INTEGER NOT NULL DEFAULT 0
                      CHECK (shipping_price_cents >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address_shared_at TIMESTAMPTZ;
-- Label purchase (spec docs/specs/label-purchase.md, THI-562 work item 2): the
-- platform-bought EasyPost label snapshot, persisted in the same transaction as
-- transition #5b (sold → label_issued). NULL for every order that reached
-- label_issued via record_tracking — old rows and existing tool outputs are
-- unchanged. bought_at (ISO UTC) is the A2 daily-budget aggregation key.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_purchase JSONB;
-- {shipment_id, rate_id, carrier, service, cost_cents, currency, bought_at}
DO $$
BEGIN
  -- Widen the status CHECK with 'completed' (off_platform terminal state, §11.2).
  -- Skipped when the widened constraint is already in place.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_status_check'
      AND conrelid = 'orders'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%completed%'
  ) THEN
    ALTER TABLE orders DROP CONSTRAINT orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check
      CHECK (status IN ('pending','sold','label_issued','in_transit','delivered',
                        'disputed','refunding','refunded','payout_pending',
                        'paid_out','cancelled','completed'));
  END IF;
END $$;

-- Append-only audit log: every transition, correction, webhook application,
-- sweep firing, and operator alert lands here (spec §2.3, §3.2).
CREATE TABLE IF NOT EXISTS order_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,        -- 'transition', 'tracking_corrected', 'carrier_update',
                                    -- 'stripe_event', 'unexpected_payment', 'operator_alert', ...
  from_status TEXT,
  to_status   TEXT,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('buyer','seller','system','carrier','stripe','admin')),
  actor_id    TEXT,                 -- account id, webhook source, or sweep rule name
  reason      TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- PII-free by construction (F6): status codes,
                                                    -- timestamps, object ids — never raw provider payloads
  dedupe_key  TEXT UNIQUE,          -- stripe:{event_id}, carrier:{event_id}, sweep:{rule}:{order_id}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events (order_id, created_at);

-- Raw webhook event store: UNIQUE (source, external_id) is the idempotency
-- barrier; process_error + processed_at drive reprocessing (spec §5.4, §4.5
-- sweep rule 6). Payloads are REDACTED at ingest (F6) — see spec §3.3.
CREATE TABLE IF NOT EXISTS webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL CHECK (source IN ('stripe','carrier')),
  external_id   TEXT NOT NULL,      -- Stripe event id / carrier event id
  payload       JSONB NOT NULL,     -- REDACTED at ingest (F6): event id, normalized status, object ids
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  process_error TEXT,
  UNIQUE (source, external_id)
);

-- Seller payout readiness (spec §3.4, §6.3). Set by the Stripe account.updated
-- webhook when capabilities.transfers = 'active' (known connected accounts only, F5).
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;           -- Express connected account
ALTER TABLE sellers ADD COLUMN IF NOT EXISTS stripe_onboarded_at TIMESTAMPTZ;  -- transfers capability active

-- Seller upload quota (THI-110 / docs/security.md §6 H3): per-seller daily
-- count + byte caps for item-image uploads. The upload path upsert-increments
-- atomically on accepted uploads; quota resets naturally per day (no sweep).
CREATE TABLE IF NOT EXISTS seller_upload_quota (
  seller_id UUID NOT NULL,
  day       DATE NOT NULL,
  uploads   INT NOT NULL DEFAULT 0,
  bytes     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (seller_id, day)
);

-- Seller label quota (spec docs/specs/label-purchase.md): per-seller daily
-- count of platform-bought labels (10/day). Same atomic upsert-increment
-- pattern as seller_upload_quota above; quota resets naturally per UTC day
-- (no sweep). The day is UTC, matching the A2 budget aggregation.
CREATE TABLE IF NOT EXISTS seller_label_quota (
  seller_id UUID NOT NULL REFERENCES sellers(id),
  day       DATE NOT NULL,
  used      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (seller_id, day)
);

-- ---------------------------------------------------------------------------
-- Bring-your-own LLM credentials (spec THI-186 Phase 1 / THI-189 §1).
-- Unlike thg_ seller keys (hash-only, THI-114), the server must PRESENT these
-- secrets to an LLM provider — so they are stored encrypted at rest with
-- AES-256-GCM under a dedicated master key env var (LLM_CREDENTIALS_MASTER_KEY,
-- 32 bytes hex; src/llm-credentials.ts). Ciphertext format 'v1.<base64url(iv|tag|ct)>'
-- with AAD = sellerId:kind so a row swapped between sellers fails GCM auth.
-- key_fingerprint: first 12 hex of HMAC-SHA256(master, key) — display only,
-- never reversible, never a lookup key. kind='api_key' in Phase 1; OAuth
-- access/refresh tokens (THI-187) extend the same table via new kinds —
-- the CHECK is widened then, never narrowed. Exactly one live api_key
-- credential per seller (partial unique index; rotate = upsert-replace).
CREATE TABLE IF NOT EXISTS llm_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id       UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'api_key' CHECK (kind IN ('api_key')),
  label           TEXT NOT NULL DEFAULT '',
  base_url        TEXT,
  model           TEXT NOT NULL,
  ciphertext      TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS llm_credentials_seller_api_key_idx
  ON llm_credentials (seller_id) WHERE kind = 'api_key';

-- THI-193 expand step (tech-spec §4, rev fa3288ff): widen the kind CHECK so
-- the same table carries "Sign in with ChatGPT" OAuth bundles
-- (kind='chatgpt_oauth', src/chatgpt-oauth.ts). Metadata-only widening —
-- every existing api_key row and every kind='api_key' filter in old code is
-- unaffected. Idempotent replay: the constraint always exists by this point
-- (inline CHECK in the CREATE above on fresh databases, a previous apply on
-- existing ones), so DROP+ADD re-runs cleanly. access_expires_at/oauth_sub
-- are NULL for api_key rows (no backfill); the partial unique index keeps
-- exactly one chatgpt_oauth row per seller, same pattern as the api_key one.
ALTER TABLE llm_credentials DROP CONSTRAINT llm_credentials_kind_check;
ALTER TABLE llm_credentials ADD CONSTRAINT llm_credentials_kind_check
  CHECK (kind IN ('api_key', 'chatgpt_oauth'));
ALTER TABLE llm_credentials ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ;
ALTER TABLE llm_credentials ADD COLUMN IF NOT EXISTS oauth_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS llm_credentials_seller_chatgpt_oauth_idx
  ON llm_credentials (seller_id) WHERE kind = 'chatgpt_oauth';

-- THI-308 (spec rev 2): photo-gated publishing. New listings default to
-- photo_required = true — they stay pending (hidden from feeds, see the
-- derived visibility predicate in src/items.ts) until the first photo lands.
-- One-time grandfather: every pre-deploy row is backfilled to false so
-- existing zero-photo listings stay live. Expand-only; re-run safe (this file
-- re-executes on every db:migrate — the backfill is NULL-guarded, so later
-- applies are no-ops). Applied as one multi-statement query, i.e. a single
-- implicit transaction: no maintenance window (THI-314 verified).
ALTER TABLE items ADD COLUMN IF NOT EXISTS photo_required BOOLEAN;
UPDATE items SET photo_required = false WHERE photo_required IS NULL;  -- grandfather all pre-existing rows
ALTER TABLE items ALTER COLUMN photo_required SET NOT NULL;
ALTER TABLE items ALTER COLUMN photo_required SET DEFAULT true;

-- ---------------------------------------------------------------------------
-- THI-360 (buyer alerts v1, spec rev 2): saved buyer intent + match records.
-- Additive only — nothing reads these tables until PR 2+ wires the MCP tools
-- and the publish evaluation. Security review THI-380 (APPROVE WITH RIDERS)
-- approved the block as written; R2's quota table is the delete-cycle-proof
-- rider. buyer_intents gets the same set_updated_at() trigger as items.

CREATE TABLE IF NOT EXISTS buyer_intents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id         UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  q                TEXT CHECK (char_length(q) BETWEEN 3 AND 400),
  category         TEXT,
  condition        TEXT CHECK (condition IS NULL OR condition IN ('new','like_new','good','fair','poor')),
  min_price_cents  INTEGER CHECK (min_price_cents IS NULL OR min_price_cents >= 0),
  max_price_cents  INTEGER CHECK (max_price_cents IS NULL OR max_price_cents >= 0),
  currency         CHAR(3) NOT NULL DEFAULT 'EUR',
  shipping_tier    TEXT CHECK (shipping_tier IS NULL OR shipping_tier IN ('locker','parcel','bulky','local','unknown')),
  attributes       JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding        vector(1536),
  muted            BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (min_price_cents IS NULL OR max_price_cents IS NULL OR min_price_cents <= max_price_cents)
);
CREATE INDEX IF NOT EXISTS buyer_intents_buyer_idx ON buyer_intents (buyer_id);
CREATE TABLE IF NOT EXISTS intent_matches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id  UUID NOT NULL REFERENCES buyer_intents(id) ON DELETE CASCADE,
  buyer_id   UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  item_id    UUID NOT NULL REFERENCES items(id),
  score      REAL NOT NULL DEFAULT 0,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (intent_id, item_id)
);
CREATE INDEX IF NOT EXISTS intent_matches_buyer_idx ON intent_matches (buyer_id, created_at DESC);
-- R2 (THI-380 rider): per-buyer daily save quota; atomic upsert in src/intents.ts
-- increments only while saves < 50 — delete-cycling cannot reset it.
CREATE TABLE IF NOT EXISTS buyer_intent_quota (
  buyer_id UUID NOT NULL,
  day      DATE NOT NULL,
  saves    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (buyer_id, day)
);
DROP TRIGGER IF EXISTS buyer_intents_set_updated_at ON buyer_intents;
CREATE TRIGGER buyer_intents_set_updated_at BEFORE UPDATE ON buyer_intents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- THI-439 (wanted listings MVP, spec rev 1): public buyer-demand records +
-- seller response links. Additive only — nothing reads these tables until the
-- tools/routes PRs wire them. Same conventions as the THI-360 block above.

CREATE TABLE IF NOT EXISTS wanted_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id          UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  notes             TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 2000),
  category          TEXT NOT NULL DEFAULT 'other',
  condition         TEXT CHECK (condition IS NULL OR condition IN ('new','like_new','good','fair','poor')),
  budget_min_cents  INTEGER CHECK (budget_min_cents IS NULL OR budget_min_cents >= 0),
  budget_max_cents  INTEGER CHECK (budget_max_cents IS NULL OR budget_max_cents >= 0),
  currency          CHAR(3) NOT NULL DEFAULT 'EUR',
  reference_images  TEXT[] NOT NULL DEFAULT '{}',
  embedding         vector(1536),              -- title+notes+category+condition; NULL when embeddings unconfigured
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired')),
  expires_at        TIMESTAMPTZ NOT NULL,      -- created_at + 30d at insert; renew resets to now()+30d
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (budget_min_cents IS NULL OR budget_max_cents IS NULL OR budget_min_cents <= budget_max_cents)
);
CREATE INDEX IF NOT EXISTS wanted_items_feed_idx ON wanted_items (status, category, created_at DESC);
CREATE INDEX IF NOT EXISTS wanted_items_buyer_idx ON wanted_items (buyer_id);

CREATE TABLE IF NOT EXISTS wanted_responses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wanted_item_id  UUID NOT NULL REFERENCES wanted_items(id) ON DELETE CASCADE,
  seller_id       UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  item_id         UUID NOT NULL REFERENCES items(id),      -- items are soft-deleted only; FK never dangles
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ,                             -- set once, idempotently, at the listing's
                                                            -- first feed-visible transition (photo publish)
  read_at         TIMESTAMPTZ,                             -- buyer read marker (my_wanted mark_read)
  UNIQUE (wanted_item_id, item_id)                          -- replay barrier
);
CREATE INDEX IF NOT EXISTS wanted_responses_wanted_idx ON wanted_responses (wanted_item_id, created_at DESC);
-- unread response counts for my_wanted: partial index on the buyer's scan shape
CREATE INDEX IF NOT EXISTS wanted_responses_unread_idx ON wanted_responses (wanted_item_id)
  WHERE published_at IS NOT NULL AND read_at IS NULL;

-- Per-buyer daily wanted quota: atomic conditional upsert (THI-380 R2 pattern).
-- Expire-cycling wanted_items cannot reset it, unlike a count-at-create cap.
CREATE TABLE IF NOT EXISTS wanted_buyer_quota (
  buyer_id UUID NOT NULL,
  day      DATE NOT NULL,
  creates  INT NOT NULL DEFAULT 0,
  edits    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (buyer_id, day)
);

DROP TRIGGER IF EXISTS wanted_items_set_updated_at ON wanted_items;
CREATE TRIGGER wanted_items_set_updated_at BEFORE UPDATE ON wanted_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- THI-567 (order messaging, spec docs/specs/order-messaging.md): party-to-
-- party text messages scoped to one order. Additive only — nothing reads the
-- table until the tools PR wires it. Reads stay available in every order
-- status (history); sends are cut off at terminal statuses by the service,
-- which also derives sender_role from the order row (never client-supplied).
-- Messages are NOT written to order_events — that table is the transition
-- audit log; message rows are their own record (spec: volume discipline).

CREATE TABLE IF NOT EXISTS order_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id),
  sender_id   UUID NOT NULL REFERENCES sellers(id),  -- sellers IS the accounts table
  sender_role TEXT NOT NULL CHECK (sender_role IN ('buyer','seller')),  -- denormalized from the order row at insert
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Keyset pagination on (order_id, created_at) — list_order_messages pages
-- newest-first through one order's thread.
CREATE INDEX IF NOT EXISTS order_messages_order_created_idx
  ON order_messages (order_id, created_at);
-- Per-account abuse review / retention sweeps scan by sender.
CREATE INDEX IF NOT EXISTS order_messages_sender_created_idx
  ON order_messages (sender_id, created_at);
