import { describe, expect, it } from "vitest";
import {
  BROWSE_PAGE_SIZE,
  MAX_BROWSE_PAGE,
  browsePageNav,
  browsePageUrl,
  parsePageParam,
} from "../src/pagination.js";

describe("parsePageParam", () => {
  it("defaults to page 1 for missing or malformed input", () => {
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam(null)).toBe(1);
    expect(parsePageParam(["2", "3"])).toBe(1); // duplicate ?page= entries (array from express)
    expect(parsePageParam("")).toBe(1);
    expect(parsePageParam("   ")).toBe(1);
    expect(parsePageParam("abc")).toBe(1);
    expect(parsePageParam("2.5")).toBe(1);
    expect(parsePageParam("1e3")).toBe(1);
    expect(parsePageParam("+2")).toBe(1);
  });

  it("falls back to page 1 for zero and negative values", () => {
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("-1")).toBe(1);
    expect(parsePageParam("-999")).toBe(1);
    expect(parsePageParam("007")).toBe(1); // leading zero is not a canonical page number
  });

  it("accepts valid 1-based pages", () => {
    expect(parsePageParam("1")).toBe(1);
    expect(parsePageParam("2")).toBe(2);
    expect(parsePageParam(" 42 ")).toBe(42);
    expect(parsePageParam(String(MAX_BROWSE_PAGE))).toBe(MAX_BROWSE_PAGE);
  });

  it("clamps huge values to the maximum page", () => {
    expect(parsePageParam(String(MAX_BROWSE_PAGE + 1))).toBe(MAX_BROWSE_PAGE);
    expect(parsePageParam("999999999999999999999")).toBe(1); // not a safe integer
    expect(parsePageParam("999999999")).toBe(MAX_BROWSE_PAGE);
  });
});

describe("browsePageUrl", () => {
  it("omits the page param on page 1 (canonical /browse)", () => {
    expect(browsePageUrl(1)).toBe("/browse");
    expect(browsePageUrl(1, "camera")).toBe("/browse?q=camera");
  });

  it("preserves the current search query across pages", () => {
    expect(browsePageUrl(2, "camera")).toBe("/browse?q=camera&page=2");
    expect(browsePageUrl(3)).toBe("/browse?page=3");
  });

  it("URL-encodes special characters in the query", () => {
    expect(browsePageUrl(2, "nikon d750")).toBe("/browse?q=nikon+d750&page=2");
    expect(browsePageUrl(2, 'a"b&c')).toBe("/browse?q=a%22b%26c&page=2");
  });

  it("drops a whitespace-only query", () => {
    expect(browsePageUrl(2, "   ")).toBe("/browse?page=2");
  });
});

describe("browsePageNav", () => {
  it("shows next only when a full page came back", () => {
    expect(browsePageNav(1, BROWSE_PAGE_SIZE)).toEqual({ hasPrev: false, hasNext: true });
    expect(browsePageNav(1, BROWSE_PAGE_SIZE - 1)).toEqual({ hasPrev: false, hasNext: false });
    expect(browsePageNav(2, 5)).toEqual({ hasPrev: true, hasNext: false });
  });

  it("shows prev only past page 1", () => {
    expect(browsePageNav(1, 0)).toEqual({ hasPrev: false, hasNext: false });
    expect(browsePageNav(2, BROWSE_PAGE_SIZE)).toEqual({ hasPrev: true, hasNext: true });
    expect(browsePageNav(MAX_BROWSE_PAGE, 1)).toEqual({ hasPrev: true, hasNext: false });
  });
});
