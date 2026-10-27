// THI-396: unit tests for the visit-origin `page_view` analytics lines
// (src/analytics.ts). Covers classifyVisitOrigin's origin classification
// (direct / internal / external incl. PUBLIC_BASE_URL + port-stripped Host),
// the privacy contract (referrer HOST only, clamped-charset utm values, no
// raw junk) and logPageView's bounded line shape. No DB needed — the
// classifier is pure over headers/query. Same capture-test pattern as
// tests/tool-result-events.test.ts.

import { describe, expect, it, vi, afterEach } from "vitest";
import { classifyVisitOrigin, logPageView } from "../src/analytics.js";
import type { Request } from "express";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PUBLIC_BASE_URL;
});

const req = (headers: Record<string, string>, query: Record<string, unknown> = {}): Request =>
  ({ headers, query }) as unknown as Request;

const HUMAN_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";

describe("classifyVisitOrigin (direct / internal / external)", () => {
  it("no referrer, no utm → direct", () => {
    expect(classifyVisitOrigin(req({ host: "thingery.dev", "user-agent": HUMAN_UA }))).toEqual({
      origin: "direct",
      refHost: null,
      utm: null,
      bot: false,
    });
  });

  it("referrer on the request host (port-stripped, case-insensitive) → internal, no host logged", () => {
    const info = classifyVisitOrigin(
      req({ host: "Thingery.dev:443", referer: "https://thingery.dev/browse?page=2", "user-agent": HUMAN_UA }),
    );
    expect(info.origin).toBe("internal");
    expect(info.refHost).toBeNull(); // internal navigation is not attribution signal
  });

  it("referrer on the PUBLIC_BASE_URL host → internal (self-hosted deployments)", () => {
    process.env.PUBLIC_BASE_URL = "https://market.example.org/";
    const info = classifyVisitOrigin(
      req({ host: "localhost:3000", referer: "https://market.example.org/", "user-agent": HUMAN_UA }),
    );
    expect(info.origin).toBe("internal");
  });

  it("referrer on another host → external with the HOST ONLY (never path/query)", () => {
    const info = classifyVisitOrigin(
      req({
        host: "thingery.dev",
        referer: "https://x.com/someone/status/12345?ref_src=tw",
        "user-agent": HUMAN_UA,
      }),
    );
    expect(info.origin).toBe("external");
    expect(info.refHost).toBe("x.com");
  });

  it("unparseable referer → treated as absent (direct), not guessed", () => {
    const info = classifyVisitOrigin(req({ host: "thingery.dev", referer: "not a url", "user-agent": HUMAN_UA }));
    expect(info.origin).toBe("direct");
    expect(info.refHost).toBeNull();
  });
});

describe("classifyVisitOrigin (utm sanitization)", () => {
  it("keeps valid utm values and drops invalid ones individually", () => {
    const info = classifyVisitOrigin(
      req(
        { host: "thingery.dev", "user-agent": HUMAN_UA },
        {
          utm_source: "whatsapp",
          utm_medium: "chat share", // space is in the allowed charset after char 1
          utm_campaign: "<script>alert(1)</script>", // never logged
          utm_term: "",
        },
      ),
    );
    expect(info.utm).toEqual({ source: "whatsapp", medium: "chat share" });
  });

  it("array-valued params (repeated ?utm_source=) are dropped entirely", () => {
    const info = classifyVisitOrigin(
      req({ host: "thingery.dev", "user-agent": HUMAN_UA }, { utm_source: ["a", "b"] }),
    );
    expect(info.utm).toBeNull();
  });

  it("values longer than 64 chars are dropped, not truncated", () => {
    const info = classifyVisitOrigin(
      req({ host: "thingery.dev", "user-agent": HUMAN_UA }, { utm_source: "a".repeat(65) }),
    );
    expect(info.utm).toBeNull();
  });
});

describe("classifyVisitOrigin (unfurler classification)", () => {
  it("card unfurlers and crawlers → bot:true", () => {
    for (const ua of [
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Twitterbot/1.0",
      "LinkedInBot/1.0",
      "Mozilla/5.0 (compatible; Googlebot/2.1)",
      "Pingdom.com_bot",
    ]) {
      expect(classifyVisitOrigin(req({ host: "thingery.dev", "user-agent": ua })).bot).toBe(true);
    }
  });

  it("in-app browsers that carry the app name stay human (WhatsApp shares are real visits)", () => {
    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 WhatsApp/2.24.5.19";
    expect(classifyVisitOrigin(req({ host: "thingery.dev", "user-agent": ua })).bot).toBe(false);
  });
});

describe("logPageView (bounded line shape)", () => {
  it("emits one page_view line; refHost/utm only when present", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logPageView({ itemId: "a1b2c3d4-0000-0000-0000-000000000000", owner: false, origin: "external", refHost: "x.com", utm: { source: "x" }, bot: false });
    logPageView({ itemId: "a1b2c3d4-0000-0000-0000-000000000000", owner: true, origin: "direct", refHost: null, utm: null, bot: false });
    const [external, owner] = log.mock.calls.map((c) => JSON.parse(c[0]));
    expect(external).toEqual({
      ts: expect.any(String),
      type: "page_view",
      page: "item",
      itemId: "a1b2c3d4-0000-0000-0000-000000000000",
      owner: false,
      origin: "external",
      bot: false,
      refHost: "x.com",
      utm: { source: "x" },
    });
    expect(owner).toEqual({
      ts: expect.any(String),
      type: "page_view",
      page: "item",
      itemId: "a1b2c3d4-0000-0000-0000-000000000000",
      owner: true,
      origin: "direct",
      bot: false,
    });
  });

  it("never throws, whatever the input (analytics is best-effort)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      logPageView({ itemId: "x", owner: false, origin: "direct", refHost: null, utm: circular as never, bot: false }),
    ).not.toThrow();
  });
});
