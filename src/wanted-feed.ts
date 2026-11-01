// THI-441 (B2+B3) built the wanted UX against this seam with demo data;
// THI-440 (backend sibling) swapped the bodies for real src/wanted.ts
// reads — wantedBoard()/getWanted()/wantedDemandByCategory() are now thin
// view-model mappers over searchWanted/getWantedById and one aggregate
// query. Browser writes (create/edit/expire/renew) POST to the spec §6.3
// endpoints (/api/wanted, PR 5).
//
// Pure helpers (budgetRange, wantedFreshness) are unit-tested in
// tests/wanted-feed.test.ts and shared by every wanted surface so the
// non-negotiable visual language lives in exactly one place: budget is a
// RANGE ("€150–200"), never a single price badge (THI-437 §5).

import type { Request, Response } from "express";
import { searchWanted, getWantedById, type WantedRow } from "./wanted.js";
import { pool } from "./db.js";

/** Public wanted view-model — mirrors `wantedToPublic` (THI-439 §5).
 *  Never carries buyer identity or the embedding vector. */
export interface WantedPublicVM {
  id: string;
  title: string;
  notes: string;
  category: string;
  condition: string | null;
  budget_min_cents: number | null;
  budget_max_cents: number | null;
  currency: string;
  reference_images: string[];
  /** ISO timestamps; the board lazy-guards `status==='active' && expires_at > now`. */
  created_at: string;
  expires_at: string;
  status: "active" | "expired";
}

/** Board query options — predicate parity with searchWanted (THI-439 §3.4). */
export interface WantedBoardQuery {
  q?: string;
  category?: string;
  condition?: string;
  limit?: number;
  offset?: number;
}

/** Demand counts for the seller dashboard strip (THI-439 §6.4, B3). */
export interface WantedDemandRow {
  category: string;
  count: number;
  example_title: string;
}

// ---------------------------------------------------------------------------
// Visual-language helpers (pure, one source of truth)
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

const centsToAmount = (cents: number): string =>
  cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);

/** Budget as a range — the non-negotiable wanted visual language:
 *  both → "€150–200" · max only → "up to €200" · min only → "€150+" ·
 *  none → "budget open". NEVER a single price badge like for-sale cards. */
export function budgetRange(min: number | null, max: number | null, currency: string): string {
  const sym = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  if (min != null && max != null) return `${sym}${centsToAmount(min)}–${centsToAmount(max)}`;
  if (max != null) return `up to ${sym}${centsToAmount(max)}`;
  if (min != null) return `${sym}${centsToAmount(min)}+`;
  return "budget open";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RENEWAL_WINDOW_DAYS = 7; // "expiring" derived phase (THI-439 §3.2)

/** Freshness line: "wanted 5 days ago · expires in 25 days", with the
 *  "expiring soon" emphasis inside the final week (spec §6.1). */
export function wantedFreshness(createdAt: string, expiresAt: string, now: Date = new Date()): {
  text: string;
  expiringSoon: boolean;
  expired: boolean;
  daysLeft: number;
} {
  const createdMs = new Date(createdAt).getTime();
  const expiresMs = new Date(expiresAt).getTime();
  const wantedDays = Math.max(0, Math.floor((now.getTime() - createdMs) / DAY_MS));
  const daysLeft = Math.ceil((expiresMs - now.getTime()) / DAY_MS);
  if (daysLeft <= 0) {
    return { text: `wanted ${wantedDays} day${wantedDays === 1 ? "" : "s"} ago · expired`, expiringSoon: false, expired: true, daysLeft: 0 };
  }
  const expiresText = daysLeft <= RENEWAL_WINDOW_DAYS ? `expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} — expiring soon` : `expires in ${daysLeft} days`;
  return {
    text: `wanted ${wantedDays} day${wantedDays === 1 ? "" : "s"} ago · ${expiresText}`,
    expiringSoon: daysLeft <= RENEWAL_WINDOW_DAYS,
    expired: false,
    daysLeft,
  };
}

/** Can the owner renew right now? Final 7 days of an active wanted, or any
 *  time inside the 30-day grace after expiry (THI-439 §3.2 state machine). */
export function renewableNow(expiresAt: string, now: Date = new Date()): boolean {
  const expiresMs = new Date(expiresAt).getTime();
  const active = expiresMs > now.getTime();
  if (active) return expiresMs - now.getTime() <= RENEWAL_WINDOW_DAYS * DAY_MS;
  return now.getTime() - expiresMs <= 30 * DAY_MS;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Data access (real reads — src/wanted.ts, swapped in by THI-440 PR 4)
// ---------------------------------------------------------------------------

/** DB row → view-model: ISO timestamps for the browser; the row shape is
 *  otherwise the wantedToPublic contract (§5) minus derived fields. */
function toVM(w: WantedRow): WantedPublicVM {
  return {
    id: w.id,
    title: w.title,
    notes: w.notes,
    category: w.category,
    condition: w.condition,
    budget_min_cents: w.budget_min_cents,
    budget_max_cents: w.budget_max_cents,
    currency: w.currency,
    reference_images: w.reference_images,
    created_at: w.created_at.toISOString(),
    expires_at: w.expires_at.toISOString(),
    status: w.status as WantedPublicVM["status"],
  };
}

/** Board read for /wanted — searchWanted with its full predicate family
 *  (§3.4: visibility lazy guard, hybrid q, filters) and view-model mapping. */
export async function wantedBoard(query: WantedBoardQuery): Promise<WantedPublicVM[]> {
  const rows = await searchWanted({
    q: query.q,
    category: query.category,
    condition: query.condition,
    limit: query.limit ?? 10,
    offset: query.offset ?? 0,
  });
  return rows.map(toVM);
}

/** Single wanted for /wanted/:id — null for unknown AND ended ids (no
 *  existence oracle; the lazy guard lives in getWantedById). */
export async function getWanted(id: string): Promise<WantedPublicVM | null> {
  const row = await getWantedById(id);
  return row ? toVM(row) : null;
}

/** Active-wanted counts per category for the seller demand strip (§6.4).
 *  One aggregate query — public counts only, never buyer data. */
export async function wantedDemandByCategory(): Promise<WantedDemandRow[]> {
  const { rows } = await pool.query<WantedDemandRow>(
    `SELECT category, count(*)::int AS count,
            (array_agg(title ORDER BY created_at DESC))[1] AS example_title
     FROM wanted_items
     WHERE status = 'active' AND expires_at > now()
     GROUP BY category
     ORDER BY count DESC, category`,
  );
  return rows;
}


/** GET /wanted/demand.json — read-only website asset consumed by the
 *  account page (B3 demand strip). Follows the /stats.json + /search.json
 *  precedent (THI-389): mounted at the app root in src/index.ts, outside
 *  the protected src/routes.ts router, so no THI-36 gate applies.
 *  CORS-free same-origin fetch only; public counts (no buyer data). */
export async function wantedDemandHandler(_req: Request, res: Response): Promise<void> {
  const demand = await wantedDemandByCategory().catch(() => [] as WantedDemandRow[]);
  const total = demand.reduce((sum, row) => sum + row.count, 0);
  res.set("Cache-Control", "public, max-age=300");
  res.json({ demand, total });
}
