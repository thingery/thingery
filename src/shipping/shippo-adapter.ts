// Shippo adapter — the ShippingProvider implementation delegating to the
// Shippo transport (src/shippo.ts). Spec docs/specs/shipping-provider-layer.md
// (THI-1247; parent THI-1244).
//
// Everything Shippo-specific that is not wire transport lives here: status
// normalization (§ mapping table), webhook parse + F6 redaction, dedupe, the
// synthesized tracker id, and address verification with the spec's 6-row
// outcome mapping. Under no configuration does this adapter change existing
// deployments: SHIPPING_PROVIDER must be explicitly set to "shippo"
// (test-mode first) — the default stays easypost, byte-identical.

import crypto from "node:crypto";
import { envValue } from "../config.js";
import {
  buyShippoLabel,
  createShippoShipment,
  createShippoTracker,
  isPickupPointOnlyRate,
  shippoTrackerId,
  SHIPPO_SIG_HEADER,
  validateShippoAddressRaw,
  verifyShippoSignature,
  withSenderContact,
} from "../shippo.js";
import {
  providerApiKeyEnv,
  providerWebhookSecretEnv,
  VerificationError,
  WebhookParseError,
  type NormalizedStatus,
  type BoughtLabel,
  type ProviderAddress,
  type ProviderAddressVerification,
  type ProviderShipment,
  type ProviderShipmentInput,
  type RedactedCarrierEvent,
  type ShippingProvider,
  type TrackerRef,
} from "./provider.js";

/** Shippo tracker statuses → normalized (§ mapping table). Substatus picks:
 *  `out_for_delivery` and `pickup_available` both land in out_for_delivery
 *  (the latter mirrors EasyPost `available_for_pickup` → #10). Status-level
 *  `cancelled`/`error` and anything unrecognized → unknown — logged, never a
 *  transition. Raw values are compared case-insensitively (wire casing for
 *  status is UPPER, substatus lower). */
const SHIPPO_STATUS_MAP: Readonly<Record<string, NormalizedStatus>> = Object.freeze({
  pre_transit: "pre_transit",
  transit: "in_transit",
  delivered: "delivered",
  returned: "return_to_sender",
  failure: "failure",
  unknown: "unknown",
});

function normalizeStatus(rawStatus: string | undefined, rawSubstatus: string | undefined): NormalizedStatus {
  const status = rawStatus?.toLowerCase();
  const substatus = rawSubstatus?.toLowerCase();
  if (status === "transit" && (substatus === "out_for_delivery" || substatus === "pickup_available")) {
    return "out_for_delivery";
  }
  return (status && SHIPPO_STATUS_MAP[status]) || "unknown";
}

export interface ShippoWebhookPayload {
  event?: string;
  test?: boolean;
  data?: {
    carrier?: string;
    tracking_number?: string;
    tracking_status?: {
      status?: string;
      substatus?: string;
      status_date?: string;
    };
    // address_from/to, tracking_history, messages[], metadata are present on
    // the wire but NEVER read below — F6 redaction at parse (see parseWebhook).
  };
}

export class ShippoShippingProvider implements ShippingProvider {
  readonly id = "shippo" as const;
  readonly displayName = "Shippo";

  /** Webhook secrets are cfg-injected by the registry (the ingest route runs
   *  with the deployment's config, tests inject their own). Label/tracker/
   *  verification calls read SHIPPO_API_KEY through the transport exactly as
   *  the EasyPost adapter reads its key. */
  private readonly webhookSecret: string | undefined;
  private readonly webhookSecretPrevious: string | undefined;

  constructor(secrets: { webhookSecret?: string; webhookSecretPrevious?: string } = {}) {
    this.webhookSecret = secrets.webhookSecret;
    this.webhookSecretPrevious = secrets.webhookSecretPrevious;
  }

  isConfigured(): boolean {
    return envValue(providerApiKeyEnv(this.id)) !== undefined;
  }

  async createShipment(input: ProviderShipmentInput, signal?: AbortSignal): Promise<ProviderShipment | null> {
    // Sender-of-record contact (THI-1827): USPS refuses the purchase
    // (`sender_info_missing`) unless address_from carries the sender's email
    // + phone, and the buyer-paid path buys against the quote-time rate — so
    // the contact must ride on the shipment at creation. The EasyPost
    // adapter ignores the same field, keeping its wire byte-identical.
    const shipment = await createShippoShipment(
      { ...input, fromAddress: withSenderContact(input.fromAddress, input.senderContact) },
      {},
      signal,
    );
    if (!shipment) return null;
    // Quote-time filter (THI-1827): pickup-point-only services are quotable
    // to a home address but unbuyable without a pickup-point selection this
    // product does not offer — drop them so no offered rate can fail at
    // purchase (see isPickupPointOnlyRate).
    const rates = shipment.rates.filter((r) => !isPickupPointOnlyRate(r));
    return { shipmentId: shipment.id, rates };
  }

  buyLabel(shipmentId: string, rateId: string): Promise<BoughtLabel | null> {
    return buyShippoLabel(shipmentId, rateId);
  }

  /** metadata IS supported by Shippo (provider-native correlation echo) —
   *  forwarded verbatim; the caller passes "thingery:{order_id}". */
  registerTracker(carrier: string, trackingCode: string, metadata?: string): Promise<TrackerRef | null> {
    return createShippoTracker(carrier, trackingCode, metadata);
  }

  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): void {
    const signature = headers[SHIPPO_SIG_HEADER];
    if (typeof signature !== "string") {
      throw new VerificationError(`missing ${SHIPPO_SIG_HEADER} header`);
    }
    if (this.webhookSecret === undefined) {
      // Unreachable via the route (it 503s on !carrierWebhookReady first);
      // fail-closed anyway rather than verify against an empty secret.
      throw new VerificationError("carrier webhook secret not configured", "signature verification failed");
    }
    const verifiedCurrent = verifyShippoSignature(raw, signature, this.webhookSecret);
    const verifiedPrevious =
      !verifiedCurrent &&
      this.webhookSecretPrevious !== undefined &&
      verifyShippoSignature(raw, signature, this.webhookSecretPrevious);
    if (verifiedPrevious) {
      console.warn(
        `[webhooks:carrier] verified with ${providerWebhookSecretEnv(this.id)}_PREVIOUS — finish the rotation`,
      );
    }
    if (!verifiedCurrent && !verifiedPrevious) {
      throw new VerificationError("signature verification failed");
    }
  }

  parseWebhook(raw: Buffer): RedactedCarrierEvent {
    let parsed: ShippoWebhookPayload;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as ShippoWebhookPayload;
    } catch {
      // Invalid JSON with a valid signature is still a 400 — nothing was
      // verifiable content (same response the route has always given).
      throw new WebhookParseError("invalid JSON body");
    }

    // F6: REDACT at parse — data.address_from/to, tracking_history,
    // messages[] and metadata never leave this function; only ids, statuses
    // and the timestamp survive. tracker_id is the SYNTHESIZED id
    // (shippoTrackerId) — computed identically at label purchase and
    // registration, so orders.tracker_id resolution (F4) works with no
    // provider tracker object.
    const data = typeof parsed.data === "object" && parsed.data !== null ? parsed.data : undefined;
    const carrier = typeof data?.carrier === "string" ? data.carrier : null;
    const trackingCode = typeof data?.tracking_number === "string" ? data.tracking_number : null;
    const status = data?.tracking_status;
    return {
      description: null, // the wire has no description field — nothing fabricated
      mode: parsed.test === true ? "test" : parsed.test === false ? "production" : null,
      tracker_id: carrier && trackingCode ? shippoTrackerId(carrier, trackingCode) : null,
      tracking_code: trackingCode,
      carrier,
      carrier_status: typeof status?.status === "string" ? status.status : null,
      // No tracking_status (or no status string in it) → null: no info at all
      // is not "unknown" — an unrecognized status STRING maps to unknown.
      status: typeof status?.status === "string" ? normalizeStatus(status.status, status.substatus) : null,
      occurred_at: typeof status?.status_date === "string" ? status.status_date : null,
    };
  }

  dedupeId(raw: Buffer): string {
    // track_updated carries no per-delivery event id and Shippo documents
    // that tracking webhooks are not idempotent — dedupe on the raw bytes'
    // sha256; a byte-identical redelivery dedupes to one row, any content
    // change is a new event (transition guard no-ops).
    return `${this.id}:${crypto.createHash("sha256").update(raw).digest("hex")}`;
  }

  /** Verification is part of the one-provider surface: the same SHIPPO_API_KEY
   *  covers labels, tracking and address validation (no second provider, no
   *  second key). */
  readonly supportsAddressVerification = true;

  async verifyAddress(input: ProviderAddress, signal?: AbortSignal): Promise<ProviderAddressVerification | null> {
    if (!this.isConfigured()) return null;
    const body = await validateShippoAddressRaw(
      {
        // The typed address fields only — the name is never sent (the wire
        // contract's data-minimisation rule; see src/shippo.ts header).
        line1: input.line1,
        ...(input.line2 !== undefined ? { line2: input.line2 } : {}),
        city: input.city,
        postalCode: input.postalCode,
        country: input.country,
      },
      {},
      signal,
    );
    return mapShippoValidation(body, input);
  }
}

// --- The 6-row outcome mapping (spec table; explicit transitions, no
// undefined cases) ----------------------------------------------------------

/** Attribute names the wire uses for street/city/postal corrections (every
 *  spelling in the recorded live evidence; case-sensitive as recorded). */
const ELIGIBLE_CHANGE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "street",
  "street1",
  "street2",
  "city",
  "postal",
  "postal_code",
  "zip_code",
]);

/** The province-only attribute: a `state_province`-only correction is not a
 *  buyer-facing suggestion (row 2 — the address is deliverable as typed). */
const PROVINCE_ATTRIBUTE = "state_province";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;

/** Confidence score of the recommendation — `recommended_address` carries its
 *  own confidence_result; the analysis/root fallbacks absorb the recorded
 *  evidence's nesting ambiguity (spec wire-name freeze: provisioning confirms
 *  exact nesting before production activation). */
function confidenceScore(body: Record<string, unknown>, recommended: Record<string, unknown> | undefined): string | undefined {
  const inRecommended = obj(recommended?.confidence_result);
  const inAnalysis = obj(obj(body.analysis)?.confidence_result);
  const inRoot = obj(body.confidence_result);
  for (const source of [inRecommended, inAnalysis, inRoot]) {
    const score = str(source?.score);
    if (score === "high" || score === "medium" || score === "low") return score;
  }
  return undefined;
}

/** changed_attributes — analysis-scoped per the recorded wire contract, with
 *  the root-level fallback for the same freeze reason as the score. */
function changedAttributes(body: Record<string, unknown>): string[] {
  const analysis = obj(body.analysis);
  const list = Array.isArray(analysis?.changed_attributes)
    ? analysis?.changed_attributes
    : Array.isArray(body.changed_attributes)
      ? body.changed_attributes
      : [];
  return list.filter((v): v is string => typeof v === "string");
}

/** Maps the raw validate response onto a ProviderAddress suggestion. The
 *  caller's name is carried (the wire has no name field — same rule as the
 *  Sendcloud mapper). Returns null when required fields are missing/malformed
 *  (the mapping treats that as no usable suggestion). */
function suggestionFromWire(raw: Record<string, unknown>, input: ProviderAddress): ProviderAddress | null {
  const line1 = str(raw.street1);
  const city = str(raw.city);
  const zip = str(raw.zip_code);
  const country = str(raw.country);
  if (!line1 || !city || !zip || !country) return null;
  const line2 = str(raw.street2);
  return {
    name: input.name,
    line1,
    ...(line2 !== undefined ? { line2 } : {}),
    city,
    postalCode: zip,
    country,
  };
}

/**
 * The 6-row mapping (spec table; evaluated top-down, first match wins):
 *   1. valid                                          → verified
 *   2. partially_valid, province-only correction      → verified
 *   3. partially_valid, eligible change + high score  → suggested
 *   4. partially_valid, low/medium score              → unverified
 *                                                     + shippo_address_low_confidence
 *   5. invalid                                        → unverified
 *                                                     + shippo_address_invalid
 *   6. anything else (missing/unmappable analysis)    → unverified (no reason)
 * Faults (network/HTTP/timeout/malformed JSON) THROW from the transport —
 * the callers map any throw to not_checked (failure-open invariant).
 */
function mapShippoValidation(body: Record<string, unknown>, input: ProviderAddress): ProviderAddressVerification {
  const analysis = obj(body.analysis);
  const value = str(obj(analysis?.validation_result)?.value);
  const changed = changedAttributes(body);
  const recommended = obj(body.recommended_address) ?? obj(analysis?.recommended_address);

  if (value === "valid") return { status: "verified" }; // row 1

  if (value === "partially_valid") {
    if (changed.length > 0 && changed.every((c) => c === PROVINCE_ATTRIBUTE)) {
      return { status: "verified" }; // row 2 — province-only is not a suggestion
    }
    const score = confidenceScore(body, recommended);
    if (changed.some((c) => ELIGIBLE_CHANGE_ATTRIBUTES.has(c)) && score === "high") {
      // row 3 — a high-confidence correction is a suggestion candidate. The
      // callers F2-re-validate and downgrade identical-to-input mappings.
      const suggestion = recommended ? suggestionFromWire(recommended, input) : null;
      if (suggestion) return { status: "suggested", suggestion };
    }
    if (score === "low" || score === "medium") {
      // row 4 — weak confidence: conservative, never a suggestion (the DE
      // evidence's street-typo noise lands here, not in suggested).
      return { status: "unverified", reason: "shippo_address_low_confidence" };
    }
    return { status: "unverified" }; // rows 3/4 misses → row 6
  }

  if (value === "invalid") {
    // row 5 — no suggestion even when recommended_address is present (a
    // false negative must not silently rewrite the address).
    return { status: "unverified", reason: "shippo_address_invalid" };
  }

  return { status: "unverified" }; // row 6 — missing/unmappable analysis
}
