// Shippo transport (spec docs/specs/shipping-provider-layer.md; THI-1247).
//
// All Shippo-specific wire behavior (auth, endpoints, error mapping, the
// webhook HMAC scheme, tracker-id synthesis) lives here so the adapter
// (src/shipping/shippo-adapter.ts) and the order flow stay provider-agnostic.
// Same client conventions as easypost.ts: fetch seam for tests, degraded mode
// with the key unset (functions return null and callers proceed unconfigured),
// and money as integer cents internally — the API's decimal strings never
// leak past parseRate.
//
// Shippo REST contract (official docs only; recorded in the spec, 2026-11-23):
// - Auth: `Authorization: ShippoToken <key>`. Test-mode keys are
//   `shippo_test_…` (test mode is free; all label features included).
// - POST /shipments (addresses + parcel, `async: false`) → shipment with
//   quoted rates; rate = { object_id, provider, servicelevel {name},
//   amount (decimal string), currency, amount_local }.
// - POST /transactions { rate, async: false } → the bought label:
//   status "SUCCESS", label_url (https, signed and expiring — stored as data
//   at purchase), tracking_number, and the full rate echo (provider + service).
// - POST /tracks { carrier, tracking_number, metadata } → a TrackingStatus
//   object; there is NO tracker object/id (unlike EasyPost trk_…), so the
//   adapter synthesizes one deterministically via shippoTrackerId().
// - GET /v2/addresses/validate (address fields as query parameters) → the
//   validation analysis. The REQUEST carries only street/city/zip/country —
//   never the buyer's name, never free text (data minimisation, same
//   discipline as the Sendcloud wire contract). The raw response body is
//   returned unparsed: mapping to verification outcomes happens in the
//   adapter per the spec's 6-row table (src/shipping/shippo-adapter.ts).
// - Webhooks: Stripe-style timestamped HMAC — signature header
//   `t=<unix-ts>,v1=<hex>`, signed payload `<ts>.<raw body>`, HMAC-SHA256
//   hex, timing-safe compare. No timestamp freshness window is documented
//   (rely on the ingest route's dedupe + transition guard).
//
// Privacy invariants (same discipline as easypost.ts / sendcloud.ts): raw
// provider responses never travel past this module's callers unmapped — the
// returned shapes carry domain fields only, and errors carry HTTP status +
// provider enum code, never body text or address values.
//
// Test mode (THI-1247/1248 constraint): this transport makes no live calls in
// this PR — it ships behind SHIPPING_PROVIDER=shippo which no activation has
// set yet; the deployment key arrives via the operator's secure channel at
// the activation step, and every documented behavior is frozen by tests at
// the fetch seam.

import crypto from "node:crypto";
import { envValue } from "./config.js";
import {
  ProviderError,
  type BoughtLabel,
  type ProviderAddress,
  type ProviderShipmentInput,
  type ShipmentRate,
} from "./shipping/provider.js";

export interface ShippoOptions {
  apiKey?: string; // default: SHIPPO_API_KEY (empty = unset, F1)
  baseUrl?: string;
  fetchImpl?: typeof fetch; // test seam
  /** Abort the request after this many ms. Unset → no transport-level
   *  timeout; callers pass `signal` where a deadline is required (order-time
   *  quoting, address verification). */
  timeoutMs?: number;
}

/** Domain-shaped address (matches ShippingAddress / the tool layer's
 *  from_address) — mapped to Shippo's street1/zip wire format here so no
 *  other layer needs to know the provider's field names. */
export interface ShippoAddressInput {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string; // ISO 3166-1 alpha-2
  phone?: string;
}

/** One quoted rate from a Shippo shipment (money is a decimal string at the
 *  API; carried as integer cents internally — never float math). */
export interface ShippoRate {
  id: string; // rate object_id — required by /transactions
  carrier: string; // rate.provider, e.g. "DHL Germany", "USPS"
  service: string; // servicelevel.name, e.g. "Paket National"
  costCents: number;
  currency: string; // ISO 4217
}

/** Shippo shipment after create — rates quoted, nothing bought yet. */
export interface ShippoShipment {
  id: string; // shipment object_id
  rates: ShippoRate[];
}

/** The bought label — exactly what the adapter persists on the order
 *  (carrier/tracking/tracker_id/label_url + the label_purchase snapshot).
 *  trackerId is SYNTHESIZED (Shippo has no tracker object — see
 *  shippoTrackerId below); carrier comes from the transaction's rate echo. */
export interface ShippoBoughtLabel {
  shipmentId: string;
  rateId: string;
  carrier: string;
  service: string;
  costCents: number;
  currency: string;
  labelUrl: string; // https-only, checked below (F16)
  trackerId: string; // synthesized — webhook resolution key (F4)
  trackingCode: string;
}

export interface ShippoTrackerRef {
  id: string; // synthesized — structurally identical to TrackerRef
}

/** Non-2xx Shippo response, with the provider's error code when present.
 *  A ProviderError (src/shipping/provider.ts) so service layers catch
 *  provider faults generically. */
export class ShippoError extends ProviderError {
  constructor(what: string, status: number, code?: string) {
    super(
      code ? `shippo ${what} failed: HTTP ${status} (${code})` : `shippo ${what} failed: HTTP ${status}`,
      status,
      code,
    );
    this.name = "ShippoError";
  }
}

/** Deterministic tracker id for a (carrier, tracking code) pair:
 *  `shippo:` + first 32 hex chars of sha256(carrier + "|" + tracking_code).
 *  Shippo's /tracks has no tracker object and track_updated webhooks carry
 *  no tracker id, so this is computed at registration AND at webhook ingest
 *  — identical both sides, which keeps orders.tracker_id resolution (F4)
 *  working. The `shippo:` prefix cannot collide with EasyPost `trk_…` ids
 *  under the UNIQUE constraint. Pure; no network. */
export function shippoTrackerId(carrier: string, trackingCode: string): string {
  return `shippo:${crypto.createHash("sha256").update(`${carrier}|${trackingCode}`).digest("hex").slice(0, 32)}`;
}

/** Signature header for the documented HMAC scheme. Shippo's docs surface it
 *  as the CGI-style `HTTP_SHIPPO_AUTH_SIGNATURE`; express lowercases header
 *  names, so the wire constant is the lowercased equivalent. Provisioning
 *  confirms the exact casing before production activation (spec open
 *  question) — it is isolated here so a confirmed change is a one-line edit.
 *  Test mode does not use HMAC verification (see the spec's activation
 *  posture: token/allowlist are acceptable for test only). */
export const SHIPPO_SIG_HEADER = "shippo-auth-signature";

/**
 * Timing-safe HMAC-SHA256 (hex) compare per the documented scheme:
 * header `t=<unix-ts>,v1=<hex>`, signed payload `<ts>.<raw body>`. Catches
 * the length-mismatch throw — both digests and header are attacker-controlled
 * lengths. No freshness window (spec open question; the ingest route's dedupe
 * and the order transition guard absorb replays).
 */
export function verifyShippoSignature(raw: Buffer, header: string, secret: string): boolean {
  try {
    const parts = header.trim().split(",").map((p) => p.trim());
    const t = parts.find((p) => p.startsWith("t="))?.slice(2);
    const v1 = parts.find((p) => p.startsWith("v1="))?.slice(3);
    if (!t || !v1 || !/^\d+$/.test(t)) return false;
    const digest = crypto.createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex");
    const provided = Buffer.from(v1.toLowerCase(), "utf8");
    const expected = Buffer.from(digest, "utf8");
    return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

/** POSTs JSON to the Shippo API and maps error responses onto ShippoError
 *  (provider error body: { detail?: string } or a code field — only the
 *  enum-ish code is carried; never the body text). */
async function shippoPostJson(
  path: string,
  body: unknown,
  opts: ShippoOptions,
  what: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return shippoRequest("POST", path, body, opts, what, signal);
}

/** GETs from the Shippo API (query-string parameters, no body). */
async function shippoGetJson(
  path: string,
  params: Record<string, string>,
  opts: ShippoOptions,
  what: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params).toString();
  return shippoRequest("GET", `${path}?${query}`, undefined, opts, what, signal);
}

async function shippoRequest(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  opts: ShippoOptions,
  what: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = `${opts.baseUrl ?? "https://api.goshippo.com"}${path}`;
  const apiKey = opts.apiKey ?? envValue("SHIPPO_API_KEY");
  if (apiKey === undefined) throw new Error("shippo not configured"); // callers check first
  // Optional deadline via an AbortController fired by setTimeout (unref'd so
  // a hanging provider call never pins the process open). A caller-supplied
  // `signal` is forwarded verbatim when no transport timeout is set.
  let timer: NodeJS.Timeout | undefined;
  const controller = opts.timeoutMs === undefined ? undefined : new AbortController();
  if (controller && opts.timeoutMs) {
    timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    timer.unref();
  }
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method,
      headers: {
        Authorization: `ShippoToken ${apiKey}`,
        "Content-Type": "application/json",
      },
      ...(method === "POST" && body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(controller ? { signal: controller.signal } : signal ? { signal } : {}),
    });
    if (!res.ok) {
      let code: string | undefined;
      try {
        const errBody = (await res.json()) as { detail?: string; code?: string };
        code = typeof errBody?.code === "string" ? errBody.code : undefined;
      } catch {
        // non-JSON error body — the status alone is the signal
      }
      throw new ShippoError(what, res.status, code);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toWireAddress(a: ShippoAddressInput): Record<string, unknown> {
  return {
    name: a.name,
    street1: a.line1,
    ...(a.line2 ? { street2: a.line2 } : {}),
    city: a.city,
    zip: a.postalCode,
    country: a.country,
    ...(a.phone ? { phone: a.phone } : {}),
  };
}

/** "10.45" (decimal string) → 1045 cents; rounds, never float-drifts. */
function costCents(amount: string): number | undefined {
  const n = Number(amount);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
}

function parseRate(raw: unknown): ShippoRate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.object_id === "string" ? r.object_id : undefined;
  const carrier = typeof r.provider === "string" ? r.provider : undefined;
  const servicelevel = r.servicelevel as Record<string, unknown> | undefined;
  const service = servicelevel && typeof servicelevel.name === "string" ? servicelevel.name : undefined;
  if (!id || !carrier || !service) return null;
  const cents = typeof r.amount === "string" ? costCents(r.amount) : undefined;
  const currency = typeof r.currency === "string" ? r.currency : undefined;
  if (cents === undefined || !currency) return null;
  return { id, carrier, service, costCents: cents, currency };
}

/** Shippo parcels take metric units natively: mass_unit "g", distance_unit
 *  "cm". Dimensions arrive in mm — divide by 10, rounded to keep payloads
 *  stable. Weight must be positive (the caller's schema already enforces it;
 *  this is the adapter's defensive repeat). */
function toWireParcel(input: ProviderShipmentInput): Record<string, unknown> {
  if (!(input.weightGrams > 0)) {
    throw new Error("shippo shipment failed: weight_grams must be positive");
  }
  const parcel: Record<string, unknown> = {
    weight: input.weightGrams,
    mass_unit: "g",
  };
  if (input.dimensionsMm) {
    const cm = (mm: number): number => Math.round((mm / 10) * 10) / 10;
    parcel.length = cm(input.dimensionsMm.length);
    parcel.width = cm(input.dimensionsMm.width);
    parcel.height = cm(input.dimensionsMm.height);
    parcel.distance_unit = "cm";
  }
  return parcel;
}

/**
 * Creates a shipment and returns its quoted rates (no purchase happens
 * here). Returns null in degraded mode (key unset). `signal` bounds the
 * HTTP call — order-time quoting passes AbortSignal.timeout(
 * SHIPPING_QUOTE_TIMEOUT_MS) so a hanging provider can never hold the
 * caller's transaction; a timeout rejects (callers treat it as flat-mode
 * fallback).
 */
export async function createShippoShipment(
  input: ProviderShipmentInput,
  opts: ShippoOptions = {},
  signal?: AbortSignal,
): Promise<ShippoShipment | null> {
  const apiKey = opts.apiKey ?? envValue("SHIPPO_API_KEY");
  if (apiKey === undefined) return null;

  const body = await shippoPostJson(
    "/shipments",
    {
      address_from: toWireAddress(input.fromAddress),
      address_to: toWireAddress(input.toAddress),
      parcel: toWireParcel(input),
      async: false, // synchronous: rates are in the response
    },
    opts,
    "shipment creation",
    signal,
  );
  const id = typeof body.object_id === "string" ? body.object_id : undefined;
  if (!id) throw new Error("shippo shipment creation failed: no shipment id");
  const rates = Array.isArray(body.rates)
    ? body.rates.map(parseRate).filter((r): r is ShippoRate => r !== null)
    : [];
  return { id, rates };
}

/**
 * Buys the label for a previously created shipment — the one call that
 * spends money (`POST /transactions`). Returns null in degraded mode (key
 * unset); throws ShippoError on provider errors and on a malformed or
 * non-SUCCESS transaction payload (queued/errored/unknown statuses are
 * exceptional for async:false and must surface, not be swallowed).
 */
export async function buyShippoLabel(
  shipmentId: string,
  rateId: string,
  opts: ShippoOptions = {},
): Promise<ShippoBoughtLabel | null> {
  const apiKey = opts.apiKey ?? envValue("SHIPPO_API_KEY");
  if (apiKey === undefined) return null;

  const body = await shippoPostJson(
    "/transactions",
    { rate: rateId, async: false },
    opts,
    "label purchase",
  );

  const status = typeof body.status === "string" ? body.status : undefined;
  const labelUrl = typeof body.label_url === "string" && body.label_url.length > 0 ? body.label_url : undefined;
  const trackingCode =
    typeof body.tracking_number === "string" && body.tracking_number.length > 0 ? body.tracking_number : undefined;
  const rate = parseRate(body.rate); // the transaction echoes the bought rate (carrier + service + amount)

  if (status !== "SUCCESS" || !labelUrl || !trackingCode || !rate) {
    throw new Error(
      status === "SUCCESS"
        ? "shippo label purchase failed: incomplete success payload"
        : `shippo label purchase failed: ${status ? `transaction status ${status}` : "incomplete success payload"}`,
    );
  }
  // https-only, same discipline as the stored label_url (F16): a non-https
  // label URL from the provider is refused rather than passed through.
  if (!/^https:\/\//i.test(labelUrl)) {
    throw new Error("shippo label purchase failed: label_url is not https");
  }
  return {
    shipmentId,
    rateId,
    carrier: rate.carrier,
    service: rate.service,
    costCents: rate.costCents,
    currency: rate.currency,
    labelUrl,
    trackerId: shippoTrackerId(rate.carrier, trackingCode),
    trackingCode,
  };
}

/**
 * Registers an external (own-carrier) tracking code: `POST /tracks
 * {carrier, tracking_number, metadata}` — best-effort automation for codes
 * Shippo did not mint itself (Shippo auto-tracks labels bought through
 * Shippo). Requires an account-level webhook subscription to exist; the
 * response is a TrackingStatus object with NO tracker id, so the caller's
 * tracker id is the deterministic synthesis. metadata is Shippo's
 * provider-native correlation echo ("thingery:{order_id}"). Returns null in
 * degraded mode; throws on a non-2xx or a non-object response — callers
 * treat registration as best-effort (non-fatal).
 */
export async function createShippoTracker(
  carrier: string,
  trackingCode: string,
  metadata?: string,
  opts: ShippoOptions = {},
): Promise<ShippoTrackerRef | null> {
  const apiKey = opts.apiKey ?? envValue("SHIPPO_API_KEY");
  if (apiKey === undefined) return null;

  const body = await shippoPostJson(
    "/tracks",
    { carrier, tracking_number: trackingCode, ...(metadata ? { metadata } : {}) },
    opts,
    "tracker registration",
  );
  // The response is a TrackingStatus (carrier/tracking_number echo + status).
  // Only the object shape is asserted; nothing from it is stored (the id is
  // synthesized and the order already carries the code).
  if (typeof body !== "object" || body === null) {
    throw new Error("shippo tracker registration failed: malformed response");
  }
  return { id: shippoTrackerId(carrier, trackingCode) };
}

/** The subset of address fields the validate endpoint accepts — typed fields
 *  only, never the name (see validateShippoAddressRaw). */
export type ShippoValidateInput = Pick<
  ShippoAddressInput,
  "line1" | "line2" | "city" | "postalCode" | "country"
>;

/**
 * GET /v2/addresses/validate — the RAW validation response, mapped nowhere:
 * the adapter owns the 6-row outcome mapping (spec table) so the wire shape
 * has exactly one interpreter. The query carries street/city/zip/country
 * ONLY — never the name (data minimisation). Throws on network/HTTP
 * problems; callers treat ANY throw as not_checked (failure-open).
 */
export async function validateShippoAddressRaw(
  input: ShippoValidateInput,
  opts: ShippoOptions = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const params: Record<string, string> = {
    street1: input.line1,
    city: input.city,
    zip_code: input.postalCode,
    country: input.country,
  };
  if (input.line2) params.street2 = input.line2;
  return shippoGetJson("/v2/addresses/validate", params, opts, "address validation", signal);
}
