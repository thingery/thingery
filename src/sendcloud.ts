// Sendcloud address-verification client (docs/specs/order-address-verification.md).
//
// The verification provider seam (spec §9): order-time (src/address-verification.ts)
// and save-time (src/addresses.ts) advisory address checks call Sendcloud v3.
// EasyPost remains the labels/tracking processor only (src/easypost.ts) —
// this module owns nothing else. One POST /api/v3/addresses/validate — a
// QUOTE-grade call: no shipment is created, nothing is announced, no money
// moves. Same client conventions as easypost.ts: HTTP basic auth, fetch
// seam for tests, degraded mode with credentials unset (functions return
// null and callers proceed unverified).
//
// Sendcloud v3 contract (public API docs, sendcloud.dev):
// - Auth: HTTP basic ("API key and secrets"). SENDCLOUD_API_KEY carries
//   either the "key:secret" pair verbatim or a single token (sent as the
//   basic username with an empty password) — either account credential
//   shape works without a second env var.
// - Request: { address: { address_line_1, address_line_2?, postal_code,
//   city, country_code }, carrier_code } — carrier_code is REQUIRED by the
//   API and must name a carrier available on the account (env
//   SENDCLOUD_VALIDATE_CARRIER_CODE; unset → degraded, no call). The raw
//   wire shape has no name field, so the buyer's name is never sent.
// - Response: { input_address_is_valid: boolean|null, results: [{
//   address: object|null, validation_method: "here"|null,
//   recommended: boolean, analysis: object|null }] }.
// - Mapping: valid → verified; invalid + a recommended result → suggested
//   (UNVALIDATED provider output — callers MUST F2-gate it before storing
//   or surfacing); no usable result → unverified; the documented
//   "validator not available" null → null (the callers' not_checked path).
//
// Privacy invariants (same discipline as easypost.ts): raw provider
// responses never travel past this module — the return value carries mapped
// domain fields only, and errors carry HTTP status + provider enum code,
// never body text or address values.

import { envValue } from "./config.js";

/** Domain-shaped address (matches ShippingAddress / the address tools'
 *  inputs). Mapped to Sendcloud's address_line / house_number wire format
 *  here so no other layer needs to know the provider's field names. */
export interface SendcloudAddressInput {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string; // ISO 3166-1 alpha-2
}

export interface SendcloudOptions {
  apiKey?: string; // default: SENDCLOUD_API_KEY ("key:secret" or single token)
  /** Required by the validate API: a carrier available on the account
   *  (e.g. "dhl"). Default: SENDCLOUD_VALIDATE_CARRIER_CODE. */
  carrierCode?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch; // test seam
  /** Abort the request after this many ms (the callers enforce the spec's
   *  ≤3s wrap). Unset → the 3s default below applies. */
  timeoutMs?: number;
}

/** A correction candidate as Sendcloud returned it, mapped back to the
 *  domain field names. UNVALIDATED provider output: callers MUST pass it
 *  through address-verification.ts validateSuggestionAddress (F2, orders)
 *  or their own differ/length caps (saved addresses) before storing or
 *  surfacing it — provider payloads may carry anything. */
export interface SendcloudAddressSuggestion {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postal_code: string;
  country: string;
}

export type SendcloudVerification =
  | { status: "verified" } // input_address_is_valid: true — accepted as typed
  | { status: "unverified" } // invalid, nothing correctable we can map
  | { status: "suggested"; suggestion: SendcloudAddressSuggestion }; // invalid, corrected fields present

/** Non-2xx Sendcloud response, with the provider's JSON:API error code when
 *  present (an enum'd string, never address content). Callers treat ANY
 *  throw as not_checked — this exists for log hygiene, not branching. */
export class SendcloudError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(what: string, status: number, code?: string) {
    super(code ? `sendcloud ${what} failed: HTTP ${status} (${code})` : `sendcloud ${what} failed: HTTP ${status}`);
    this.name = "SendcloudError";
    this.status = status;
    this.code = code;
  }
}

function basicAuthHeader(apiKey: string): string {
  // Sendcloud v3: "Basic Authentication using API key and secrets". A
  // credential containing a colon is used verbatim (key:secret); a single
  // token becomes the basic username with an empty password.
  const credentials = apiKey.includes(":") ? apiKey : `${apiKey}:`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

/** POSTs JSON to the Sendcloud v3 API and maps error responses onto
 *  SendcloudError (provider error body: { errors: [{ code, … }] }). */
async function sendcloudPostJson(
  path: string,
  body: unknown,
  opts: SendcloudOptions,
  what: string,
): Promise<Record<string, unknown>> {
  const url = `${opts.baseUrl ?? "https://panel.sendcloud.sc"}${path}`;
  const apiKey = opts.apiKey ?? envValue("SENDCLOUD_API_KEY");
  if (apiKey === undefined) throw new Error("sendcloud not configured"); // callers check first
  // Deadline via an AbortController fired by setTimeout (unref'd so a
  // hanging provider call never pins the process open). The rejection is an
  // ordinary fetch failure — callers' existing catch paths apply.
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 3000;
  timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      let code: string | undefined;
      try {
        const errBody = (await res.json()) as { errors?: Array<{ code?: string }> };
        code = Array.isArray(errBody?.errors) ? errBody.errors[0]?.code : undefined;
      } catch {
        // non-JSON error body — the status alone is the signal
      }
      throw new SendcloudError(what, res.status, code);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toWireAddress(a: SendcloudAddressInput): Record<string, unknown> {
  return {
    address_line_1: a.line1,
    ...(a.line2 ? { address_line_2: a.line2 } : {}),
    postal_code: a.postalCode,
    city: a.city,
    country_code: a.country,
  };
}

const picked = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);

/** Maps a validated-address object from `results[]` onto the domain shape.
 *  Sendcloud keeps the house number in its own field while IT/DE input
 *  embeds it in the street line — rebuild line1 the way the provider wrote
 *  it, without duplicating a number already present in the line. Returns
 *  null when required fields are missing (the caller skips that result). */
function suggestionFromWire(
  raw: Record<string, unknown>,
  input: SendcloudAddressInput,
): SendcloudAddressSuggestion | null {
  const line1 = picked(raw.address_line_1);
  const house = picked(raw.house_number);
  const line2 = picked(raw.address_line_2);
  const city = picked(raw.city);
  const postal = picked(raw.postal_code);
  const country = picked(raw.country_code);
  if (!line1 || !city || !postal || !country) return null;
  const street = house !== null && !line1.includes(house) ? `${line1} ${house}` : line1;
  return {
    name: input.name, // the wire shape has no name field — carry the caller's
    line1: street,
    ...(line2 !== null ? { line2 } : {}),
    city,
    postal_code: postal,
    country,
  };
}

/**
 * Runs the address validation. Returns null in degraded mode (credentials
 * unset — the callers' not_checked path) and also when the provider reports
 * `input_address_is_valid: null` (its documented "validator not available").
 * Throws on network/HTTP problems (non-2xx, timeout); the callers treat ANY
 * throw as not_checked. The ≤3s deadline (spec invariant: the whole check is
 * wrapped) is enforced here via the shared timeoutMs plumbing.
 */
export async function verifySendcloudAddress(
  input: SendcloudAddressInput,
  opts: SendcloudOptions = {},
): Promise<SendcloudVerification | null> {
  const apiKey = opts.apiKey ?? envValue("SENDCLOUD_API_KEY");
  const carrierCode = opts.carrierCode ?? envValue("SENDCLOUD_VALIDATE_CARRIER_CODE");
  if (apiKey === undefined || carrierCode === undefined) return null;

  const body = await sendcloudPostJson(
    "/api/v3/addresses/validate",
    { address: toWireAddress(input), carrier_code: carrierCode },
    opts,
    "address validation",
  );

  // Response mapping (see module header). Anything unexpected maps to
  // unverified or null — failure-open, never a throw the callers would have
  // to distinguish from a network problem.
  if (body.input_address_is_valid === true) return { status: "verified" };
  if (body.input_address_is_valid !== false) return null; // null/missing → validator unavailable

  const results = Array.isArray(body.results) ? body.results : [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as Record<string, unknown>).recommended !== true) continue;
    const addr = (entry as Record<string, unknown>).address;
    if (typeof addr !== "object" || addr === null) continue;
    const suggestion = suggestionFromWire(addr as Record<string, unknown>, input);
    if (!suggestion) continue; // malformed recommended result — try the next
    return { status: "suggested", suggestion };
  }
  return { status: "unverified" };
}
