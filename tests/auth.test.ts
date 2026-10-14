import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
  signSession,
  parseSession,
  SESSION_MAX_AGE_S,
} from "../src/auth.js";

describe("password hashing", () => {
  it("round-trips a correct password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery");
    expect(verifyPassword("correct horse battery", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("salts: two hashes of the same password differ", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed or missing hashes", () => {
    expect(verifyPassword("x", null)).toBe(false);
    expect(verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("session tokens (THI-115: server-side expiry + epoch)", () => {
  const DAY_MS = 24 * 3600 * 1000;

  it("signs and parses a seller id (round-trip at the default epoch)", () => {
    const token = signSession("11111111-2222-3333-4444-555555555555");
    expect(parseSession(token)).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("emits sellerId.iat.mac with iat pinned to the issue time", () => {
    const now = Date.now();
    const parts = signSession("seller-a", 0, now).split(".");
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe(String(Math.floor(now / 1000)));
  });

  it("rejects tokens older than 30 days (server-side expiry)", () => {
    expect(parseSession(signSession("seller-a", 0, Date.now() - (SESSION_MAX_AGE_S + 60) * 1000))).toBeNull();
    // Just inside the window still validates.
    expect(parseSession(signSession("seller-a", 0, Date.now() - 29 * DAY_MS))).toBe("seller-a");
  });

  it("rejects a tampered iat — the MAC covers it", () => {
    const [sellerId, , mac] = signSession("seller-a").split(".");
    // Same MAC, forged later issue time: not expired, so only the MAC can reject it.
    const forged = `${sellerId}.${Math.floor(Date.now() / 1000) + 3600}.${mac}`;
    expect(parseSession(forged)).toBeNull();
  });

  it("rejects tampered tokens", () => {
    const [sellerId, iat, mac] = signSession("seller-a").split(".");
    const forged = `seller-b.${iat}.${mac}`;
    expect(parseSession(forged)).toBeNull();
    expect(parseSession("nonsense")).toBeNull();
    expect(parseSession(undefined)).toBeNull();
  });

  it("rejects the pre-THI-115 two-part cookie format", () => {
    // All existing cookies look like this on deploy → logged out once.
    expect(parseSession(`seller-a.${"A".repeat(43)}`)).toBeNull();
  });

  it("rejects a non-numeric or negative iat", () => {
    const mac = "A".repeat(43);
    expect(parseSession(`seller-a.notanumber.${mac}`)).toBeNull();
    expect(parseSession(`seller-a.-5.${mac}`)).toBeNull();
    expect(parseSession(`seller-a..${mac}`)).toBeNull();
  });

  it("epoch bump invalidates old cookies; re-signing at the new epoch works", () => {
    expect(parseSession(signSession("seller-a", 0), 1)).toBeNull(); // bumped → revoked
    expect(parseSession(signSession("seller-a", 1), 1)).toBe("seller-a");
  });
});
