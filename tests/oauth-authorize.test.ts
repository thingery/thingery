// Unit tests for the authorization-endpoint primitives: the normative
// redirect-URI matcher (F3) and the consent CSRF contract (F8).

import { describe, expect, it } from "vitest";
import { consentCsrfToken, redirectUriMatches } from "../src/oauth.js";
import { signSession } from "../src/auth.js";

describe("redirectUriMatches (F3: normative matcher)", () => {
  const registered = "http://localhost:51717/callback";

  it("matches exact registered URI and loopback port variations", () => {
    expect(redirectUriMatches(registered, registered)).toBe(true);
    // RFC 8252 §7.3: loopback hosts bind random ports — port may differ.
    expect(redirectUriMatches("http://localhost:49152/callback", registered)).toBe(true);
    expect(redirectUriMatches("http://localhost:65535/callback", registered)).toBe(true);
  });

  it("rejects hostname changes even on loopback", () => {
    expect(redirectUriMatches("http://127.0.0.1:51717/callback", registered)).toBe(false);
    expect(redirectUriMatches("http://127.0.0.1:49152/callback", registered)).toBe(false);
    expect(redirectUriMatches("http://[::1]:51717/callback", registered)).toBe(false);
  });

  it("rejects path and scheme changes", () => {
    expect(redirectUriMatches("http://localhost:51717/callback/", registered)).toBe(false);
    expect(redirectUriMatches("http://localhost:51717/", registered)).toBe(false);
    expect(redirectUriMatches("http://localhost:51717/callback/x", registered)).toBe(false);
    expect(redirectUriMatches("https://localhost:51717/callback", registered)).toBe(false);
  });

  it("rejects suffix/substring/host tricks", () => {
    expect(redirectUriMatches("http://localhost:51717.callback.evil.com/x", registered)).toBe(false);
    expect(redirectUriMatches("http://xlocalhost:51717/callback", registered)).toBe(false);
    expect(redirectUriMatches("http://localhost.evil.com:51717/callback", registered)).toBe(false);
    expect(redirectUriMatches("http://evil.com/#http://localhost:51717/callback", registered)).toBe(false);
  });

  it("ignores ports ONLY for loopback: non-loopback ports must match exactly (default ports normalize away)", () => {
    const prod = "https://app.example.com/cb";
    // WHATWG URLs drop explicit default ports, so :443 ≡ empty for https:
    expect(redirectUriMatches("https://app.example.com:443/cb", prod)).toBe(true);
    expect(redirectUriMatches("https://app.example.com/cb", prod)).toBe(true);
    expect(redirectUriMatches("https://app.example.com:8443/cb", prod)).toBe(false);
    expect(redirectUriMatches("https://app.example.com:444/cb", prod)).toBe(false);
  });

  it("rejects unparseable inputs", () => {
    expect(redirectUriMatches("not a url", registered)).toBe(false);
    expect(redirectUriMatches(registered, "::::")).toBe(false);
    expect(redirectUriMatches("", registered)).toBe(false);
  });
});

describe("consentCsrfToken (F8: HMAC over the authorization request)", () => {
  const base = {
    sellerId: "11111111-1111-1111-1111-111111111111",
    clientId: "thgc_test",
    redirectUri: "http://localhost:51717/callback",
    codeChallenge: "A".repeat(43),
    nonce: "nonce-one",
  };

  it("is deterministic for identical inputs and changes with every bound field", () => {
    const a = consentCsrfToken(base);
    const b = consentCsrfToken({ ...base });
    expect(a).toBe(b);
    expect(consentCsrfToken({ ...base, sellerId: "22222222-2222-2222-2222-222222222222" })).not.toBe(a);
    expect(consentCsrfToken({ ...base, clientId: "thgc_other" })).not.toBe(a);
    expect(consentCsrfToken({ ...base, redirectUri: "http://localhost:51718/callback" })).not.toBe(a);
    expect(consentCsrfToken({ ...base, codeChallenge: "B".repeat(43) })).not.toBe(a);
    expect(consentCsrfToken({ ...base, nonce: "nonce-two" })).not.toBe(a);
  });

  it("never collides with session-cookie MACs for the same secret (domain separation)", () => {
    // A consent CSRF token must not validate as a session MAC or vice versa:
    // the "csrf:"/"session:" prefixes make cross-use structurally impossible.
    const csrf = consentCsrfToken(base);
    const mac = signSession(base.sellerId);
    expect(csrf).not.toEqual(mac);
    expect(csrf.length).toBeGreaterThan(20);
  });
});
