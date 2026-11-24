// THI-816 (P1-4 format_listing, spec THI-813 §5 + §11.6): template-lint
// tests. The export copy must be deterministic (same input → byte-identical
// output), respect each platform's title limit, assemble the description in
// the spec's block order, expose platform-labeled fields + a versioned JSON
// envelope for all 4 platforms × both languages, and never leak seller
// identity (the template input allowlist has no seller fields — enforced
// structurally and asserted here). Pure core — no DB needed.
//
// Title-limit constants are TEMPLATE CONSTANTS verified against the live
// platform docs at PR time (PR checklist on THI-816): eBay 80 / Subito 60 /
// Vinted 60 / Wallapop 50. Platform drift = same-PR constant + test update,
// never a breaking change (spec Open Question 6 posture).

import { describe, expect, it } from "vitest";
import {
  clampTitleToLimit,
  formatListing,
  LANGUAGES,
  PLATFORM_TITLE_LIMITS,
  PLATFORMS,
  type FormatListingItem,
} from "../src/format-listing.js";
import type { AttributeDefinition } from "../src/attributes.js";

const defs: AttributeDefinition[] = [
  { key: "size_eu", type: "number", required: true, description: "EU shoe size" },
  { key: "colorway", type: "string", description: "colour" },
  { key: "has_original_box", type: "boolean", description: "box" },
  { key: "shutter_count", type: "number", description: "long number — too wide for a title" },
];

const baseItem: FormatListingItem = {
  title: "Nike Air Max 90",
  description: "Worn twice, small sole scuff.",
  category: "sneakers",
  condition: "good",
  brand: "Nike",
  price_cents: 4500,
  currency: "EUR",
  shipping_tier: "parcel",
  shipping_price_cents: 700,
  attributes: { size_eu: 43, colorway: "white/grey", has_original_box: true, shutter_count: 12000 },
};

const baseComparables = { count: 5, min_cents: 4000, max_cents: 6000, currency: "EUR" };

describe("title-limit constants", () => {
  it("pins the design-time platform limits (verified against live docs at PR time)", () => {
    expect(PLATFORM_TITLE_LIMITS).toEqual({ ebay: 80, subito: 60, vinted: 60, wallapop: 50 });
  });
});

describe("template lint — all platforms × languages", () => {
  for (const platform of PLATFORMS) {
    for (const language of LANGUAGES) {
      it(`${platform}/${language}: title within limit, deterministic, envelope versioned`, () => {
        const a = formatListing({ item: baseItem, platform, language, definitions: defs, comparables: baseComparables });
        const b = formatListing({ item: baseItem, platform, language, definitions: defs, comparables: baseComparables });

        // Byte-identical double render (deterministic template assembly).
        expect(a.title).toBe(b.title);
        expect(a.description).toBe(b.description);
        expect(a.json).toEqual(b.json);

        // Title formula applied the condition bucket and stayed in budget.
        expect(a.title.length).toBeLessThanOrEqual(PLATFORM_TITLE_LIMITS[platform]);
        expect(a.title).toMatch(/ – (buono|good)$/);
        expect(a.title).not.toBe("");

        // json envelope: versioned, platform-tagged, language-tagged.
        expect(a.json.version).toBe(1);
        expect(a.json.platform).toBe(platform);
        expect(a.json.language).toBe(language);
      });

      it(`${platform}/${language}: description blocks in spec order`, () => {
        const r = formatListing({ item: baseItem, platform, language, definitions: defs, comparables: baseComparables });
        const lines = r.description.split("\n");
        const identity = lines.findIndex((l) => l === "Nike Air Max 90 43");
        const condition = lines.findIndex((l) => l.startsWith(language === "it" ? "Condizione: buono" : "Condition: good"));
        const flaws = lines.findIndex((l) => l === baseItem.description);
        const attr = lines.findIndex((l) => l.startsWith("shutter_count:"));
        const price = lines.findIndex((l) => l.startsWith(language === "it" ? "Prezzo: " : "Price: "));
        const market = lines.findIndex((l) => l.startsWith(language === "it" ? "Fascia di mercato: " : "Market range: "));

        expect(identity).toBe(0);
        expect(condition).toBe(1);
        expect(flaws).toBe(2);
        // Declared-but-unmapped attribute lines after the free-text flaws.
        expect(attr).toBeGreaterThan(flaws);
        expect(price).toBeGreaterThan(attr);
        expect(market).toBe(price + 1);
        // The FMV rationale names its basis (asking prices of live comparables).
        expect(lines[market]).toMatch(/5/);
      });

      it(`${platform}/${language}: platform field labels match the platform's own naming`, () => {
        const r = formatListing({ item: baseItem, platform, language, definitions: defs, comparables: baseComparables });
        const keys = Object.keys(r.fields);
        if (platform === "vinted") {
          // Vinted names the condition field "status".
          expect(keys).toEqual(expect.arrayContaining(["title", "brand", "size", "status", "price"]));
          expect(keys).not.toContain("condition");
          expect(r.fields["status"]).toMatch(/buono|good/);
        } else if (platform === "ebay") {
          // Item Specifics use Title-case names; the condition stays "Condition".
          expect(keys).toEqual(expect.arrayContaining(["Title", "Brand", "Condition", "Size"]));
          expect(r.fields["Condition"]).toMatch(/buono|good/);
          expect(r.json.listing.ItemSpecifics).toEqual(
            expect.arrayContaining([expect.objectContaining({ Name: "Brand", Value: "Nike" })]),
          );
        } else if (platform === "subito") {
          expect(keys).toEqual(expect.arrayContaining(["titolo", "prezzo", "condizione", "marca"]));
        } else {
          expect(keys).toEqual(expect.arrayContaining(["titulo", "precio", "estado", "marca"]));
        }
      });

      it(`${platform}/${language}: json envelope carries title, description, price money and shipping`, () => {
        const r = formatListing({ item: baseItem, platform, language, definitions: defs, comparables: baseComparables });
        const listing = r.json.listing as Record<string, unknown>;
        expect(listing.title ?? listing.Title ?? listing.titolo ?? listing.titulo).toBe(r.title);
        const price = (listing.price ?? listing.StartPrice ?? listing.prezzo ?? listing.precio) as { amount: number; currency: string };
        expect(price).toEqual({ amount: 45, currency: "EUR" });
        expect(Object.values(listing).join("\n")).toContain(baseItem.description);
      });
    }
  }
});

describe("warnings", () => {
  it("flags title truncation when the formula exceeds the platform limit", () => {
    const long: FormatListingItem = {
      ...baseItem,
      brand: "International Watch Company Schaffhausen",
      title: "Portugieser Automatic Chronograph Edition Stainless Steel",
      attributes: {},
    };
    const r = formatListing({ item: long, platform: "wallapop", language: "en", definitions: [] });
    expect(r.title.length).toBeLessThanOrEqual(50);
    expect(r.warnings.some((w) => w.startsWith("title_truncated"))).toBe(true);
    // Short items produce no truncation warning.
    const short = formatListing({ item: baseItem, platform: "wallapop", language: "en", definitions: [] });
    expect(short.warnings.some((w) => w.startsWith("title_truncated"))).toBe(false);
  });

  it("flags missing comparables once and omits the market-range line", () => {
    const r = formatListing({ item: baseItem, platform: "ebay", language: "en", definitions: defs });
    expect(r.warnings).toContain("no_comparables: no comparable active listings found — market-range line omitted");
    expect(r.description).not.toContain("Market range");
    // count > 0 with null bounds (degenerate FMV) also omits the line.
    const degenerate = formatListing({
      item: baseItem,
      platform: "ebay",
      language: "en",
      definitions: defs,
      comparables: { count: 2, min_cents: null, max_cents: null, currency: "EUR" },
    });
    expect(degenerate.description).not.toContain("Market range");
  });

  it("contact info in source fields passes through unchanged, named in a warning (no silent scrub)", () => {
    const r = formatListing({
      item: { ...baseItem, description: "Call me at 333 1234567 for more photos." },
      platform: "subito",
      language: "it",
      definitions: defs,
      comparables: baseComparables,
    });
    expect(r.description).toContain("333 1234567"); // export never rewrites seller content
    expect(r.warnings.some((w) => w.startsWith("contact_info_detected"))).toBe(true);
  });
});

describe("seller identity never enters the template surface", () => {
  it("output is composed only of template labels and allowlisted item fields", () => {
    const r = formatListing({ item: baseItem, platform: "ebay", language: "en", definitions: defs, comparables: baseComparables });
    const rendered = [r.title, r.description, ...Object.values(r.fields), JSON.stringify(r.json)].join("\n");
    // Structural guarantee: FormatListingItem carries no seller column, so
    // planted identity markers can only appear if the templates leak them.
    expect(rendered).not.toMatch(/seller|email|@thingery|display_name/i);
    // And every description line is either a known label or item content.
    for (const line of r.description.split("\n")) {
      const known =
        line === "Nike Air Max 90 43" ||
        line.startsWith("Condition:") ||
        line.startsWith("Prezzo:") ||
        line.startsWith("Price:") ||
        line.startsWith("Shipping") ||
        line.startsWith("Spedizione") ||
        line.startsWith("Market range:") ||
        line.startsWith("Fascia di mercato:") ||
        line === baseItem.description ||
        /^[a-z_]+: /.test(line);
      expect(known, `unexpected line: ${line}`).toBe(true);
    }
  });
});

describe("shipping tiers", () => {
  it("local pickup renders without a price; zero-priced parcel reads as included", () => {
    const pickup = formatListing({ item: { ...baseItem, shipping_tier: "local" }, platform: "subito", language: "it", definitions: defs, comparables: baseComparables });
    expect(pickup.description).toContain("Ritiro a mano");
    const included = formatListing({ item: { ...baseItem, shipping_price_cents: 0 }, platform: "subito", language: "it", definitions: defs, comparables: baseComparables });
    expect(included.description).toContain("spedizione inclusa");
  });

  it("an unknown shipping tier omits the shipping block instead of guessing", () => {
    const r = formatListing({ item: { ...baseItem, shipping_tier: "mystery" }, platform: "subito", language: "it", definitions: defs, comparables: baseComparables });
    expect(r.description).not.toContain("Spedizione");
  });
});

describe("language handling", () => {
  it("defaults to it when language is omitted", () => {
    const r = formatListing({ item: baseItem, platform: "subito", definitions: defs, comparables: baseComparables });
    expect(r.json.language).toBe("it");
    expect(r.description).toContain("Condizione: buono");
  });

  it("en renders the english labels", () => {
    const r = formatListing({ item: baseItem, platform: "subito", language: "en", definitions: defs, comparables: baseComparables });
    expect(r.description).toContain("Condition: good");
  });
});

describe("title identity fallback", () => {
  it("strips a duplicated leading brand from the item title", () => {
    const r = formatListing({
      item: { ...baseItem, title: "Nike Air Max 90", brand: "Nike", attributes: {}, condition: "good" },
      platform: "ebay",
      language: "en",
      definitions: [],
    });
    // No "Nike Nike" duplication; condition bucket still appended.
    expect(r.title).not.toContain("Nike Nike");
    expect(r.title.startsWith("Nike Air Max 90")).toBe(true);
  });

  it("picks the first declared short attribute for the title key attr", () => {
    const r = formatListing({ item: baseItem, platform: "ebay", language: "en", definitions: defs, comparables: baseComparables });
    // size_eu (43) is declared before shutter_count (12000 — too wide).
    expect(r.title).toContain("43");
  });
});

describe("clampTitleToLimit", () => {
  it("passes short titles through unchanged", () => {
    expect(clampTitleToLimit("short title", 60)).toEqual({ title: "short title", clamped: false });
  });

  it("cuts at a word boundary deterministically and flags it", () => {
    const { title, clamped } = clampTitleToLimit("one two three four five six seven eight nine ten", 30);
    expect(clamped).toBe(true);
    expect(title.length).toBeLessThanOrEqual(30);
    expect(clampTitleToLimit("one two three four five six seven eight nine ten", 30).title).toBe(title);
  });
});
