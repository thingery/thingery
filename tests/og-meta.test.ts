import { describe, expect, it } from "vitest";
import { ogMetaHtml } from "../src/web-pages.js";

describe("ogMetaHtml", () => {
  it("renders og tags with property= and twitter:card with name=", () => {
    const html = ogMetaHtml({
      title: "Sony A6400 body + 16-50mm kit lens",
      description: "520.00 EUR — used, good",
      siteName: "Thingery",
      url: "https://thingery.dev/item/abc-123",
      image: "https://thingery.dev/img/items/abc.jpg",
      twitterCard: "summary_large_image",
    });
    expect(html).toContain(
      '<meta property="og:title" content="Sony A6400 body + 16-50mm kit lens">',
    );
    expect(html).toContain('<meta property="og:description" content="520.00 EUR — used, good">');
    expect(html).toContain('<meta property="og:site_name" content="Thingery">');
    expect(html).toContain('<meta property="og:url" content="https://thingery.dev/item/abc-123">');
    expect(html).toContain('<meta property="og:image" content="https://thingery.dev/img/items/abc.jpg">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it("omits absent fields (e.g. no-image item has no og:image)", () => {
    const html = ogMetaHtml({
      title: "Fjällräven Kånken backpack",
      description: "40.00 EUR — used, good",
      siteName: "Thingery",
      url: "https://thingery.dev/item/def-456",
      twitterCard: "summary",
    });
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).not.toContain("og:image");
  });

  it("HTML-escapes tag values", () => {
    const html = ogMetaHtml({ title: '<script>"&\'', twitterCard: "summary" });
    expect(html).toContain('<meta property="og:title" content="&lt;script&gt;&quot;&amp;&#39;">');
  });

  it("returns empty string when nothing is set", () => {
    expect(ogMetaHtml(undefined)).toBe("");
    expect(ogMetaHtml({})).toBe("");
  });
});
