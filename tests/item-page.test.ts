// THI-130 (follow-up to the THI-128 security review of PR #70): item-page
// gallery <img> tags must carry referrerpolicy="no-referrer". Image URLs are
// seller-controlled and may point at arbitrary http(s) hosts (accepted H3
// residual risk); without the attribute, browsers attach the item-page URL as
// Referer to those image requests, letting tracking pixels correlate views
// with the listing (the pixel host still learns the viewer's IP either way).
// In-process only: getItem/sellerFromSession are spied, no Postgres needed.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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

// THI-396: shareable listing URLs — canonical link, rich OG card with a
// branded fallback image, and an obvious next action (CTA + share button).
// Same in-process pattern as above: getItem/sellerFromSession spied, and
// the config module spied to flip the payments phrase deterministically.
import * as config from "../src/config.js";

describe("item page sharing (THI-396)", () => {
  const savedBaseUrl = process.env.PUBLIC_BASE_URL;

  beforeEach(() => {
    delete process.env.PUBLIC_BASE_URL;
  });

  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = savedBaseUrl;
    vi.restoreAllMocks();
  });

  it("emits a canonical link equal to og:url, query-string-free and absolute", async () => {
    const html = await renderWith(item, null);
    expect(html).toContain('<link rel="canonical" href="https://thingery.test/item/itm-1">');
    expect(html).toContain('<meta property="og:url" content="https://thingery.test/item/itm-1">');
    // Canonical is the bare path — utm_* share-tracking params never fork it.
    expect(html).not.toMatch(/rel="canonical"[^>]*\?/);
  });

  it("prefers PUBLIC_BASE_URL over the request host for canonical/og:url", async () => {
    process.env.PUBLIC_BASE_URL = "https://thingery.dev/";
    const html = await renderWith(item, null);
    expect(html).toContain('<link rel="canonical" href="https://thingery.dev/item/itm-1">');
    expect(html).toContain('<meta property="og:url" content="https://thingery.dev/item/itm-1">');
  });

  it("absolutizes root-relative cover photos and sets og:image:alt + location in the description", async () => {
    const localShot = { ...item, images: ["/img/items/itm-1-cover.jpg"] };
    const html = await renderWith(localShot, null);
    expect(html).toContain('<meta property="og:image" content="https://thingery.test/img/items/itm-1-cover.jpg">');
    expect(html).toContain(`<meta property="og:image:alt" content="${item.title}">`);
    // Location rides along in the unfurl text (fixture: Dublin, condition used_good).
    expect(html).toContain('<meta property="og:description" content="520.00 EUR — used, used good · Dublin">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it("keeps http(s) cover photos absolute as-is", async () => {
    const html = await renderWith(item, null);
    expect(html).toContain(`<meta property="og:image" content="${item.images[0]}">`);
  });

  it("falls back to the branded og-image so photo-less shares still render a card", async () => {
    const html = await renderWith({ ...item, images: [] }, null);
    expect(html).toContain('<meta property="og:image" content="https://thingery.test/assets/og-image.png">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it("renders the next-action CTA: prefilled chat deep link + share button + share.js", async () => {
    const html = await renderWith(item, null);
    expect(html).toContain('id="next-step"');
    // Deep link prefills a question about this exact listing (URL-encoded:
    // spaces become %20 under encodeURIComponent).
    expect(html).toMatch(/href="\/chat\.html\?q=[^"]*Sony%20A6400[^"]*"/);
    expect(html).toMatch(/href="\/chat\.html\?q=[^"]*itm-1[^"]*"/);
    // Share button carries the canonical URL + title as data attributes.
    expect(html).toContain('id="share-btn"');
    expect(html).toContain('data-share-url="https://thingery.test/item/itm-1"');
    expect(html).toContain(`data-share-title="${item.title}"`);
    expect(html).toContain('src="/share.js"');
    // Payments are off in this environment (no STRIPE_SECRET_KEY): the MCP path copy.
    expect(html).toContain("ask your AI assistant");
    expect(html).not.toContain("Stripe checkout link");
  });

  it("flips the CTA copy to the Stripe path when payments are on for this seller", async () => {
    const cfgSpy = vi
      .spyOn(config, "orderFlowConfig")
      // web-pages only reads stripePaymentsEnabled here; the rest of the
      // OrderFlowConfig shape is irrelevant to this page.
      .mockReturnValue({ stripePaymentsEnabled: true } as ReturnType<typeof config.orderFlowConfig>);
    expect(cfgSpy).toBeTruthy();
    const on = await renderWith({ ...item, seller_payout_ready: true }, null);
    expect(on).toContain("Stripe checkout link");
    // Payout-ready seller but Stripe off deployment-wide → back to the MCP path.
    cfgSpy.mockReturnValue({ stripePaymentsEnabled: false } as ReturnType<typeof config.orderFlowConfig>);
    const off = await renderWith({ ...item, seller_payout_ready: true }, null);
    expect(off).toContain("ask your AI assistant");
  });

  it("drops the CTA and share script on sold listings — URL and OG card stay stable", async () => {
    const html = await renderWith({ ...item, status: "sold" }, null);
    expect(html).not.toContain('id="next-step"');
    expect(html).not.toContain("share-btn");
    expect(html).not.toContain('src="/share.js"');
    // The shareable address and unfurl survive the sale (no link churn).
    expect(html).toContain('<link rel="canonical" href="https://thingery.test/item/itm-1">');
    expect(html).toContain(`<meta property="og:image" content="${item.images[0]}">`);
  });
});
