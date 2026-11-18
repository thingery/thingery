// ISO 3166-1 alpha-2 country checks (spec docs/specs/saved-addresses.md,
// rollout step 1): the officially assigned list is what saved addresses
// and create_order's typed address validate against.

import { describe, expect, it } from "vitest";
import { ISO_COUNTRY_CODES, isIsoCountryCode, normalizeCountryCode, CountryCodeError } from "../src/countries.js";

describe("ISO_COUNTRY_CODES", () => {
  it("holds the 249 officially assigned alpha-2 codes", () => {
    expect(ISO_COUNTRY_CODES.size).toBe(249);
  });

  it("contains only unique two-letter uppercase codes", () => {
    for (const code of ISO_COUNTRY_CODES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("contains the common codes and excludes the unassigned and reserved", () => {
    for (const code of ["IT", "US", "DE", "GB", "FR", "NL", "ES", "CH", "CA", "JP", "AU", "BR"]) {
      expect(isIsoCountryCode(code)).toBe(true);
    }
    // Unassigned, or shape-only values the old check let through.
    for (const code of ["XX", "QQ", "ZZ", "AA"]) {
      expect(isIsoCountryCode(code)).toBe(false);
    }
    // Exceptionally reserved / popular non-official codes are NOT accepted.
    expect(isIsoCountryCode("UK")).toBe(false);
    expect(isIsoCountryCode("EU")).toBe(false);
  });
});

describe("normalizeCountryCode", () => {
  it("uppercases and trims a valid code", () => {
    expect(normalizeCountryCode(" it ")).toBe("IT");
  });

  it("rejects a non-ISO two-letter code with CountryCodeError", () => {
    expect(() => normalizeCountryCode("XX")).toThrow(CountryCodeError);
    expect(() => normalizeCountryCode("XX")).toThrow(/ISO 3166-1 alpha-2/);
  });

  it("rejects wrong shapes (1 letter, 3 letters, digits)", () => {
    expect(() => normalizeCountryCode("I")).toThrow(CountryCodeError);
    expect(() => normalizeCountryCode("ITA")).toThrow(CountryCodeError);
    expect(() => normalizeCountryCode("42")).toThrow(CountryCodeError);
    expect(() => normalizeCountryCode("")).toThrow(CountryCodeError);
  });

  it("names the constraint without echoing the submitted value", () => {
    try {
      normalizeCountryCode("home");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CountryCodeError);
      expect((e as Error).message).not.toContain("home");
    }
  });
});
