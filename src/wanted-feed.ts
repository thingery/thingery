// THI-441 (B2+B3, spec THI-439 §6): frontend data adapter for the wanted
// listings UX — the /wanted board, the zero-result funnel form, my-wanted
// management, and the seller demand strip.
//
// This module is the single integration seam between the wanted UX frontend
// and the backend sibling (THI-440: src/wanted.ts + /api/wanted routes).
// Today the backend has not landed, so board/demand reads serve clearly
// labelled demo data (non-production, or WANTED_UI_MOCK=1) and an honest
// empty board otherwise. Browser writes (create/edit/expire/renew) POST to
// the spec §6.3 endpoints and degrade gracefully while they 404.
//
// When THI-440 lands: swap the bodies of wantedBoard()/getWanted()/
// wantedDemandByCategory() for calls into src/wanted.ts (searchWanted et al)
// and delete the mock block. The view-model mirrors the spec §5
// `wantedToPublic` payload exactly, so the swap is type-compatible.
//
// Pure helpers (budgetRange, wantedFreshness) are unit-tested in
// tests/wanted-feed.test.ts and shared by every wanted surface so the
// non-negotiable visual language lives in exactly one place: budget is a
// RANGE ("€150–200"), never a single price badge (THI-437 §5).

import type { Request, Response } from "express";

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
// Demo data (THI-441 frontend-from-mocks pass; deleted when THI-440 lands)
// ---------------------------------------------------------------------------

/** Mocks render in non-production environments, or in production only with
 *  an explicit opt-in — production must never show synthetic demand. */
export function wantedMockEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.WANTED_UI_MOCK === "1";
}

const DEMO_WANTEDS: WantedPublicVM[] = [
  {
    id: "11111111-1111-4111-8111-111111111101",
    title: "Nintendo Switch OLED",
    notes: "Preferably with dock and both Joy-Cons. Small scratch on the bezel is fine.",
    category: "electronics",
    condition: "good",
    budget_min_cents: 15000,
    budget_max_cents: 20000,
    currency: "EUR",
    reference_images: [],
    created_at: new Date(Date.now() - 5 * DAY_MS).toISOString(),
    expires_at: new Date(Date.now() + 25 * DAY_MS).toISOString(),
    status: "active",
  },
  {
    id: "11111111-1111-4111-8111-111111111102",
    title: "Nike Air Max 90, EU 43",
    notes: "Any classic colorway, worn is fine as long as the sole is intact.",
    category: "sneakers",
    condition: null,
    budget_min_cents: 4000,
    budget_max_cents: 8000,
    currency: "EUR",
    reference_images: [],
    created_at: new Date(Date.now() - 2 * DAY_MS).toISOString(),
    expires_at: new Date(Date.now() + 5 * DAY_MS).toISOString(),
    status: "active",
  },
  {
    id: "11111111-1111-4111-8111-111111111103",
    title: "Stand mixer, any brand",
    notes: "KitchenAid or similar. Cash budget is flexible for the right one.",
    category: "home",
    condition: "good",
    budget_min_cents: null,
    budget_max_cents: 12000,
    currency: "EUR",
    reference_images: [],
    created_at: new Date(Date.now() - 9 * DAY_MS).toISOString(),
    expires_at: new Date(Date.now() + 21 * DAY_MS).toISOString(),
    status: "active",
  },
  {
    id: "11111111-1111-4111-8111-111111111104",
    title: "Film camera bag, canvas",
    notes: "Something like a Domke F-2 — must fit two bodies and three lenses.",
    category: "cameras",
    condition: null,
    budget_min_cents: 3000,
    budget_max_cents: null,
    currency: "EUR",
    reference_images: [],
    created_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    expires_at: new Date(Date.now() + 29 * DAY_MS).toISOString(),
    status: "active",
  },
  {
    id: "11111111-1111-4111-8111-111111111105",
    title: "Kids bike, 20 inch",
    notes: "Expired demo row — never rendered on the board (lazy guard).",
    category: "sports",
    condition: "fair",
    budget_min_cents: null,
    budget_max_cents: 6000,
    currency: "EUR",
    reference_images: [],
    created_at: new Date(Date.now() - 40 * DAY_MS).toISOString(),
    expires_at: new Date(Date.now() - 10 * DAY_MS).toISOString(),
    status: "expired",
  },
];

const mockBoard = (opts: WantedBoardQuery): WantedPublicVM[] => {
  const q = opts.q?.trim().toLowerCase();
  const now = Date.now();
  return DEMO_WANTEDS
    // Visibility lazy guard (spec §3.4): active AND not yet expired.
    .filter((w) => w.status === "active" && new Date(w.expires_at).getTime() > now)
    .filter((w) => (opts.category ? w.category === opts.category : true))
    .filter((w) => (opts.condition ? w.condition === opts.condition : true))
    .filter((w) => (q ? w.title.toLowerCase().includes(q) || w.notes.toLowerCase().includes(q) : true))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 10));
};

const mockDemand = (): WantedDemandRow[] => {
  const byCat = new Map<string, WantedDemandRow>();
  for (const w of mockBoard({ limit: 100 })) {
    const row = byCat.get(w.category) ?? { category: w.category, count: 0, example_title: w.title };
    row.count += 1;
    byCat.set(w.category, row);
  }
  return [...byCat.values()].sort((a, b) => b.count - a.count);
};

// ---------------------------------------------------------------------------
// Data access (the seam — THI-440 swaps these bodies for src/wanted.ts calls)
// ---------------------------------------------------------------------------

/** Board read for /wanted — `searchWanted` parity (THI-439 §3.4). */
export async function wantedBoard(query: WantedBoardQuery): Promise<WantedPublicVM[]> {
  // TODO(THI-440): return searchWanted(query) — identical shape.
  return wantedMockEnabled() ? mockBoard(query) : [];
}

/** Single wanted for /wanted/:id — null for unknown ids (no existence oracle). */
export async function getWanted(id: string): Promise<WantedPublicVM | null> {
  // TODO(THI-440): return getWantedById(id) with the same lazy guard.
  if (!wantedMockEnabled()) return null;
  return mockBoard({ limit: 100 }).find((w) => w.id === id) ?? null;
}

/** Active-wanted counts per category for the seller demand strip (§6.4). */
export async function wantedDemandByCategory(): Promise<WantedDemandRow[]> {
  // TODO(THI-440): one aggregate query over wanted_items (status='active'
  // AND expires_at > now()), grouped by category.
  return wantedMockEnabled() ? mockDemand() : [];
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
