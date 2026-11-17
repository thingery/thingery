import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";
import { RateLimiter } from "./rate-limit.js";

// OAuth Client ID Metadata Documents (CIMD, draft-ietf-oauth-client-id-metadata-document):
// a client_id that is an https URL names a JSON document, hosted by the client, that
// describes it. MCP clients such as Claude use it instead of dynamic registration.
//
// Fetching a URL a stranger chose is the risk here, so every fetch is held to: https on
// the default port, a DNS name (never an IP literal), every resolved address public
// (checked inside the socket's own lookup, so a rebinding answer cannot slip past), no
// redirects, a short timeout and a small size cap.

const MAX_CLIENT_ID_URL_LEN = 2048;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_DOCUMENT_BYTES = 5 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
// Per URL, not per host: failed fetches of made-up paths on a real client's host must
// not use up that client's own budget. A good document is cached, so it is rarely refetched.
const FETCHES_PER_URL_PER_HOUR = 20;

export class CimdError extends Error {
  constructor(readonly reason: "invalid_url" | "fetch_failed" | "invalid_document" | "rate_limited", detail: string) {
    super(detail);
    this.name = "CimdError";
  }
}

/** True when a client_id is meant as a metadata document URL rather than a registered id. */
export function isMetadataDocumentClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

/**
 * The client_id as a fetchable URL, or null when it breaks the draft's rules (https, a path,
 * no fragment, userinfo or dot segments) or ours (a DNS name on the default port).
 */
export function parseMetadataDocumentUrl(clientId: string): URL | null {
  if (clientId.length > MAX_CLIENT_ID_URL_LEN) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return null;
  // The client_id must be the exact string the client publishes; a URL the parser had
  // to rewrite (dot segments, case, escapes) is not that string.
  if (url.href !== clientId || clientId.includes("#")) return null;
  if (url.pathname === "/" || /\/\.\.?(\/|$)/.test(url.pathname)) return null;
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) return null;
  return url;
}

// One list per family: BlockList matches an IPv4 address against IPv6 rules too, so the
// mapped-address rule below would otherwise block every IPv4 address.
const BLOCKED_IPV4 = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  BLOCKED_IPV4.addSubnet(prefix, bits, "ipv4");
}
// IPv6 forms that can carry an IPv4 address (mapped, NAT64, 6to4, Teredo) are blocked
// whole rather than decoded: no client needs them to publish a metadata document.
const BLOCKED_IPV6 = new net.BlockList();
for (const [prefix, bits] of [
  ["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  BLOCKED_IPV6.addSubnet(prefix, bits, "ipv6");
}

/** True for loopback, private, link-local, multicast, reserved and documentation addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  return family === 4 ? BLOCKED_IPV4.check(address, "ipv4") : BLOCKED_IPV6.check(address, "ipv6");
}

type Resolve = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/**
 * A socket lookup that refuses the connection when any resolved address is blocked.
 * The socket connects to what this returns, so the check and the connection see the
 * same answer.
 */
export function publicOnlyLookup(resolve: Resolve = dns.lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { family: options.family, hints: options.hints, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
        const blocked = Object.assign(new Error(`${hostname} does not resolve to a public address`), {
          code: "ENOTFOUND",
        });
        return callback(blocked, "", 4);
      }
      // Node asks for every address when it races IPv4 and IPv6 (autoSelectFamily).
      if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

/** GETs the document under the fetch rules above and returns the parsed JSON. */
export function fetchMetadataDocument(url: URL, lookup: LookupFunction = publicOnlyLookup()): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const fail = (detail: string) => reject(new CimdError("fetch_failed", detail));
    const request = https.request(
      url,
      { method: "GET", headers: { accept: "application/json" }, lookup, agent: false },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          return fail(`status ${response.statusCode}`); // redirects included: never followed
        }
        if (!/^application\/([\w.+-]+\+)?json\b/i.test(response.headers["content-type"] ?? "")) {
          response.resume();
          return fail("not JSON");
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_DOCUMENT_BYTES) request.destroy(new CimdError("fetch_failed", "document too large"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new CimdError("invalid_document", "document is not valid JSON"));
          }
        });
        response.on("error", (e) => reject(e instanceof CimdError ? e : new CimdError("fetch_failed", e.message)));
      },
    );
    request.setTimeout(FETCH_TIMEOUT_MS, () => request.destroy(new CimdError("fetch_failed", "timeout")));
    request.on("error", (e) => reject(e instanceof CimdError ? e : new CimdError("fetch_failed", e.message)));
    request.end();
  });
}

/** What Thingery keeps from a document. Redirect URIs are normalized by the caller. */
export interface MetadataDocumentClient {
  client_id: string;
  /** The document's host: verified by the fetch, unlike the self-declared client_name. */
  display_name: string;
  redirect_uris: unknown;
}

/** Checks the document describes this client_id and a public client, as Thingery supports only those. */
export function readMetadataDocument(document: unknown, url: URL): MetadataDocumentClient {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new CimdError("invalid_document", "document must be a JSON object");
  }
  const doc = document as Record<string, unknown>;
  if (doc.client_id !== url.href) {
    throw new CimdError("invalid_document", "client_id in the document does not match its URL");
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none") {
    throw new CimdError("invalid_document", "only public clients (token_endpoint_auth_method none) are supported");
  }
  if (doc.client_secret !== undefined) {
    throw new CimdError("invalid_document", "a metadata document must not carry a client_secret");
  }
  return { client_id: url.href, display_name: url.host, redirect_uris: doc.redirect_uris };
}

type Fetch = (url: URL) => Promise<unknown>;

/**
 * Fetches and checks documents, caching good ones for an hour and sharing one fetch
 * between concurrent requests for the same URL. Failures are not cached, but are
 * rate-limited per URL.
 */
export function createMetadataDocumentResolver(
  fetchDocument: Fetch = (url) => fetchMetadataDocument(url),
  now: () => number = Date.now,
) {
  const cache = new Map<string, { client: MetadataDocumentClient; expiresAt: number }>();
  const inFlight = new Map<string, Promise<MetadataDocumentClient>>();
  const limiter = new RateLimiter(FETCHES_PER_URL_PER_HOUR, 60 * 60 * 1000);

  async function load(url: URL): Promise<MetadataDocumentClient> {
    const client = readMetadataDocument(await fetchDocument(url), url);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(url.href, { client, expiresAt: now() + CACHE_TTL_MS });
    return client;
  }

  return async function resolve(clientId: string): Promise<MetadataDocumentClient> {
    const url = parseMetadataDocumentUrl(clientId);
    if (!url) throw new CimdError("invalid_url", "client_id is not a valid metadata document URL");
    const cached = cache.get(url.href);
    if (cached && cached.expiresAt > now()) return cached.client;
    const pending = inFlight.get(url.href);
    if (pending) return pending;
    if (!limiter.allow(url.href)) throw new CimdError("rate_limited", "too many fetches of this document");
    const fetching = load(url).finally(() => inFlight.delete(url.href));
    inFlight.set(url.href, fetching);
    return fetching;
  };
}
