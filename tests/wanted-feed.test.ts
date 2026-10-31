// THI-441 (spec THI-439 §6): unit tests for the wanted UX data seam —
// the visual-language helpers (budget as a RANGE, never a single price
// badge; freshness line), the renewal window predicate, and the demo-data
// board that stands in until the backend sibling (THI-440) lands.
// Pure/in-process: no Postgres needed.

import { afterEach, describe, expect, it } from "vitest";
import {
  budgetRange,
  getWanted,
  renewableNow,
  wantedBoard,
  wantedDemandByCategory,
  wantedFreshness,
  wantedMockEnabled,
} from "../src/wanted-feed.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-01T12:00:00Z");
const iso = (msFromNow: number): string => new Date(NOW.getTime() + msFromNow).toISOString();

describe("budgetRange — budget is always a range, never a single price badge", () => {
  it("renders both bounds as €min–max", () => {
    expect(budgetRange(15000, 20000, "EUR")).toBe("\u20ac150\u2013200");
  });

  it("renders a max-only budget as 'up to'", () => {
    expect(budgetRange(null, 20000, "EUR")).toBe("up to \u20ac200");
  });

  it("renders a min-only budget as '€min+'", () => {
    expect(budgetRange(15000, null, "EUR")).toBe("\u20ac150+");
  });

  it("renders an open budget honestly", () => {
    expect(budgetRange(null, null, "EUR")).toBe("budget open");
  });

  it("keeps fractional cents and falls back to the currency code", () => {
    expect(budgetRange(15050, 20000, "EUR")).toBe("\u20ac150.50\u2013200");
    expect(budgetRange(15000, 20000, "SEK")).toBe("SEK 150\u2013200");
  });

  it("never renders the for-sale single-price format", () => {
    const text = budgetRange(15000, 20000, "EUR");
    expect(text).not.toMatch(/\d+\.\d\d EUR/); // money() badge format
    expect(text).toContain("\u2013"); // en dash range separator
  });
});

describe("wantedFreshness — 'wanted N days ago · expires in M days'", () => {
  const now = NOW;

  it("matches the spec example exactly", () => {
    const f = wantedFreshness(iso(-5 * DAY), iso(25 * DAY), now);
    expect(f.text).toBe("wanted 5 days ago \u00b7 expires in 25 days");
    expect(f.expiringSoon).toBe(false);
    expect(f.expired).toBe(false);
    expect(f.daysLeft).toBe(25);
  });

  it("flags the final-week expiring emphasis", () => {
    const f = wantedFreshness(iso(-23 * DAY), iso(6 * DAY), now);
    expect(f.expiringSoon).toBe(true);
    expect(f.text).toBe("wanted 23 days ago \u00b7 expires in 6 days \u2014 expiring soon");
  });

  it("reports expiry past the deadline", () => {
    const f = wantedFreshness(iso(-40 * DAY), iso(-1 * DAY), now);
    expect(f.expired).toBe(true);
    expect(f.daysLeft).toBe(0);
    expect(f.text).toBe("wanted 40 days ago \u00b7 expired");
  });
});

describe("renewableNow — final week of active, or 30-day grace after expiry (§3.2)", () => {
  const now = NOW;

  it("rejects renewal mid-life (no free bumping)", () => {
    expect(renewableNow(iso(25 * DAY), now)).toBe(false);
  });

  it("allows renewal in the final 7 days", () => {
    expect(renewableNow(iso(7 * DAY), now)).toBe(true);
    expect(renewableNow(iso(1 * DAY), now)).toBe(true);
  });

  it("allows renewal within the 30-day grace after expiry, never after", () => {
    expect(renewableNow(iso(-10 * DAY), now)).toBe(true);
    expect(renewableNow(iso(-30 * DAY - 1), now)).toBe(false);
  });
});

describe("demo board (until THI-440 swaps the seam)", () => {
  afterEach(() => {
    delete process.env.WANTED_UI_MOCK;
    process.env.NODE_ENV = "test";
  });

  it("serves demo data outside production", async () => {
    expect(wantedMockEnabled()).toBe(true);
    const items = await wantedBoard({ limit: 100 });
    expect(items.length).toBeGreaterThan(0);
  });

  it("filters by q over title+notes, category, and condition", async () => {
    expect((await wantedBoard({ q: "switch" })).length).toBe(1);
    expect((await wantedBoard({ q: "kitchenaid" }))[0]?.title).toContain("mixer");
    expect((await wantedBoard({ category: "sneakers" })).length).toBe(1);
    expect((await wantedBoard({ condition: "good" })).length).toBe(2);
  });

  it("never returns expired demo rows — the lazy visibility guard", async () => {
    const all = await wantedBoard({ limit: 100 });
    expect(all.every((w) => w.status === "active" && new Date(w.expires_at).getTime() > Date.now())).toBe(true);
    expect(all.find((w) => w.title.includes("Kids bike"))).toBeUndefined();
  });

  it("orders newest-first and resolves ids via getWanted", async () => {
    const all = await wantedBoard({ limit: 100 });
    const times = all.map((w) => new Date(w.created_at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const found = await getWanted(all[0].id);
    expect(found?.id).toBe(all[0].id);
    expect(await getWanted("99999999-9999-4999-8999-999999999999")).toBeNull();
  });

  it("serves an honest empty board in production unless explicitly opted in", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.WANTED_UI_MOCK;
    expect(await wantedBoard({ limit: 10 })).toEqual([]);
    expect(await wantedDemandByCategory()).toEqual([]);
    expect(await getWanted("11111111-1111-4111-8111-111111111101")).toBeNull();

    process.env.WANTED_UI_MOCK = "1";
    expect((await wantedBoard({ limit: 10 })).length).toBeGreaterThan(0);
  });

  it("aggregates demand per category with an example title for the strip", async () => {
    const demand = await wantedDemandByCategory();
    expect(demand.length).toBeGreaterThan(1);
    expect(demand[0].count).toBeGreaterThanOrEqual(1);
    expect(demand[0].example_title.length).toBeGreaterThan(0);
    const total = demand.reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe((await wantedBoard({ limit: 100 })).length);
  });
});
