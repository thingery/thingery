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

  it("renders og:image:alt alongside og:image (THI-396)", () => {
    const html = ogMetaHtml({
      image: "https://thingery.dev/img/items/abc.jpg",
      imageAlt: "Sony A6400 body + kit lens",
    });
    expect(html).toContain('<meta property="og:image:alt" content="Sony A6400 body + kit lens">');
  });

  it("renders a canonical link when set, and none otherwise (THI-396)", () => {
    const html = ogMetaHtml({
      title: "Sony A6400",
      url: "https://thingery.dev/item/abc-123",
      canonical: "https://thingery.dev/item/abc-123",
    });
    expect(html).toContain('<link rel="canonical" href="https://thingery.dev/item/abc-123">');
    expect(ogMetaHtml({ title: "just a title" })).not.toContain("canonical");
  });

  it("HTML-escapes canonical href like any attribute", () => {
    const html = ogMetaHtml({ canonical: 'https://x.test/a"onload="alert(1)' });
    expect(html).toContain('<link rel="canonical" href="https://x.test/a&quot;onload=&quot;alert(1)">');
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
