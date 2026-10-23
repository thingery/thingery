// Public platform-usage counters for the thingery.dev homepage (THI-311).
//
// Design (PR spec summary):
//   - One combined aggregate query returns all three counts in a single
//     round trip. Aggregate counts only — no user-identifiable data.
//   - Definitions (kept honest, noted in the PR + served nowhere else):
//       items  = every listing ever published, minus soft-deleted rows
//                (sold/reserved items still count — they were listed)
//       agents = live MCP client connections: non-revoked oauth_grants
//                rows (one per user × connected app; /apps revocation and
//                re-auth prune them, so the number tracks real usage)
//       users  = accounts (the sellers table IS the accounts table)
//   - In-process TTL cache (STATS_TTL_MS, default 60s) + single-flight:
//     at most one count query per TTL per process, even under a cache-bypass
//     stampede. `Cache-Control: public, max-age=60, stale-while-revalidate`
//     lets Caddy and the browser absorb the rest.
//   - Fail-secure degrade: on a cold DB failure the endpoint answers 503
//     (never fake zeros); on a warm failure it serves the last value for
//     up to STATS_MAX_STALE_MS, then 503.
// Deliberately mounted on the app root in src/index.ts (like /healthz),
// NOT inside the protected src/routes.ts API router — it is a read-only
// public website asset, not an API/auth surface change.

import type { Request, Response } from "express";
import { pool } from "./db.js";

export interface PlatformStats {
  items: number;
  agents: number;
  users: number;
}

/** Cache lifetime for fresh counts (spec: 1–5 min revalidation is fine). */
export const STATS_TTL_MS = 60_000;
/** How long a previously fetched value may be served after a refresh failure. */
export const STATS_MAX_STALE_MS = 10 * 60_000;

let cache: { value: PlatformStats; fetchedAt: number } | null = null;
let inflight: Promise<PlatformStats> | null = null;

const COUNTS_SQL = `
  SELECT
    (SELECT count(*) FROM items WHERE status <> 'deleted') AS items,
    (SELECT count(*) FROM oauth_grants WHERE revoked_at IS NULL) AS agents,
    (SELECT count(*) FROM sellers) AS users`;

async function fetchStats(): Promise<PlatformStats> {
  const { rows } = await pool.query<{ items: string; agents: string; users: string }>(COUNTS_SQL);
  const row = rows[0];
  return {
    items: Number(row?.items ?? 0),
    agents: Number(row?.agents ?? 0),
    users: Number(row?.users ?? 0),
  };
}

/** Counts for the homepage strip. Cached per process with single-flight;
 *  on failure serves the last value while it is newer than STATS_MAX_STALE_MS. */
export async function getPlatformStats(): Promise<PlatformStats> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < STATS_TTL_MS) return cache.value;
  if (inflight) return inflight;

  const fetchOnce = fetchStats()
    .then((value) => {
      cache = { value, fetchedAt: Date.now() };
      return value;
    })
    .finally(() => {
      inflight = null;
    });

  inflight = fetchOnce;
  try {
    return await fetchOnce;
  } catch (err) {
    if (cache && now - cache.fetchedAt < STATS_MAX_STALE_MS) {
      return cache.value; // degrade: serve stale rather than fake zeros
    }
    throw err;
  }
}

/** Express handler for GET /stats.json. Fail-secure: 503 JSON on cold DB
 *  failure (the homepage script keeps the strip hidden — no fake numbers). */
export async function statsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const stats = await getPlatformStats();
    res.set("Cache-Control", `public, max-age=${Math.floor(STATS_TTL_MS / 1000)}, stale-while-revalidate=300`);
    res.json(stats);
  } catch {
    res.status(503).json({ error: "stats unavailable" });
  }
}

/** Test seam: drop the cache and any in-flight fetch between cases. */
export function resetStatsCacheForTests(): void {
  cache = null;
  inflight = null;
}
