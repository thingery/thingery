import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
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
  created_at: Date;
  /** Joined from sellers (getItem/searchItems); absent when not queried. */
  seller_payout_ready?: boolean;
}

export interface SellerRow {
  id: string;
  api_key: string;
  display_name: string;
}

export const CONDITIONS = ["new", "like_new", "good", "fair", "poor"] as const;
export const STATUSES = ["active", "reserved", "sold", "deleted"] as const;
export const SHIPPING_TIERS = ["locker", "parcel", "bulky", "local", "unknown"] as const;
