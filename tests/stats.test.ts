// THI-311: /stats.json platform counters — cache + single-flight + fail-secure
// degrade. In-process only: the pg pool's query is spied, no Postgres needed
// (same pattern as tests/api-error-handling.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { pool } from "../src/db.js";
import {
  getPlatformStats,
  resetStatsCacheForTests,
  STATS_MAX_STALE_MS,
  STATS_TTL_MS,
  statsHandler,
} from "../src/stats.js";

const countsRow = { items: "120", agents: "34", users: "56" };

function resMock() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    set(key: string, value: string) {
      this.headers[key] = value;
    },
    json(payload: unknown) {
      this.body = payload;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return res as unknown as Response;
}

beforeEach(() => {
  resetStatsCacheForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  resetStatsCacheForTests();
});

describe("getPlatformStats", () => {
  it("returns the three counts from one combined aggregate query", async () => {
    const query = vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [countsRow] });
    const stats = await getPlatformStats();
    expect(stats).toEqual({ items: 120, agents: 34, users: 56 });
    expect(query).toHaveBeenCalledTimes(1);
    // Definitions (PR note): deleted items excluded, revoked grants excluded.
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("count(*) FROM items WHERE status <> 'deleted'");
    expect(sql).toContain("count(*) FROM oauth_grants WHERE revoked_at IS NULL");
    expect(sql).toContain("count(*) FROM sellers");
  });

  it("serves the cached value within the TTL (no second query)", async () => {
    const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [countsRow] });
    await getPlatformStats();
    await getPlatformStats();
    await getPlatformStats();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent cold requests into a single query (single-flight)", async () => {
    let resolveQuery: (value: { rows: unknown[] }) => void = () => {};
    const query = vi
      .spyOn(pool, "query")
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveQuery = resolve as typeof resolveQuery)),
      );
    const p1 = getPlatformStats();
    const p2 = getPlatformStats();
    const p3 = getPlatformStats();
    resolveQuery({ rows: [countsRow] });
    const expected = { items: 120, agents: 34, users: 56 };
    expect(await p1).toEqual(expected);
    expect(await p2).toEqual(expected);
    expect(await p3).toEqual(expected);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    vi.useFakeTimers();
    const query = vi.spyOn(pool, "query").mockResolvedValue({ rows: [countsRow] });
    await getPlatformStats();
    vi.advanceTimersByTime(STATS_TTL_MS + 1);
    await getPlatformStats();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("cold failure rejects (caller answers 503 — never fake zeros)", async () => {
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("db down"));
    await expect(getPlatformStats()).rejects.toThrow("db down");
  });

  it("warm failure serves the stale value within STATS_MAX_STALE_MS", async () => {
    vi.useFakeTimers();
    vi.spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [countsRow] })
      .mockRejectedValueOnce(new Error("db down"));
    await getPlatformStats();
    vi.advanceTimersByTime(STATS_TTL_MS + 1);
    await expect(getPlatformStats()).resolves.toEqual({ items: 120, agents: 34, users: 56 });
  });

  it("stale past STATS_MAX_STALE_MS rejects again", async () => {
    vi.useFakeTimers();
    vi.spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [countsRow] })
      .mockRejectedValueOnce(new Error("db down"));
    await getPlatformStats();
    vi.advanceTimersByTime(STATS_MAX_STALE_MS + STATS_TTL_MS + 1);
    await expect(getPlatformStats()).rejects.toThrow("db down");
  });
});

describe("statsHandler", () => {
  it("serves the counts with a short-TTL public cache header", async () => {
    vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [countsRow] });
    const res = resMock();
    await statsHandler({} as Request, res);
    const r = res as unknown as { statusCode: number; body: unknown; headers: Record<string, string> };
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ items: 120, agents: 34, users: 56 });
    expect(r.headers["Cache-Control"]).toContain("max-age=60");
    expect(r.headers["Cache-Control"]).toContain("stale-while-revalidate");
  });

  it("answers 503 JSON on a cold DB failure", async () => {
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("db down"));
    const res = resMock();
    await statsHandler({} as Request, res);
    const r = res as unknown as { statusCode: number; body: unknown };
    expect(r.statusCode).toBe(503);
    expect(r.body).toEqual({ error: "stats unavailable" });
  });
});
