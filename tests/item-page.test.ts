// THI-130 (follow-up to the THI-128 security review of PR #70): item-page
// gallery <img> tags must carry referrerpolicy="no-referrer". Image URLs are
// seller-controlled and may point at arbitrary http(s) hosts (accepted H3
// residual risk); without the attribute, browsers attach the item-page URL as
// Referer to those image requests, letting tracking pixels correlate views
// with the listing (the pixel host still learns the viewer's IP either way).
// In-process only: getItem/sellerFromSession are spied, no Postgres needed.

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import * as items from "../src/items.js";
import * as auth from "../src/auth.js";
import type { ItemRow } from "../src/db.js";
import { itemPage } from "../src/web-pages.js";

const item: ItemRow = {
  id: "itm-1",
  seller_id: "seller-1",
  title: "Sony A6400 body + kit lens",
  description: "Well kept.",
  category: "cameras",
  condition: "used_good",
  brand: "Sony",
  price_cents: 52000,
  currency: "EUR",
  location: "Dublin",
  weight_grams: 403,
  dimensions_mm: "120x67x60",
  shipping_tier: "standard",
  shipping_price_cents: 500,
  images: ["https://cdn.example.com/a.jpg", "http://cdn.example.net/b.jpg"],
  attributes: {},
  status: "active",
  created_at: new Date("2026-10-01T00:00:00Z"),
};

function renderItemPage(itemId = "itm-1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const res = {
      status: vi.fn(() => res),
      send: vi.fn((html: string) => resolve(html)),
    } as unknown as Response;
    const req = {
      params: { id: itemId },
      protocol: "https",
      get: () => "thingery.test",
    } as unknown as Request;
    itemPage(req, res).catch(reject);
  });
}

describe("item page gallery (THI-130: referrerpolicy=no-referrer)", () => {
  it("renders every gallery <img> with referrerpolicy=\"no-referrer\"", async () => {
    const getItemSpy = vi.spyOn(items, "getItem").mockResolvedValue(item);
    const sessionSpy = vi.spyOn(auth, "sellerFromSession").mockResolvedValue(null);
    try {
      const html = await renderItemPage();
      for (const src of item.images) {
        expect(html).toContain(
          `<img src="${src}" alt="${item.title}" loading="lazy" referrerpolicy="no-referrer">`,
        );
      }
      // No gallery img without the attribute.
      expect(html).not.toMatch(/<img(?![^>]*referrerpolicy="no-referrer")[^>]*>/);
    } finally {
      getItemSpy.mockRestore();
      sessionSpy.mockRestore();
    }
  });
});
