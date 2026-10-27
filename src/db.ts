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
  /** Joined from sellers (getItem/searchItems); absent when not queried. */
  seller_payout_ready?: boolean;
}

export interface SellerRow {
  id: string;
  display_name: string;
}

export const CONDITIONS = ["new", "like_new", "good", "fair", "poor"] as const;
export const STATUSES = ["active", "reserved", "sold", "deleted"] as const;
export const SHIPPING_TIERS = ["locker", "parcel", "bulky", "local", "unknown"] as const;
