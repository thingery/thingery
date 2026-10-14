-- Thingery Item Graph schema v0.1
-- Requires Postgres with pgvector (image: pgvector/pgvector:pg16)

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sellers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key      TEXT UNIQUE NOT NULL,          -- format: thg_<random>; store hashed in production
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

INSERT INTO categories (name, description, attribute_definitions) VALUES
  ('sneakers', 'Trainers and sneakers',
   '[{"key":"size_eu","type":"number","required":true,"description":"EU shoe size, e.g. 43"},
     {"key":"colorway","type":"string","description":"e.g. white/grey"},
     {"key":"has_original_box","type":"boolean"}]'),
  ('shoes', 'Non-sneaker footwear',
   '[{"key":"size_eu","type":"number","required":true,"description":"EU shoe size"},
     {"key":"material","type":"string"}]'),
  ('clothing', 'Clothes and accessories',
   '[{"key":"size","type":"string","required":true,"description":"e.g. M, 42, One Size"},
     {"key":"material","type":"string"},
     {"key":"color","type":"string"}]'),
  ('electronics', 'Consumer electronics',
   '[{"key":"model","type":"string","description":"Model name/number"},
     {"key":"warranty_months","type":"number"}]'),
  ('phones', 'Mobile phones',
   '[{"key":"model","type":"string","required":true},
     {"key":"storage_gb","type":"number"},
     {"key":"battery_health_pct","type":"number"}]'),
  ('computers', 'Laptops and desktops',
   '[{"key":"model","type":"string","required":true},
     {"key":"ram_gb","type":"number"},
     {"key":"storage_gb","type":"number"}]'),
  ('games', 'Video games and consoles',
   '[{"key":"platform","type":"string","enum":["nintendo_switch","ps4","ps5","xbox_one","xbox_series","pc","other"],"required":true}]'),
  ('books', 'Books and magazines',
   '[{"key":"author","type":"string"},
     {"key":"isbn","type":"string"},
     {"key":"language","type":"string"}]'),
  ('music', 'Instruments, vinyl, CDs',
   '[{"key":"format","type":"string","enum":["vinyl","cd","cassette","instrument","other"]},
     {"key":"artist","type":"string"}]'),
  ('sports', 'Sports and outdoor gear',
   '[{"key":"sport","type":"string"}]'),
  ('home', 'Furniture and household',
   '[{"key":"material","type":"string"},
     {"key":"color","type":"string"}]'),
  ('toys', 'Toys and games',
   '[{"key":"age_range","type":"string","description":"e.g. 6+, 12+"}]'),
  ('collectibles', 'Collectibles and memorabilia',
   '[{"key":"franchise","type":"string"}]'),
  ('other', 'Everything else', '[]')
ON CONFLICT (name) DO NOTHING;

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
