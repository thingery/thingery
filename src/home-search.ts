// Public homepage demo search (THI-389): GET /search.json?q=…&limit=N
//
// Backs the "Try it right now" inline demo on the homepage — a visitor runs
// a REAL search from the homepage, no signup, no page switch. Results come
// from the same single feed choke point as /browse and MCP search_items
// (src/items.ts searchItems: active + feed-visible rows only, pending
// zero-photo listings excluded there).
//
// Design notes:
//   - Website asset, not an API/auth surface change — deliberately mounted
//     on the app root in src/index.ts like /stats.json and /healthz, NOT
//     inside the protected src/routes.ts API router (same precedent and
//     reasoning as THI-311 for /stats.json).
//   - Read-only view of data already public as HTML on /browse item cards;
//     only the fields the demo card renders are projected out.
//   - Small hard caps: q ≤ 200 chars (same clamp as browsePage) and at
//     least 2 characters, limit clamped to 1..HOME_SEARCH_MAX_LIMIT
//     (default 3) so this stays a demo box, not a bulk feed (searchItems
//     itself additionally caps limit at 50).
//   - Fail-secure degrade: DB/embedding failure → 503 JSON, never fake or
//     empty "no results" (the homepage script shows a graceful fallback
//     line instead).

import type { Request, Response } from "express";
import { searchItems } from "./items.js";

export const HOME_SEARCH_DEFAULT_LIMIT = 3;
export const HOME_SEARCH_MAX_LIMIT = 5;

function parseLimit(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return HOME_SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), HOME_SEARCH_MAX_LIMIT);
}

/** Express handler for GET /search.json — homepage demo search. */
export async function homeSearchHandler(req: Request, res: Response): Promise<void> {
  const q = (typeof req.query.q === "string" ? req.query.q : "").trim().slice(0, 200);
  if (q.length < 2) {
    res.status(400).json({ error: "q must be at least 2 characters" });
    return;
  }
  const limit = parseLimit(req.query.limit);
  try {
    const items = await searchItems({ q, limit });
    res.set("Cache-Control", "public, max-age=30");
    res.json({
      q,
      results: items.map((item) => ({
        id: item.id,
        title: item.title,
        price_cents: item.price_cents,
        currency: item.currency,
        condition: item.condition,
        category: item.category,
        image: item.images[0] ?? null,
        url: `/item/${item.id}`,
      })),
    });
  } catch {
    res.status(503).json({ error: "search unavailable" });
  }
}
