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
    "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "64:ff9b::a00:1",
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
});
