import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
  // Guardrail (spec THI-83 §3.5): cap any single statement/query at 3s so a
  // pathological attribute-heavy query can't pin a pool connection open.
  // scripts/migrate.ts uses its own connection and stays uncapped by design.
  statement_timeout: 3000,
  query_timeout: 3000,
});

export interface ItemRow {
  id: string;
  seller_id: string;
  title: string;
  description: string;
  category: string;
  condition: string;
  brand: string | null;
  price_cents: number;
  currency: string;
  location: string | null;
  weight_grams: number | null;
  dimensions_mm: string | null;
  shipping_tier: string;
  shipping_price_cents: number;
  images: string[];
  attributes: Record<string, unknown>;
  status: string;
  /** THI-308: new listings default true — pending until the first photo.
   *  Derived visibility: hidden from feeds while true and images is empty. */
  photo_required: boolean;
  created_at: Date;
  /** Column on items, present in RETURNING * / SELECT i.*; pg hands the
   *  vector back as its string form. Absent when not queried. */
  embedding?: string | null;
  /** Joined from sellers (getItem/searchItems); absent when not queried. */
  seller_payout_ready?: boolean;
  /** THI-1625 B-2: connected payout account's country (D4 allowlist input);
   *  present only on queries that join sellers for payout readiness. NULL
   *  for legacy accounts until Stripe delivers their next account event. */
  seller_stripe_country?: string | null;
}

export interface SellerRow {
  id: string;
  display_name: string;
}

export const CONDITIONS = ["new", "like_new", "good", "fair", "poor"] as const;
/** Full item status domain (ADR 0010). `stored` is owner-private inventory:
 *  in the CHECK (db/schema.sql), visible to its owner only, and every public
 *  surface filters it out. `reserved`/`sold` stay order-machine-owned; only
 *  CREATE_ITEM_STATUSES are legal at create time. z.enum(STATUSES) sites
 *  (my_listings, update_listing) pick `stored` up from here. */
export const STATUSES = ["active", "stored", "reserved", "sold", "deleted"] as const;
/** Statuses create_listing may set: `active` (default, for sale) or `stored`
 *  (ADR 0010 — save to private inventory). Everything else is written by the
 *  owner toggles (`update_listing`) or the order machine, never by create. */
export const CREATE_ITEM_STATUSES = ["active", "stored"] as const;
export const SHIPPING_TIERS = ["locker", "parcel", "bulky", "local", "unknown"] as const;
