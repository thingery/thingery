// Unit tests for OAuth discovery metadata + DCR validation (spec THI-11 §2.3–2.4).

import { afterEach, describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  issuerFromRequest,
  newClientId,
  normalizeRedirectUri,
  validateClientRegistration,
} from "../src/oauth.js";

function fakeRequest(protocol: string, host: string): Request {
  return { protocol, get: (h: string) => (h.toLowerCase() === "host" ? host : undefined) } as unknown as Request;
}

const ORIGINAL_BASE_URL = process.env.PUBLIC_BASE_URL;

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.PUBLIC_BASE_URL;
  else process.env.PUBLIC_BASE_URL = ORIGINAL_BASE_URL;
});

describe("issuer derivation", () => {
  it("uses PUBLIC_BASE_URL when set (trailing slash stripped)", () => {
    process.env.PUBLIC_BASE_URL = "https://thingery.dev/";
    expect(issuerFromRequest(fakeRequest("http", "localhost:3000"))).toBe("https://thingery.dev");
  });

  it("derives from the request origin when unset (self-hosters, zero config)", () => {
    delete process.env.PUBLIC_BASE_URL;
    expect(issuerFromRequest(fakeRequest("https", "thingery.dev"))).toBe("https://thingery.dev");
    expect(issuerFromRequest(fakeRequest("http", "localhost:3000"))).toBe("http://localhost:3000");
  });
});

describe("redirect URI validation at registration (spec §2.4)", () => {
  it("accepts https and loopback http, returns normalized hrefs", () => {
    expect(normalizeRedirectUri("https://claude.ai/callback")).toBe("https://claude.ai/callback");
    expect(normalizeRedirectUri("http://localhost:6274/oauth/callback")).toBe("http://localhost:6274/oauth/callback");
    expect(normalizeRedirectUri("http://127.0.0.1:6274/cb")).toBe("http://127.0.0.1:6274/cb");
    expect(normalizeRedirectUri("http://[::1]:6274/cb")).toBe("http://[::1]:6274/cb");
    // WHATWG canonicalization passes (RFC 8252 §7.3 vectors):
    expect(normalizeRedirectUri("http://0177.0.0.1:6274/cb")).toBe("http://127.0.0.1:6274/cb");
    expect(normalizeRedirectUri("http://[0:0:0:0:0:0:0:1]:6274/cb")).toBe("http://[::1]:6274/cb");
    expect(normalizeRedirectUri("http://LOCALHOST:6274/cb")).toBe("http://localhost:6274/cb");
  });

  it("rejects non-https, non-loopback, and malformed URIs", () => {
    expect(normalizeRedirectUri("http://example.com/cb")).toBeNull();
    expect(normalizeRedirectUri("ftp://example.com/cb")).toBeNull();
    expect(normalizeRedirectUri("myapp://callback")).toBeNull();
    expect(normalizeRedirectUri("not a url")).toBeNull();
    expect(normalizeRedirectUri("")).toBeNull();
    // Trailing-dot localhost must NOT be treated as loopback (F3 vector):
    expect(normalizeRedirectUri("http://localhost.:6274/cb")).toBeNull();
    // Userinfo is never acceptable in a redirect URI (RFC 6749 §3.1.2):
    expect(normalizeRedirectUri("https://user:pass@example.com/cb")).toBeNull();
    expect(normalizeRedirectUri("https://example.com/cb#frag")).toBeNull();
    expect(normalizeRedirectUri(`https://example.com/${"a".repeat(2100)}`)).toBeNull();
  });
});

describe("client registration payload validation", () => {
  it("accepts a minimal payload with only redirect_uris", () => {
    const reg = validateClientRegistration({ redirect_uris: ["https://host/cb"] });
    expect(reg).toEqual({ redirect_uris: ["https://host/cb"], client_name: null, client_uri: null });
  });

  it("normalizes stored URIs and keeps name/uri as data", () => {
    const reg = validateClientRegistration({
      redirect_uris: ["http://LOCALHOST:6274/cb"],
      client_name: "Desktop Sync", // THI-220: fixtures must not use reserved brand names
      client_uri: "https://claude.ai",
      unknown_field: "ignored (forward-compatible)",
    });
    expect(reg.redirect_uris).toEqual(["http://localhost:6274/cb"]);
    expect(reg.client_name).toBe("Desktop Sync");
    expect(reg.client_uri).toBe("https://claude.ai");
  });

  it("rejects the error matrix with invalid_redirect_uri / invalid_client_metadata", () => {
    const cases: [unknown, string][] = [
      [{}, "invalid_redirect_uri"],
      [{ redirect_uris: [] }, "invalid_redirect_uri"],
      [{ redirect_uris: Array.from({ length: 11 }, () => "https://h/cb") }, "invalid_redirect_uri"],
      [{ redirect_uris: "https://host/cb" }, "invalid_redirect_uri"],
      [{ redirect_uris: ["myapp://cb"] }, "invalid_redirect_uri"],
      [{ redirect_uris: ["https://h/cb"], client_name: "x".repeat(201) }, "invalid_client_metadata"],
      [{ redirect_uris: ["https://h/cb"], client_name: 42 }, "invalid_client_metadata"],
      [{ redirect_uris: ["https://h/cb"], client_uri: "x".repeat(2049) }, "invalid_client_metadata"],
      ["not an object", "invalid_client_metadata"],
    ];
    for (const [body, code] of cases) {
      try {
        validateClientRegistration(body);
        expect.unreachable(`expected ${code} for ${JSON.stringify(body)}`);
      } catch (e) {
        expect((e as { code: string }).code).toBe(code);
        expect((e as { status: number }).status).toBe(400);
      }
    }
  });
});

describe("client id format", () => {
  it("is thgc_ + 22 base64url chars and unique", () => {
    const a = newClientId();
    expect(a).toMatch(/^thgc_[A-Za-z0-9_-]{22}$/);
    expect(newClientId()).not.toBe(a);
  });
});
