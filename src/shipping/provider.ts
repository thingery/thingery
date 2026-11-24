// ShippingProvider interface + shared types (spec docs/specs/shipping-provider-layer.md,
// THI-1245/THI-1246; parent THI-1244).
//
// The seam between the order-flow machinery (quotes, label purchase, tracker
// registration, carrier webhook ingest) and the carrier provider. Today the
// only implementation is EasyPost (src/shipping/easypost-adapter.ts, delegating
// to src/easypost.ts); the registry (src/shipping/registry.ts) exposes exactly
// ONE provider per deployment — selected once at boot via SHIPPING_PROVIDER.
// Rate/shipment/tracker ids are provider-scoped opaque strings and only ever
// flow between an order row and the same provider, so a deployment never mixes
// providers across label purchase and tracking (recorded decision, THI-1245).
//
// This module is pure: no imports. Every provider-specific wire detail (auth
// scheme, error mapping, status normalization, webhook verification + F6
// redaction, dedupe id format) lives in its adapter.
//
// Address verification IS part of this interface (amended spec): the active
// provider verifies addresses too — one provider per deployment covers
// labels, tracking AND verification, never a mix. The Sendcloud v3 path
// (src/sendcloud.ts) is retired from the active flow and stays dormant until
// its contract-PR deletion. EasyPost declares no verification capability
// (supportsAddressVerification = false ⇒ services skip the check before any
// budget is spent); Shippo implements it with the spec's 6-row mapping.

/** The provider ids the platform knows, in the platform's vocabulary. The
 *  AVAILABLE set per build is smaller (see AVAILABLE_SHIPPING_PROVIDERS in
 *  src/config.ts): a provider id becomes selectable when its adapter lands
 *  in src/shipping/registry.ts. */
export const SHIPPING_PROVIDER_IDS = ["easypost", "shippo"] as const;
export type ShippingProviderId = typeof SHIPPING_PROVIDER_IDS[number];

/** Domain-shaped address — matches ShippingAddress / the tool layer's
 *  from_address. Mapped to the provider's wire format inside each adapter so
 *  no other layer knows the provider's field names. */
export interface ProviderAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string; // ISO 3166-1 alpha-2
  phone?: string;
}

export interface ProviderShipmentInput {
  toAddress: ProviderAddress; // the order's shipping_address
  fromAddress: ProviderAddress; // seller-supplied, not persisted
  weightGrams: number; // listing estimate or seller override
  dimensionsMm?: { length: number; width: number; height: number };
}

/** One quoted rate from a shipment (money is a decimal string at every
 *  provider API; carried as integer cents internally — never float math). */
export interface ShipmentRate {
  id: string; // provider rate id — opaque, single-use, provider-scoped
  carrier: string; // display/selection name ("DHL Paket", "USPS", …)
  service: string; // provider service label/token
  costCents: number;
  currency: string; // ISO 4217
}

/** A shipment after create — rates quoted, nothing bought yet. */
export interface ProviderShipment {
  shipmentId: string; // provider-scoped opaque id
  rates: ShipmentRate[];
}

/** Provider-namespaced opaque tracker id (EasyPost "trk_…"). Stored on
 *  orders.tracker_id and is the PRIMARY webhook resolution key (F4). */
export interface TrackerRef {
  id: string;
}

/** The bought label — exactly what the service layer persists on the order
 *  (carrier/tracking/tracker_id/label_url + the label_purchase snapshot). */
export interface BoughtLabel {
  shipmentId: string;
  rateId: string;
  carrier: string;
  service: string;
  costCents: number;
  currency: string;
  labelUrl: string; // https-only, enforced by the adapter (F16)
  trackerId: string; // provider tracker id — webhook resolution key (F4)
  trackingCode: string;
}

/** Non-2xx provider response, with the provider's error code when present.
 *  Adapters map provider faults onto this; service layers catch it to decide
 *  re-quote vs surface. EasyPostError (src/easypost.ts) is a subclass, so
 *  existing error messages are preserved byte-for-byte. */
export class ProviderError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
  }
}

/** Webhook signature verification failure (bad/missing signature or header).
 *  `wireMessage` is the exact HTTP body the ingest route must emit 400 with,
 *  so responses stay byte-identical to the pre-interface endpoint. */
export class VerificationError extends Error {
  readonly wireMessage: string;

  constructor(message: string, wireMessage: string = message) {
    super(message);
    this.name = "VerificationError";
    this.wireMessage = wireMessage;
  }
}

/** Webhook body parse failure (invalid JSON after a VALID signature).
 *  `wireMessage` plays the same role as VerificationError's. */
export class WebhookParseError extends Error {
  readonly wireMessage: string;

  constructor(message: string, wireMessage: string = message) {
    super(message);
    this.name = "WebhookParseError";
    this.wireMessage = wireMessage;
  }
}

/** Normalized carrier status — the carrier never leaks into the machine. */
export type NormalizedStatus =
  | "pre_transit"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "return_to_sender"
  | "failure"
  | "unknown";

/** The redacted, provider-neutral carrier event (F6 fields ONLY — free-text
 *  and facility details never touch the store). Produced by parseWebhook
 *  AFTER verification; also the stored webhook_events payload shape. */
export interface RedactedCarrierEvent {
  description: string | null;
  mode: string | null; // "test" | "production" | null
  tracker_id: string | null;
  tracking_code: string | null;
  carrier: string | null;
  carrier_status: string | null;
  status: NormalizedStatus | null;
  occurred_at: string | null;
}

/** Provider-mapped verification outcome (amended spec). `reason` carries
 *  provider-prefixed code strings only — no address values, no provider prose
 *  (value-free, F3 discipline). `suggested` rides as a ProviderAddress; the
 *  callers re-validate it (F2) before any store or return. */
export type ProviderAddressVerification =
  | { status: "verified" }
  | { status: "unverified"; reason?: string } // e.g. "shippo_address_invalid"
  | { status: "suggested"; suggestion: ProviderAddress };

/** Per-provider env-var conventions: the API key lives in `${ID}_API_KEY`,
 *  the webhook secret in `${ID}_WEBHOOK_SECRET` (+ `_PREVIOUS` rotation).
 *  config.ts reads only the selected provider's pair; service layers reuse
 *  these for degraded-mode messages so default deployments keep today's
 *  exact strings. */
export function providerApiKeyEnv(id: ShippingProviderId): string {
  return `${id.toUpperCase()}_API_KEY`;
}

export function providerWebhookSecretEnv(id: ShippingProviderId): string {
  return `${id.toUpperCase()}_WEBHOOK_SECRET`;
}

/**
 * Picks which quoted rate to buy: the cheapest overall, or the cheapest
 * whose carrier matches `carrierPreference` (case-insensitive substring,
 * e.g. "DHL" matches "DHLExpress"). A preference that matches nothing
 * returns null — the caller errors rather than silently spending on a
 * carrier the seller did not ask for. Provider-independent; pure; no
 * network, no key. (The shared home of the former pickEasyPostRate.)
 */
export function pickRate(
  rates: readonly ShipmentRate[],
  carrierPreference?: string,
): ShipmentRate | null {
  const want = carrierPreference?.trim().toLowerCase();
  const eligible = want ? rates.filter((r) => r.carrier.toLowerCase().includes(want)) : rates;
  let best: ShipmentRate | null = null;
  for (const r of eligible) {
    if (best === null || r.costCents < best.costCents) best = r;
  }
  return best;
}

/**
 * The provider seam. Exactly one instance per deployment (registry), handed
 * out by getShippingProvider(cfg). Null-returning methods are the DEGRADED
 * contract: null iff the provider is not configured (F1 empty-is-unset) —
 * callers fall back / store-without-automation exactly as before the
 * interface existed. Provider faults throw (ProviderError from the buy/quote
 * paths; VerificationError/WebhookParseError from the webhook path).
 */
export interface ShippingProvider {
  /** Registry key ("easypost" | "shippo" | …). Also the reason-code prefix
   *  (`${id}_not_configured` / `${id}_error`). */
  readonly id: ShippingProviderId;
  /** Human display name for user-visible sentences ("EasyPost", "Shippo").
   *  Under the default provider the rendered strings are today's. */
  readonly displayName: string;

  /** true iff the provider's API key is configured (F1 empty-is-unset). */
  isConfigured(): boolean;

  /** Quote rates. Returns null iff not configured (degraded). Throws
   *  ProviderError on provider faults; respects `signal` (order-time quotes
   *  pass AbortSignal.timeout so a hanging provider never holds a row lock). */
  createShipment(input: ProviderShipmentInput, signal?: AbortSignal):
    Promise<ProviderShipment | null>;

  /** THE spend call. Buys against a previously quoted shipment+rate of THIS
   *  provider. Null iff not configured; throws ProviderError on provider
   *  faults and on malformed success payloads. */
  buyLabel(shipmentId: string, rateId: string): Promise<BoughtLabel | null>;

  /** Best-effort tracker registration for an own-carrier code. Null iff not
   *  configured. Throws on provider faults; callers treat as non-fatal
   *  (event-logged; the order still advances). `metadata` is the provider
   *  correlation echo where supported (adapters may ignore it). */
  registerTracker(carrier: string, trackingCode: string, metadata?: string):
    Promise<TrackerRef | null>;

  /** Verify the carrier webhook over RAW bytes. Throws VerificationError on
   *  any failure (missing header, bad signature). Implementations MUST
   *  compare timing-safe and support current+previous secrets (F13); the
   *  previous-secret rotation warning is logged inside the adapter. */
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): void;

  /** Parse AFTER verify: produce the redacted, provider-neutral event (F6
   *  fields only). Throws WebhookParseError on a body that is not valid
   *  JSON (nothing was verifiable content). */
  parseWebhook(raw: Buffer): RedactedCarrierEvent;

  /** Deterministic dedupe key for raw bytes: `${id}:<sha256(raw)>` — no
   *  provider today documents a per-delivery event id; the scheme stays
   *  uniform across providers. */
  dedupeId(raw: Buffer): string;

  /** Static capability flag. false ⇒ verifyAddress always returns null and
   *  the service skips the check BEFORE caps (no budget consumed — the
   *  availability pre-check, invariant 1 of the verification spec). */
  readonly supportsAddressVerification: boolean;

  /** Advisory address verification. Null ⇔ verification unavailable (provider
   *  key unset OR unsupported capability) — the callers' `not_checked`.
   *  Throws ProviderError on provider faults; callers treat ANY throw as
   *  `not_checked` (failure-open invariant, unchanged). Must respect `signal`
   *  (the services pass a ≤3s deadline). Sends only the typed address fields
   *  — never the buyer's name, never free text (data minimisation, same
   *  discipline as the Sendcloud wire contract). A mapped suggestion rides as
   *  a ProviderAddress; callers re-validate it before any store or return
   *  (F2) and downgrade identical-to-input "corrections" (not corrections). */
  verifyAddress(input: ProviderAddress, signal?: AbortSignal):
    Promise<ProviderAddressVerification | null>;
}
