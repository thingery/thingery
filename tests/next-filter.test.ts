// F2 regression tests: the login-page `next` filter must survive the
// backslash/percent-encoding family of open-redirect bypasses.

import { describe, expect, it } from "vitest";
import { MAX_NEXT_LEN, safeNextTarget } from "../website/next-filter.js";

const ORIGIN = "https://thingery.dev";

describe("safeNextTarget (F2: normalize-then-origin)", () => {
  it("accepts same-origin relative paths", () => {
    expect(safeNextTarget("/oauth/authorize?client_id=x", ORIGIN)).toBe("/oauth/authorize?client_id=x");
    expect(safeNextTarget("/browse", ORIGIN)).toBe("/browse");
  });

  it("rejects absolute URLs to other origins", () => {
    expect(safeNextTarget("https://evil.com/oauth", ORIGIN)).toBeNull();
    expect(safeNextTarget("http://thingery.dev/", ORIGIN)).toBeNull(); // scheme downgrade = different origin
    expect(safeNextTarget("https://thingery.dev.evil.com/", ORIGIN)).toBeNull();
  });

  it("rejects backslash bypasses: /\\evil.com and its encodings", () => {
    expect(safeNextTarget("/\\evil.com", ORIGIN)).toBeNull();
    expect(safeNextTarget("//evil.com", ORIGIN)).toBeNull();
    expect(safeNextTarget("/\\evil.com/x", ORIGIN)).toBeNull();
    // decoded form of "/%5C/evil.com" as URLSearchParams.get would deliver it:
    expect(safeNextTarget("/\\/evil.com", ORIGIN)).toBeNull();
  });

  it("accepts protocol-relative same-host strings (they resolve to the same origin)", () => {
    // URL("//thingery.dev/browse", origin) inherits the scheme — same origin, safe.
    expect(safeNextTarget("//thingery.dev/browse", ORIGIN)).toBe("//thingery.dev/browse");
    expect(safeNextTarget("//evil.com/browse", ORIGIN)).toBeNull();
  });

  it("rejects absent, empty, non-string, and oversized values", () => {
    expect(safeNextTarget(undefined, ORIGIN)).toBeNull();
    expect(safeNextTarget(null, ORIGIN)).toBeNull();
    expect(safeNextTarget("", ORIGIN)).toBeNull();
    expect(safeNextTarget("a".repeat(MAX_NEXT_LEN + 1), ORIGIN)).toBeNull();
    expect(safeNextTarget("a".repeat(MAX_NEXT_LEN), ORIGIN)).toBe("a".repeat(MAX_NEXT_LEN));
  });

  it("rejects javascript:/data: schemes", () => {
    expect(safeNextTarget("javascript:alert(1)", ORIGIN)).toBeNull();
    expect(safeNextTarget("data:text/html,hi", ORIGIN)).toBeNull();
  });
});
