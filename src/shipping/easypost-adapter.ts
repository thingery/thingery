// EasyPost adapter — the ShippingProvider implementation delegating to the
// existing EasyPost transport (src/easypost.ts, unchanged wire behavior).
// Spec docs/specs/shipping-provider-layer.md, THI-1246; parent THI-1244.
//
// Under the default configuration every observable behavior is byte-identical
// to the pre-interface code: same HTTP client, auth, error messages
// (EasyPostError subclasses ProviderError), `X-Hmac-Signature` verification
// with NFKD-normalized secrets, status normalization, F6 redaction, and the
// `easypost:<sha256>` dedupe scheme. The adapter owns everything
// EasyPost-specific so the ingest route and service layers stay
// provider-agnostic.

import crypto from "node:crypto";
import { envValue } from "../config.js";
import {
  buyEasyPostLabel,
  createEasyPostShipment,
  createEasyPostTracker,
  verifyEasyPostSignature,
} from "../easypost.js";
import {
  providerApiKeyEnv,
  providerWebhookSecretEnv,
  VerificationError,
  WebhookParseError,
  type NormalizedStatus,
  type BoughtLabel,
  type ProviderAddress,
  type ProviderShipment,
  type ProviderShipmentInput,
  type RedactedCarrierEvent,
  type ShippingProvider,
  type TrackerRef,
} from "./provider.js";

/** EasyPost tracker statuses → normalized (§5.2). `available_for_pickup` is
 *  still pre-delivery (the parcel waits at a location) → out_for_delivery
 *  bucket → #10. Tracker-level `cancelled`/`error` (bad code, not carrier
 *  failure) and anything unrecognized → unknown — logged, never a transition. */
const EASYPOST_STATUS_MAP: Readonly<Record<string, NormalizedStatus>> = Object.freeze({
  pre_transit: "pre_transit",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  available_for_pickup: "out_for_delivery",
  delivered: "delivered",
  return_to_sender: "return_to_sender",
  failure: "failure",
});

function normalizeStatus(raw: string | undefined): NormalizedStatus {
  return (raw && EASYPOST_STATUS_MAP[raw]) || "unknown";
}

const EASYPOST_SIG_HEADER = "x-hmac-signature";

/** EasyPost tracker webhook wire shape (result.tracking_details carries the
 *  free-text/facility details that F6 redaction drops at parse time). */
interface EasyPostTrackingDetail {
  status?: string;
  message?: string;
  datetime?: string;
}

export interface EasyPostWebhookPayload {
  description?: string;
  mode?: string;
  result?: {
    id?: string;
    tracking_code?: string;
    carrier?: string;
    status?: string;
    tracking_details?: EasyPostTrackingDetail[];
  };
}

export class EasyPostShippingProvider implements ShippingProvider {
  readonly id = "easypost" as const;
  readonly displayName = "EasyPost";

  /** Webhook secrets are cfg-injected by the registry (the ingest route runs
   *  with the deployment's config, tests inject their own). Label/tracker
   *  calls read EASYPOST_API_KEY through the transport exactly as before. */
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
    const shipment = await createEasyPostShipment(input, {}, signal);
    return shipment ? { shipmentId: shipment.id, rates: shipment.rates } : null;
  }

  buyLabel(shipmentId: string, rateId: string): Promise<BoughtLabel | null> {
    return buyEasyPostLabel(shipmentId, rateId);
  }

  registerTracker(carrier: string, trackingCode: string, _metadata?: string): Promise<TrackerRef | null> {
    // `_metadata`: EasyPost tracker registration carries no metadata echo —
    // ignored so the wire payload stays exactly what it has always been.
    return createEasyPostTracker(carrier, trackingCode);
  }

  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): void {
    const signature = headers[EASYPOST_SIG_HEADER];
    if (typeof signature !== "string") {
      // Same header name and message the route has always answered with.
      throw new VerificationError("missing X-Hmac-Signature header");
    }
    if (this.webhookSecret === undefined) {
      // Unreachable via the route (it 503s on !carrierWebhookReady first);
      // fail-closed anyway rather than verify against an empty secret.
      throw new VerificationError("carrier webhook secret not configured", "signature verification failed");
    }
    const verifiedCurrent = verifyEasyPostSignature(raw, signature, this.webhookSecret);
    const verifiedPrevious =
      !verifiedCurrent &&
      this.webhookSecretPrevious !== undefined &&
      verifyEasyPostSignature(raw, signature, this.webhookSecretPrevious);
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
    let parsed: EasyPostWebhookPayload;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as EasyPostWebhookPayload;
    } catch {
      // Invalid JSON with a valid signature is still a 400 — nothing was
      // verifiable content (same response the route has always given).
      throw new WebhookParseError("invalid JSON body");
    }

    // F6: REDACT at parse — tracking_details (signed-for names, facility
    // free text) never leave this function; only ids, statuses, timestamps.
    const result = parsed.result;
    const lastDetail = Array.isArray(result?.tracking_details) ? result.tracking_details.at(-1) : undefined;
    return {
      description: typeof parsed.description === "string" ? parsed.description : null,
      mode: parsed.mode === "test" || parsed.mode === "production" ? parsed.mode : null,
      tracker_id: typeof result?.id === "string" ? result.id : null,
      tracking_code: typeof result?.tracking_code === "string" ? result.tracking_code : null,
      carrier: typeof result?.carrier === "string" ? result.carrier : null,
      carrier_status: typeof result?.status === "string" ? result.status : null,
      status: result ? normalizeStatus(result.status) : null,
      occurred_at: typeof lastDetail?.datetime === "string" ? lastDetail.datetime : null,
    };
  }

  dedupeId(raw: Buffer): string {
    // EasyPost tracker webhooks carry no per-delivery event id, so dedupe on
    // the raw bytes' sha256 — a byte-identical redelivery dedupes to one
    // row; any content change is a new event (transition guard no-ops).
    return `${this.id}:${crypto.createHash("sha256").update(raw).digest("hex")}`;
  }

  /** No verification capability in scope (amended spec): verification under
   *  a default/easypost deployment is `not_checked` — identical to today's
   *  behavior for deployments without a Sendcloud key (the feature shipped
   *  dark; no live Sendcloud account exists). The services pre-check the
   *  flag BEFORE caps, so no budget is ever consumed on this path. */
  readonly supportsAddressVerification = false;

  verifyAddress(_input: ProviderAddress, _signal?: AbortSignal): Promise<null> {
    return Promise.resolve(null);
  }
}
