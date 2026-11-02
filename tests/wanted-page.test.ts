// THI-441 (B2+B3, spec THI-439 §6): page-render tests for the wanted UX —
// the /wanted board, /wanted/:id detail, the /wanted/new funnel form, and
// the zero-result funnel on /browse. In-process only: the data seam
// (src/wanted-feed.ts) and searchItems/listCategories are spied, no
// Postgres needed (item-page.test.ts pattern).
//
// The visual language is the contract under test: WANTED chip + budget as a
// RANGE ("€150–200"), never the for-sale single-price badge; freshness line
// "wanted N days ago · expires in M days"; dedicated /wanted tab.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import * as items from "../src/items.js";
import * as feed from "../src/wanted-feed.js";
import type { WantedPublicVM } from "../src/wanted-feed.js";
import { browsePage, wantedBoardPage, wantedDetailPage, wantedNewPage } from "../src/web-pages.js";

const DAY = 24 * 60 * 60 * 1000;
// Skew timestamps inward (a hair past whole days) so floor/ceil day counts
// are stable against the few ms of clock movement during rendering.
const ago = (days: number) => new Date(Date.now() - days * DAY - 2000).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * DAY - 2000).toISOString();

const wanted = (overrides: Partial<WantedPublicVM> = {}): WantedPublicVM => ({
  id: "22222222-2222-4222-8222-222222222201",
  title: "Nintendo Switch OLED",
  notes: "With dock and both Joy-Cons, small scratches fine.",
  category: "electronics",
  condition: "good",
  budget_min_cents: 15000,
  budget_max_cents: 20000,
  currency: "EUR",
  reference_images: [],
  created_at: ago(5),
  expires_at: ahead(25),
  status: "active",
  ...overrides,
});

function render(
  handler: (req: Request, res: Response) => Promise<void>,
  reqOverrides: Record<string, unknown>,
): Promise<{ html: string; status: number }> {
  return new Promise((resolve, reject) => {
    const captured = { html: "", status: 200 };
    const res = {
      status: vi.fn((code: number) => {
        captured.status = code;
        return res;
      }),
      send: vi.fn((html: string) => {
        captured.html = html;
        resolve(captured);
      }),
      set: vi.fn(() => res),
    } as unknown as Response;
    const req = { params: {}, query: {}, protocol: "https", get: () => "thingery.test", ...reqOverrides } as unknown as Request;
    handler(req, res).catch(reject);
  });
}

beforeEach(() => {
  vi.spyOn(items, "searchItems").mockResolvedValue([]);
  vi.spyOn(items, "listCategories").mockResolvedValue([
    { name: "electronics", description: "Consumer electronics", listing_count: 2 },
    { name: "sneakers", description: "Trainers and sneakers", listing_count: 1 },
  ]);
});

describe("browsePage — zero-result funnel (B2, spec §6.2)", () => {
  it("renders 'Nothing used listed right now' + the prefilled CTA on a dead-end search", async () => {
    const { html } = await render(browsePage, { query: { q: "Nintendo Switch OLED" } });
    expect(html).toContain("Nothing used listed right now");
    expect(html).toContain("Save what you're looking for →");
    expect(html).toContain('href="/wanted/new?prefill=Nintendo%20Switch%20OLED"');
    expect(html).toContain("Buyers want");
  });

  it("renders the plain empty state when browsing without a query", async () => {
    const { html } = await render(browsePage, { query: {} });
    expect(html).not.toContain("Nothing used listed right now");
  });

  it("renders no funnel when results exist", async () => {
    vi.spyOn(items, "searchItems").mockResolvedValue([
      {
        id: "itm-1",
        seller_id: "s1",
        title: "Switch",
        description: "",
        category: "electronics",
        condition: "good",
        brand: null,
        price_cents: 15000,
        currency: "EUR",
        location: null,
        weight_grams: null,
        dimensions_mm: null,
        shipping_tier: "standard",
        shipping_price_cents: 500,
        images: [],
        attributes: {},
        status: "active",
        photo_required: true,
        created_at: new Date(),
        score: 1,
      },
    ]);
    const { html } = await render(browsePage, { query: { q: "switch" } });
    expect(html).not.toContain("Nothing used listed right now");
  });
});

describe("wantedBoardPage — the /wanted board (B3)", () => {
  it("renders WANTED chip, budget as a range, freshness line, and category chips", async () => {
    const boardSpy = vi.spyOn(feed, "wantedBoard").mockResolvedValue([wanted(), wanted({ id: "22222222-2222-4222-8222-222222222202", title: "Nike Air Max 90, EU 43", category: "sneakers", condition: null, budget_min_cents: 4000, budget_max_cents: 8000, created_at: ago(2), expires_at: ahead(5) })]);
    const { html } = await render(wantedBoardPage, { query: {} });
    expect(boardSpy).toHaveBeenCalledTimes(1);
    expect(html).toContain("WANTED");
    expect(html).toContain("\u20ac150\u2013200");
    expect(html).toContain("wanted 5 days ago \u00b7 expires in 25 days");
    expect(html).toContain("expiring"); // 5 days left → expiring-soon emphasis class
    expect(html).toContain('href="/wanted?category=electronics"');
    // Never the for-sale single-price badge format:
    expect(html).not.toMatch(/\d+\.\d\d EUR/);
    // Dedicated tab — board links back to the for-sale feed, never mixes it in:
    expect(html).not.toContain('href="/item/');
  });

  it("renders an honest empty board with the buyer CTA", async () => {
    vi.spyOn(feed, "wantedBoard").mockResolvedValue([]);
    const { html } = await render(wantedBoardPage, { query: {} });
    expect(html).toContain("No wanted listings yet");
    expect(html).toContain('href="/wanted/new"');
  });
});

describe("wantedDetailPage — /wanted/:id", () => {
  it("renders the wanted item, budget range, and the respond_to_wanted agent CTA", async () => {
    const id = "22222222-2222-4222-8222-222222222201";
    vi.spyOn(feed, "getWanted").mockResolvedValue(wanted());
    const { html, status } = await render(wantedDetailPage, { params: { id } });
    expect(status).toBe(200);
    expect(html).toContain("Nintendo Switch OLED");
    expect(html).toContain("\u20ac150\u2013200");
    expect(html).toContain(`wanted_id ${id}`);
    expect(html).toContain("respond_to_wanted");
    expect(html).toContain("/chat.html?q=");
    expect(html).not.toContain("noindex");
  });

  it("noindexes expired wanteds and drops the respond CTA", async () => {
    vi.spyOn(feed, "getWanted").mockResolvedValue(wanted({ status: "expired", expires_at: ago(2), created_at: ago(32) }));
    const { html } = await render(wantedDetailPage, { params: { id: "22222222-2222-4222-8222-222222222201" } });
    expect(html).toContain("noindex");
    expect(html).toContain("ended");
    expect(html).not.toContain("respond_to_wanted");
  });

  it("renders the 404 shape for unknown ids — no existence oracle", async () => {
    vi.spyOn(feed, "getWanted").mockResolvedValue(null);
    const { html, status } = await render(wantedDetailPage, { params: { id: "33333333-3333-4333-8333-333333333301" } });
    expect(status).toBe(404);
    expect(html).toContain("Not found");
  });
});

describe("wantedNewPage — the funnel form (B2)", () => {
  it("prefills the title from the failed query and defaults the alert on", async () => {
    const { html } = await render(wantedNewPage, { query: { prefill: "Nintendo Switch OLED" } });
    expect(html).toContain('value="Nintendo Switch OLED"');
    expect(html).toMatch(/name="alert_me"[^>]*checked/);
    expect(html).toContain("alert me when a matching listing appears");
    // Optional reference image — no photo required:
    expect(html).toContain("no photo needed");
    expect(html).toContain("/wanted.js");
  });

  it("renders without a prefill query", async () => {
    const { html, status } = await render(wantedNewPage, { query: {} });
    expect(status).toBe(200);
    expect(html).toContain("Save what you&#39;re looking for");
  });
});
