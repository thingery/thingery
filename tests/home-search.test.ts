// THI-389: /search.json homepage demo search — shape, hard caps, fail-secure
// degrade. In-process only: the pg pool's query is spied, no Postgres needed
// (same pattern as tests/stats.test.ts). No EMBED_API_KEY in the test env, so
// searchItems takes the keyword-only fallback — exactly one pool query.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { pool } from "../src/db.js";
import { homeSearchHandler, HOME_SEARCH_MAX_LIMIT } from "../src/home-search.js";

const row = (over: Record<string, unknown> = {}) => ({
  id: "item-1",
  title: "Diplomat fountain pen",
  price_cents: 12000,
  currency: "EUR",
  condition: "good",
  category: "stationery",
  images: ["/img/pen.webp"],
  status: "active",
  score: 0,
  ...over,
});

function reqMock(query: Record<string, unknown> = {}) {
  return { query } as unknown as Request;
}

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
  vi.restoreAllMocks();
});

describe("homeSearchHandler (GET /search.json)", () => {
  it("maps feed rows to the public demo projection", async () => {
    const query = vi
      .spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [row(), row({ id: "item-2", images: [] })] });
    const res = resMock();
    await homeSearchHandler(reqMock({ q: "fountain pen" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toContain("public");
    expect(res.body).toEqual({
      q: "fountain pen",
      results: [
        {
          id: "item-1",
          title: "Diplomat fountain pen",
          price_cents: 12000,
          currency: "EUR",
          condition: "good",
          category: "stationery",
          image: "/img/pen.webp",
          url: "/item/item-1",
        },
        {
          id: "item-2",
          title: "Diplomat fountain pen",
          price_cents: 12000,
          currency: "EUR",
          condition: "good",
          category: "stationery",
          image: null,
          url: "/item/item-2",
        },
      ],
    });
    // Same feed choke point as /browse and MCP search_items: active rows only.
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("i.status = 'active'");
  });

  it("clamps the limit to HOME_SEARCH_MAX_LIMIT (demo box, not a bulk feed)", async () => {
    const query = vi.spyOn(pool, "query").mockResolvedValueOnce({ rows: [] });
    const res = resMock();
    await homeSearchHandler(reqMock({ q: "camera", limit: "100" }), res);
    expect(res.statusCode).toBe(200);
    expect(query.mock.calls[0][1]).toContain(HOME_SEARCH_MAX_LIMIT);
  });

  it("rejects queries shorter than 2 characters with 400, no DB hit", async () => {
    const query = vi.spyOn(pool, "query");
    const res = resMock();
    await homeSearchHandler(reqMock({ q: "a" }), res);
    expect(res.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("fail-secure: 503 JSON on DB failure, never fake results", async () => {
    vi.spyOn(pool, "query").mockRejectedValueOnce(new Error("db down"));
    const res = resMock();
    await homeSearchHandler(reqMock({ q: "camera" }), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ error: "search unavailable" });
  });
});
