// EasyPost Tracker registration (spec THI-3 rev 2 §5.2/§5.4; PR-5).
//
// record_tracking registers the carrier+code pair as an EasyPost tracker so
// status updates arrive as signed carrier webhooks (PR-7). The tracker id is
// stored on the order and is the PRIMARY webhook resolution key (F4:
// tracking codes collide — legitimately and maliciously — tracker ids don't).
//
// Degraded mode (§5.4): EASYPOST_API_KEY unset → createEasyPostTracker
// returns null and record_tracking still stores carrier + tracking_code.
// The state machine is complete without the carrier; the carrier only
// automates. Failures to register are non-fatal (event-logged; the seller
// can retry via a tracking correction, §2.3 #23).

import { envValue } from "./config.js";

export interface TrackerRef {
  id: string; // EasyPost tracker id ("trk_…"), unique per registration
}

export interface EasyPostOptions {
  apiKey?: string; // default: EASYPOST_API_KEY (empty = unset, F1)
  baseUrl?: string;
  fetchImpl?: typeof fetch; // test seam
}

/**
 * Registers a tracker; returns null in degraded mode (key unset).
 * Throws on a non-2xx response — callers treat registration as best-effort.
 */
export async function createEasyPostTracker(
  carrier: string,
  trackingCode: string,
  opts: EasyPostOptions = {},
): Promise<TrackerRef | null> {
  const apiKey = opts.apiKey ?? envValue("EASYPOST_API_KEY");
  if (apiKey === undefined) return null;

  const url = `${opts.baseUrl ?? "https://api.easypost.com"}/v2/trackers`;
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      // EasyPost HTTP basic auth: the API key is the username.
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tracker: { tracking_code: trackingCode, carrier } }),
  });
  if (!res.ok) {
    throw new Error(`easypost tracker registration failed: HTTP ${res.status}`);
  }
  const tracker = (await res.json()) as { id?: string };
  if (!tracker?.id) throw new Error("easypost tracker registration failed: no tracker id");
  return { id: tracker.id };
}

// ---------------------------------------------------------------------------
// Label purchase client (spec docs/specs/label-purchase.md, THI-562 work item
// 2; THI-568 PR-A). Same conventions as the tracker registration above: the
// API key comes from EASYPOST_API_KEY (unset → degraded mode, functions
// return null and callers surface `easypost_not_configured`), HTTP basic auth
// with the key as username, and a fetch seam for unit tests.
//
// The spend-relevant flow is deliberately split in two calls so the service
// layer (src/fulfillment.ts, PR-B) can apply its guards between them:
// createEasyPostShipment only *quotes* rates (no money moves until /buy),
// buyEasyPostLabel is the one call that spends. Rate choice (lowest cost or
// carrier preference) is a pure helper so quota/cap policy stays testable
// without touching the network seam.
// ---------------------------------------------------------------------------

/** One quoted rate from an EasyPost shipment (money is a decimal string
 *  at the API; carried as integer cents internally — never float math). */
export interface EasyPostRate {
  id: string; // "rate_…" — required by /buy
  carrier: string; // e.g. "DHLExpress", "USPS"
  service: string; // e.g. "ExpressWorldwide", "Priority"
  costCents: number;
  currency: string; // ISO 4217, e.g. "USD" / "EUR"
}

/** EasyPost shipment after create — rates quoted, nothing bought yet. */
export interface EasyPostShipment {
  id: string; // "shp_…"
  rates: EasyPostRate[];
}

/** Domain-shaped address (matches ShippingAddress / the tool layer's
 *  from_address) — mapped to EasyPost's street1/zip wire format here so no
 *  other layer needs to know the provider's field names. */
export interface EasyPostAddressInput {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string; // ISO 3166-1 alpha-2
  phone?: string;
}

export interface CreateEasyPostShipmentInput {
  toAddress: EasyPostAddressInput; // the order's shipping_address
  fromAddress: EasyPostAddressInput; // seller-supplied, not persisted
  weightGrams: number; // listing estimate or seller override
  dimensionsMm?: { length: number; width: number; height: number };
}

/** The bought label — exactly what PR-B persists on the order
 *  (carrier/tracking/tracker_id/label_url + the label_purchase snapshot). */
export interface EasyPostBoughtLabel {
  shipmentId: string; // "shp_…"
  rateId: string; // "rate_…"
  carrier: string;
  service: string;
  costCents: number;
  currency: string;
  labelUrl: string; // https-only (checked)
  trackerId: string; // "trk_…" — the carrier webhook resolution key (F4)
  trackingCode: string;
}

/** Non-2xx EasyPost response, with the provider's error code when present.
 *  Service layers map this onto their user-facing error codes. */
export class EasyPostError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(what: string, status: number, code?: string) {
    super(code ? `easypost ${what} failed: HTTP ${status} (${code})` : `easypost ${what} failed: HTTP ${status}`);
    this.name = "EasyPostError";
    this.status = status;
    this.code = code;
  }
}

function basicAuthHeader(apiKey: string): string {
  // EasyPost HTTP basic auth: the API key is the username.
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

/** POSTs JSON to the EasyPost v2 API and maps error responses onto
 *  EasyPostError (provider error body: { error: { message, code } }). */
async function easypostPostJson(
  path: string,
  body: unknown,
  opts: EasyPostOptions,
  what: string,
): Promise<Record<string, unknown>> {
  const url = `${opts.baseUrl ?? "https://api.easypost.com"}${path}`;
  const apiKey = opts.apiKey ?? envValue("EASYPOST_API_KEY");
  if (apiKey === undefined) throw new Error("easypost not configured"); // callers check first
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let code: string | undefined;
    try {
      const errBody = (await res.json()) as { error?: { code?: string } };
      code = errBody?.error?.code;
    } catch {
      // non-JSON error body — the status alone is the signal
    }
    throw new EasyPostError(what, res.status, code);
  }
  return (await res.json()) as Record<string, unknown>;
}

// EasyPost parcel weights are ounces and dimensions inches — convert from
// the metric inputs the tools/schema carry, rounded to keep payloads stable.
const GRAMS_PER_OUNCE = 28.349523125;
const MM_PER_INCH = 25.4;

function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function toWireAddress(a: EasyPostAddressInput): Record<string, unknown> {
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
function costCents(rate: string): number | undefined {
  const n = Number(rate);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
}

function parseRate(raw: unknown): EasyPostRate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : undefined;
  const carrier = typeof r.carrier === "string" ? r.carrier : undefined;
  const service = typeof r.service === "string" ? r.service : undefined;
  if (!id || !carrier || !service) return null;
  const cents = typeof r.rate === "string" ? costCents(r.rate) : undefined;
  const currency = typeof r.currency === "string" ? r.currency : undefined;
  if (cents === undefined || !currency) return null;
  return { id, carrier, service, costCents: cents, currency };
}

/**
 * Creates a shipment and returns its quoted rates (no purchase happens
 * here). Returns null in degraded mode (key unset).
 */
export async function createEasyPostShipment(
  input: CreateEasyPostShipmentInput,
  opts: EasyPostOptions = {},
): Promise<EasyPostShipment | null> {
  const apiKey = opts.apiKey ?? envValue("EASYPOST_API_KEY");
  if (apiKey === undefined) return null;

  if (!(input.weightGrams > 0)) {
    throw new Error("easypost shipment failed: weight_grams must be positive");
  }

  const parcel: Record<string, unknown> = {
    weight: roundTo(input.weightGrams / GRAMS_PER_OUNCE, 3),
  };
  if (input.dimensionsMm) {
    parcel.length = roundTo(input.dimensionsMm.length / MM_PER_INCH, 3);
    parcel.width = roundTo(input.dimensionsMm.width / MM_PER_INCH, 3);
    parcel.height = roundTo(input.dimensionsMm.height / MM_PER_INCH, 3);
  }

  const body = await easypostPostJson(
    "/v2/shipments",
    {
      shipment: {
        to_address: toWireAddress(input.toAddress),
        from_address: toWireAddress(input.fromAddress),
        parcel,
      },
    },
    opts,
    "shipment creation",
  );
  const id = typeof body.id === "string" ? body.id : undefined;
  if (!id) throw new Error("easypost shipment creation failed: no shipment id");
  const rates = Array.isArray(body.rates)
    ? body.rates.map(parseRate).filter((r): r is EasyPostRate => r !== null)
    : [];
  return { id, rates };
}

/**
 * Buys the label for a previously created shipment — the one call that
 * spends money. Returns null in degraded mode (key unset); throws
 * EasyPostError on provider errors and on a malformed success payload (a
 * bought label without a usable label URL or tracker is exceptional and
 * must surface, not be swallowed).
 */
export async function buyEasyPostLabel(
  shipmentId: string,
  rateId: string,
  opts: EasyPostOptions = {},
): Promise<EasyPostBoughtLabel | null> {
  const apiKey = opts.apiKey ?? envValue("EASYPOST_API_KEY");
  if (apiKey === undefined) return null;

  const body = await easypostPostJson(
    `/v2/shipments/${encodeURIComponent(shipmentId)}/buy`,
    { rate: { id: rateId } },
    opts,
    "label purchase",
  );

  const selected = body.selected_rate;
  const rate = parseRate(selected);
  const postage = body.postage_label as Record<string, unknown> | undefined;
  const labelUrl = postage && typeof postage.label_url === "string" ? postage.label_url : undefined;
  const tracker = body.tracker as Record<string, unknown> | undefined;
  const trackerId = tracker && typeof tracker.id === "string" ? tracker.id : undefined;
  const trackingCode = typeof body.tracking_code === "string" ? body.tracking_code : undefined;

  if (!rate || !labelUrl || !trackerId || !trackingCode) {
    throw new Error("easypost label purchase failed: incomplete success payload");
  }
  // https-only, same discipline as the stored label_url (F16): a non-https
  // label URL from the provider is refused rather than passed through.
  if (!/^https:\/\//i.test(labelUrl)) {
    throw new Error("easypost label purchase failed: label_url is not https");
  }
  return {
    shipmentId,
    rateId,
    carrier: rate.carrier,
    service: rate.service,
    costCents: rate.costCents,
    currency: rate.currency,
    labelUrl,
    trackerId,
    trackingCode,
  };
}

/**
 * Picks which quoted rate to buy: the cheapest overall, or the cheapest
 * whose carrier matches `carrierPreference` (case-insensitive substring,
 * e.g. "DHL" matches "DHLExpress"). A preference that matches nothing
 * returns null — the caller errors rather than silently spending on a
 * carrier the seller did not ask for. Pure; no network, no key.
 */
export function pickEasyPostRate(
  rates: readonly EasyPostRate[],
  carrierPreference?: string,
): EasyPostRate | null {
  const want = carrierPreference?.trim().toLowerCase();
  const eligible = want ? rates.filter((r) => r.carrier.toLowerCase().includes(want)) : rates;
  let best: EasyPostRate | null = null;
  for (const r of eligible) {
    if (best === null || r.costCents < best.costCents) best = r;
  }
  return best;
}
