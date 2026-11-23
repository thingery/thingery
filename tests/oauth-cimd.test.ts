// Unit tests for OAuth Client ID Metadata Documents (src/oauth-cimd.ts): the client_id URL
// rules, the public-address guard on every fetch, document checks, and the resolver's
// cache, sharing and rate limit. No network: lookups and fetches are stubbed.

import { describe, expect, it, vi } from "vitest";
import type dns from "node:dns";
import type { LookupFunction } from "node:net";
import {
  CimdError,
  createMetadataDocumentResolver,
  fetchMetadataDocument,
  isBlockedAddress,
  isTransientNetworkError,
  parseMetadataDocumentUrl,
  publicOnlyLookup,
  readMetadataDocument,
} from "../src/oauth-cimd.js";

const CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const DOCUMENT = {
  client_id: CLIENT_ID,
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  token_endpoint_auth_method: "none",
};

describe("parseMetadataDocumentUrl", () => {
  it("accepts an https URL with a path", () => {
    expect(parseMetadataDocumentUrl(CLIENT_ID)?.href).toBe(CLIENT_ID);
  });

  it.each([
    ["http", "http://claude.ai/oauth/metadata"],
    ["no path", "https://claude.ai/"],
    ["fragment", "https://claude.ai/oauth/metadata#x"],
    ["userinfo", "https://user:pass@claude.ai/oauth/metadata"],
    ["non-default port", "https://claude.ai:8443/oauth/metadata"],
    ["IPv4 literal", "https://10.0.0.1/oauth/metadata"],
    ["IPv6 literal", "https://[::1]/oauth/metadata"],
    ["dot segment", "https://claude.ai/oauth/../metadata"],
    ["not canonical", "https://Claude.ai/oauth/metadata"],
    ["not a URL", "https://"],
  ])("rejects %s", (_label, clientId) => {
    expect(parseMetadataDocumentUrl(clientId)).toBeNull();
  });
});

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "::8.8.8.8", "::a00:1", "64:ff9b::a00:1",
    "2002:a00:1::", "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["160.79.104.10", "8.8.8.8", "2607:6bc0::10"])("allows public %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

function resolverAnswering(addresses: dns.LookupAddress[]) {
  return (
    _hostname: string,
    _options: dns.LookupAllOptions,
    callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
  ) => callback(null, addresses);
}

function lookupResult(lookup: LookupFunction, all: boolean) {
  return new Promise<{ err: Error | null; result: unknown }>((resolve) => {
    lookup("claude.ai", { all }, (err, address, family) =>
      resolve({ err, result: all ? address : { address, family } }),
    );
  });
}

describe("publicOnlyLookup", () => {
  it("passes public addresses through", async () => {
    const lookup = publicOnlyLookup(resolverAnswering([{ address: "160.79.104.10", family: 4 }]));
    await expect(lookupResult(lookup, false)).resolves.toEqual({
      err: null,
      result: { address: "160.79.104.10", family: 4 },
    });
  });

  it("returns every address when the socket asks for all of them", async () => {
    const addresses = [
      { address: "160.79.104.10", family: 4 },
      { address: "2607:6bc0::10", family: 6 },
    ];
    const lookup = publicOnlyLookup(resolverAnswering(addresses));
    await expect(lookupResult(lookup, true)).resolves.toEqual({ err: null, result: addresses });
  });

  it("refuses when any resolved address is private", async () => {
    const lookup = publicOnlyLookup(
      resolverAnswering([
        { address: "160.79.104.10", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    );
    const { err } = await lookupResult(lookup, false);
    expect(err?.message).toMatch(/public address/);
  });

  it("stops the fetch before connecting to a private address", async () => {
    const lookup = publicOnlyLookup(resolverAnswering([{ address: "127.0.0.1", family: 4 }]));
    await expect(fetchMetadataDocument(new URL(CLIENT_ID), lookup)).rejects.toMatchObject({
      reason: "fetch_failed",
    });
  });
});

describe("readMetadataDocument", () => {
  const url = new URL(CLIENT_ID);

  it("keeps the host as the name, not the self-declared client_name", () => {
    expect(readMetadataDocument(DOCUMENT, url)).toEqual({
      client_id: CLIENT_ID,
      display_name: "claude.ai",
      redirect_uris: DOCUMENT.redirect_uris,
    });
  });

  it.each([
    ["a client_id for another URL", { ...DOCUMENT, client_id: "https://evil.example/oauth/metadata" }],
    ["a confidential client", { ...DOCUMENT, token_endpoint_auth_method: "client_secret_basic" }],
    ["a client_secret", { ...DOCUMENT, client_secret: "s3cret" }],
    ["an array", [DOCUMENT]],
    ["null", null],
  ])("rejects %s", (_label, document) => {
    expect(() => readMetadataDocument(document, url)).toThrow(CimdError);
  });
});

describe("createMetadataDocumentResolver", () => {
  it("caches a good document for an hour", async () => {
    let now = 0;
    const fetchDocument = vi.fn().mockResolvedValue(DOCUMENT);
    const resolve = createMetadataDocumentResolver(fetchDocument, () => now);

    await resolve(CLIENT_ID);
    now = 59 * 60 * 1000;
    await resolve(CLIENT_ID);
    expect(fetchDocument).toHaveBeenCalledTimes(1);

    now = 61 * 60 * 1000;
    await resolve(CLIENT_ID);
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("shares one fetch between concurrent requests", async () => {
    const fetchDocument = vi.fn().mockResolvedValue(DOCUMENT);
    const resolve = createMetadataDocumentResolver(fetchDocument);

    await Promise.all([resolve(CLIENT_ID), resolve(CLIENT_ID), resolve(CLIENT_ID)]);
    expect(fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("does not cache a bad document, and rate-limits refetching it", async () => {
    const fetchDocument = vi.fn().mockResolvedValue({ ...DOCUMENT, client_id: "https://other.example/x" });
    const resolve = createMetadataDocumentResolver(fetchDocument);

    for (let i = 0; i < 20; i++) {
      await expect(resolve(CLIENT_ID)).rejects.toMatchObject({ reason: "invalid_document" });
    }
    await expect(resolve(CLIENT_ID)).rejects.toMatchObject({ reason: "rate_limited" });
    expect(fetchDocument).toHaveBeenCalledTimes(20);
  });

  it("rejects an invalid client_id without fetching", async () => {
    const fetchDocument = vi.fn();
    const resolve = createMetadataDocumentResolver(fetchDocument);

    await expect(resolve("https://10.0.0.1/metadata")).rejects.toMatchObject({ reason: "invalid_url" });
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it("reports a cache hit with no attempts", async () => {
    let now = 0;
    const fetchDocument = vi.fn().mockResolvedValue(DOCUMENT);
    const resolve = createMetadataDocumentResolver(fetchDocument, () => now);

    await resolve(CLIENT_ID);
    const resolved = await resolve(CLIENT_ID);
    expect(resolved.source).toBe("cache");
    expect(resolved.attempts).toBe(0);
    expect(fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure once and reports a fresh resolve with 2 attempts", async () => {
    const fetchDocument = vi
      .fn()
      .mockRejectedValueOnce(new CimdError("fetch_failed", "timeout", true))
      .mockResolvedValueOnce(DOCUMENT);
    const resolve = createMetadataDocumentResolver(fetchDocument, () => 0, 0);

    const resolved = await resolve(CLIENT_ID);
    expect(fetchDocument).toHaveBeenCalledTimes(2);
    expect(resolved.source).toBe("fresh");
    expect(resolved.attempts).toBe(2);
    expect(resolved.client).toEqual({
      client_id: CLIENT_ID,
      display_name: "claude.ai",
      redirect_uris: DOCUMENT.redirect_uris,
    });
  });

  it("serves the retry's success from cache afterwards", async () => {
    const fetchDocument = vi
      .fn()
      .mockRejectedValueOnce(new CimdError("fetch_failed", "timeout", true))
      .mockResolvedValueOnce(DOCUMENT);
    const resolve = createMetadataDocumentResolver(fetchDocument, () => 0, 0);

    await resolve(CLIENT_ID);
    const resolved = await resolve(CLIENT_ID);
    expect(resolved.source).toBe("cache");
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("does not retry deterministic failures", async () => {
    const fetchDocument = vi.fn().mockRejectedValue(new CimdError("fetch_failed", "status 404", false));
    const resolve = createMetadataDocumentResolver(fetchDocument, () => 0, 0);

    const error = await resolve(CLIENT_ID).catch((e) => e as CimdError);
    expect(error.reason).toBe("fetch_failed");
    expect(error.attempts).toBe(1);
    expect(fetchDocument).toHaveBeenCalledTimes(1);
  });

  it("attaches attempts and elapsed time when every attempt fails", async () => {
    let tick = 0;
    const fetchDocument = vi.fn().mockRejectedValue(new CimdError("fetch_failed", "timeout", true));
    const resolve = createMetadataDocumentResolver(fetchDocument, () => (tick += 5), 0);

    const error = await resolve(CLIENT_ID).catch((e) => e as CimdError);
    expect(error.reason).toBe("fetch_failed");
    expect(error.attempts).toBe(2);
    expect(error.elapsedMs).toBeGreaterThan(0);
    expect(fetchDocument).toHaveBeenCalledTimes(2);
  });

  it("shares one load (and its retry) between concurrent requests", async () => {
    const fetchDocument = vi
      .fn()
      .mockRejectedValueOnce(new CimdError("fetch_failed", "getaddrinfo EAI_AGAIN claude.ai", true))
      .mockResolvedValueOnce(DOCUMENT);
    const resolve = createMetadataDocumentResolver(fetchDocument, () => 0, 0);

    const [a, b] = await Promise.all([resolve(CLIENT_ID), resolve(CLIENT_ID)]);
    expect(fetchDocument).toHaveBeenCalledTimes(2); // one load, one retry — not two loads
    expect(a.client).toEqual(b.client);
    expect(a.attempts).toBe(2);
  });

  it.each([
    ["timeout", new CimdError("fetch_failed", "timeout", true), 2],
    ["DNS EAI_AGAIN", new CimdError("fetch_failed", "getaddrinfo EAI_AGAIN claude.ai", true), 2],
    ["HTTP 503", new CimdError("fetch_failed", "status 503", true), 2],
    ["HTTP 404", new CimdError("fetch_failed", "status 404", false), 1],
    ["TLS identity", new CimdError("fetch_failed", "Hostname/IP does not match certificate's altnames", false), 1],
    ["size cap", new CimdError("fetch_failed", "document too large", false), 1],
    ["content-type", new CimdError("fetch_failed", "not JSON", false), 1],
    ["invalid document", new CimdError("invalid_document", "client_id in the document does not match its URL", false), 1],
  ])("classification: %s → %i fetch call(s)", async (_label, error, expectedCalls) => {
    const fetchDocument = vi.fn().mockRejectedValue(error);
    const resolve = createMetadataDocumentResolver(fetchDocument, () => 0, 0);

    await expect(resolve(CLIENT_ID)).rejects.toBe(error);
    expect(fetchDocument).toHaveBeenCalledTimes(expectedCalls);
  });

  it("burns one limiter token per resolve, not per attempt", async () => {
    const fetchDocument = vi.fn().mockRejectedValue(new CimdError("fetch_failed", "timeout", true));
    const resolve = createMetadataDocumentResolver(fetchDocument, () => 0, 0);

    for (let i = 0; i < 20; i++) {
      await expect(resolve(CLIENT_ID)).rejects.toMatchObject({ reason: "fetch_failed", attempts: 2 });
    }
    expect(fetchDocument).toHaveBeenCalledTimes(40); // 20 resolves × 2 GETs, still one token each
    await expect(resolve(CLIENT_ID)).rejects.toMatchObject({ reason: "rate_limited" });
    expect(fetchDocument).toHaveBeenCalledTimes(40); // no fetch behind the limiter
  });
});

describe("isTransientNetworkError", () => {
  it.each(["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "EPIPE"])(
    "treats %s as transient",
    (code) => {
      expect(isTransientNetworkError(Object.assign(new Error("x"), { code }))).toBe(true);
    },
  );

  it("treats getaddrinfo failures without a code as transient", () => {
    expect(isTransientNetworkError(new Error("getaddrinfo EAI_AGAIN claude.ai"))).toBe(true);
  });

  it.each([
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "EBLOCKED",
    "EACCES",
  ])("treats %s as not transient", (code) => {
    expect(isTransientNetworkError(Object.assign(new Error("x"), { code }))).toBe(false);
  });

  it("treats non-errors as not transient", () => {
    expect(isTransientNetworkError("timeout")).toBe(false);
  });
});
