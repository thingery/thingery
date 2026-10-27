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
  /** THI-308: this fixture has photos, so photo_required=true still means
   *  live — proves the images-present branch never renders the noindex. */
  photo_required: true,
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

/** Renders with getItem mocked to `mockItem` and the session mocked to
 *  `viewer` (null = anonymous). Restores both spies. */
async function renderWith(mockItem: ItemRow, viewer: { id: string; display_name: string } | null): Promise<string> {
  const getItemSpy = vi.spyOn(items, "getItem").mockResolvedValue(mockItem);
  const sessionSpy = vi.spyOn(auth, "sellerFromSession").mockResolvedValue(viewer);
  try {
    return await renderItemPage(mockItem.id);
  } finally {
    getItemSpy.mockRestore();
    sessionSpy.mockRestore();
  }
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

describe("item page photo step (THI-308 PR 3)", () => {
  const pendingItem: ItemRow = { ...item, images: [] }; // photo_required: true
  const owner = { id: "seller-1", display_name: "Owner" };
  const stranger = { id: "seller-2", display_name: "Stranger" };

  it("renders placeholder art + crawler-visible noindex for a zero-image pending item", async () => {
    const html = await renderWith(pendingItem, null);
    expect(html).toContain('src="/assets/placeholder-item.svg"');
    expect(html).not.toContain("No photos yet.</p>"); // text replaced by the SVG
    // Server-rendered in <head> — crawler-visible, not a JS afterthought.
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("does not noindex live listings (photos present, or grandfathered photo_required=false)", async () => {
    const html = await renderWith(item, null); // photos present
    expect(html).not.toContain("noindex");
    const grandfathered = await renderWith({ ...pendingItem, photo_required: false }, null);
    expect(grandfathered).not.toContain("noindex");
  });

  it("shows the owner the capture UI (≤2-tap camera path) + pending banner, with zero inline handlers", async () => {
    const html = await renderWith(pendingItem, owner);
    // Pending banner while hidden from search (P1, light — no modal).
    expect(html).toContain("This listing is hidden from search until you add a photo.");
    // Capture panel: one tap to camera (capture=environment), snap auto-uploads.
    expect(html).toContain('id="photo-take" accept="image/*" capture="environment"');
    expect(html).toContain('id="photo-choose"');
    expect(html).toContain("multiple");
    expect(html).toContain("Listings with photos get far more views.");
    expect(html).toContain('data-max-images="12"'); // existing cap
    // THI-308 PR 4: the current images array is seeded into the panel
    // (JSON, attribute-escaped) so photos.js can rebuild interactive
    // thumbnails — × delete, drag-to-reorder, cover badge — with no fetch.
    expect(html).toContain('data-images="[]"'); // pending item: empty array
    const live = await renderWith(item, owner); // photos present
    expect(live).toContain(`data-images="[${item.images.map((s) => `&quot;${s}&quot;`).join(",")}]"`);
    expect(html).toContain('src="/imaging.js"');
    expect(html).toContain('src="/photos.js"');
    // CSP script-src 'self': every script is an external static file (the
    // ld+json data block is inert) and no element carries an inline
    // event-handler attribute.
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
      expect(/\bsrc=/.test(tag) || /application\/ld\+json/.test(tag), tag).toBe(true);
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("hides the capture UI from non-owners (and anonymous visitors)", async () => {
    for (const viewer of [stranger, null]) {
      const html = await renderWith(pendingItem, viewer);
      expect(html).not.toContain("photo-zone");
      expect(html).not.toContain("photo-take");
      expect(html).not.toContain('src="/photos.js"');
      // The placeholder + noindex still render — they are viewer-independent.
      expect(html).toContain('src="/assets/placeholder-item.svg"');
      expect(html).toContain('<meta name="robots" content="noindex">');
    }
  });
});
