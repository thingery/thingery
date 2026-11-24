// Buyer-paid shipping — quoting core (spec docs/specs/buyer-paid-shipping.md
// §1 funding modes, §2 quote lifecycle, data model; build PR 1 of 5).
//
// PR 1 is the core only: mode resolution, quote creation, and the snapshot
// type. Nothing calls this yet (createOrder integration is PR 2) — no
// behavior change ships in this PR beyond the additive schema column, the two
// env knobs, and the AbortSignal plumbing in src/easypost.ts (C3).
//
// Invariants this module owns (spec):
//  - Mode resolution is a pure fall-through: every unmet condition drops the
//    order to flat mode with a reason; quoting can never fail an order.
//  - Quote mode is EUR-only (order currency and rate currency) and the
//    cheapest EUR rate must sit under the per-label cap (LABEL_MAX_COST_CENTS,
//    the same A1 cap label purchase enforces).
//  - The snapshot — never client input — is the single source of truth: one
//    JSONB row, mirroring the label_purchase precedent. Quote shipment inputs
//    are built from exactly the snapshotted fields so a later re-quote (§5)
//    reproduces the same shipment from the row alone.
//  - The quote call is bounded: AbortSignal.timeout(SHIPPING_QUOTE_TIMEOUT_MS)
//    rides into the actual fetch (C3), so a hanging provider can never hold
//    the caller's transaction, row lock, or pool client.

import { pool } from "./db.js";
import { orderFlowConfig } from "./config.js";
import { createEasyPostShipment, type EasyPostRate } from "./easypost.js";
import { getShippingProvider } from "./shipping/registry.js";
import { pickRate, type ProviderAddress, type ShippingProvider, type ShippingProviderId } from "./shipping/provider.js";

/** Quote mode is EUR-only (spec §1): rates are selected and stored in the
 *  account base currency so every amount_cents is comparable by plain
 *  integer — same fail-securely rule as label purchase (LABEL_BASE_CURRENCY). */
export const SHIPPING_QUOTE_CURRENCY = "EUR";

/** The address shape carried inside the label_quote snapshot (spec §2): the
 *  five fields a carrier needs, snake_case like orders.shipping_address.
 *  Phone is deliberately absent — the snapshot must fully determine the
 *  shipment (§5.3 re-quote), so the quote is computed from these fields
 *  alone and nothing else rides in from the order row. */
export interface QuoteAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  postal_code: string;
  country: string;
}

/** The persisted orders.label_quote snapshot (spec data model). line_refund_id
 *  / line_refunded_at are absent until the own-label partial refund fires
 *  (§6) — they are written once, in the same commit as the Stripe refund, and
 *  are the durable settle-awareness state refundCents reads. */
export interface LabelQuoteSnapshot {
  shipment_id: string;
  rate_id: string;
  carrier: string;
  service: string;
  amount_cents: number;
  currency: string; // always EUR (quote mode requires it)
  weight_grams: number;
  dimensions_mm: string | null;
  origin: QuoteAddress; // seller's default saved address at quote time
  destination: QuoteAddress; // buyer address quoted for; == shipping_address at creation (§5.3 re-check)
  quoted_at: string; // ISO UTC
  line_refund_id?: string;
  line_refunded_at?: string;
}

/** Why an order fell back to flat mode (spec §1 fall-through). These are the
 *  label_quote_fallback event reasons — amounts and reasons only, never
 *  address data (PII minimization, §8). */
export type ShippingQuoteFallbackReason =
  | "off_platform_payment" // not a Stripe order — off-platform is spec §7 unchanged
  | "not_shippable" // local pickup: nothing to quote
  | `${ShippingProviderId}_not_configured` // degraded/misconfigured deployment — flat mode; under the default provider this is exactly "easypost_not_configured"
  | "no_weight" // listing carries no weight_grams
  | "no_seller_default_address" // seller has no default saved address (or it is incomplete)
  | "non_eur_order" // quote mode is EUR-only
  | "buyer_address_incomplete" // cannot happen via create_order validation; defensive fall-through
  | "quote_failed" // EasyPost error / malformed payload
  | "quote_timeout" // the AbortSignal fired — bounded, never a hang
  | "no_eur_rate" // quote succeeded, no EUR rate returned
  | "rate_above_cap"; // cheapest EUR rate exceeds LABEL_MAX_COST_CENTS

/** The mode decision, fixed once at create_order (spec §1). */
export type ShippingQuoteOutcome =
  | { mode: "label_quote"; quote: LabelQuoteSnapshot }
  | { mode: "flat"; reason: ShippingQuoteFallbackReason };

/** Everything mode resolution needs from the order/listing/config — all
 *  server-authoritative; no client-supplied money, quote ids, or rate ids
 *  enter this path (spec §2 tamper-proofing). */
export interface ShippingQuoteInputs {
  paymentMode: string; // orders.payment_mode
  fulfillment: string; // orders.fulfillment ('shipping' | 'pickup')
  orderCurrency: string; // orders.currency
  weightGrams: number | null; // listing weight_grams
  dimensionsMm: string | null; // listing dimensions_mm ("LxWxH")
  buyerAddress: Record<string, unknown>; // orders.shipping_address (creation-time snapshot)
  sellerOrigin: QuoteAddress | null; // seller default saved address, completeness-checked
  easypostEnabled: boolean; // "a shipping provider is configured" (cfg.shippingEnabled); field name kept for seam stability with existing tests/callers
  labelMaxCostCents: number; // cfg.labelMaxCostCents (A1)
  quoteTimeoutMs: number; // cfg.shippingQuoteTimeoutMs
}

/** Injectable seams (same discipline as the easypost/fulfillment tests:
 *  unit tests stub the provider call; the DB read below is the only sql here).
 *  `provider` overrides the registry-selected provider (tests/future multi-
 *  provider routing); `createShipment` overrides the call seam itself with
 *  the pre-interface signature, which the default now adapts onto the
 *  provider interface — existing stubs keep working unchanged. */
export interface ShippingQuoteDeps {
  createShipment?: typeof createEasyPostShipment;
  provider?: ShippingProvider;
  now?: () => Date;
}

/** Extracts the five snapshot fields from a stored address shape, or null if
 *  any required field is missing/empty — the same completeness rule label
 *  purchase applies before spending (storedAddressToDomain). Pure. */
export function toQuoteAddress(raw: Record<string, unknown>): QuoteAddress | null {
  const str = (k: string): string | undefined => {
    const v = raw[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const name = str("name");
  const line1 = str("line1");
  const line2 = str("line2");
  const city = str("city");
  const postalCode = str("postal_code");
  const country = str("country");
  if (!name || !line1 || !city || !postalCode || !country) return null;
  return { name, line1, ...(line2 ? { line2 } : {}), city, postal_code: postalCode, country };
}

/** "300x200x150" → "300x200x150" (validated); anything unparsable → null —
 *  the quote simply omits dimensions, same as a listing without them. */
function normalizedDimensionsMm(raw: string | null | undefined): string | null {
  const m = /^(\d+)x(\d+)x(\d+)$/.exec(raw?.trim() ?? "");
  if (!m) return null;
  const [l, w, h] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return l > 0 && w > 0 && h > 0 ? `${l}x${w}x${h}` : null;
}

/** Parses a stored "LxWxH" string into the easypost client's metric shape. */
function dimensionsToMm(raw: string): { length: number; width: number; height: number } | undefined {
  const m = /^(\d+)x(\d+)x(\d+)$/.exec(raw);
  if (!m) return undefined;
  const dims = { length: Number(m[1]), width: Number(m[2]), height: Number(m[3]) };
  return dims.length > 0 && dims.width > 0 && dims.height > 0 ? dims : undefined;
}

/** Snapshot address → the easypost client's domain shape (postal_code →
 *  postalCode). Pure; the only place the two shapes meet. */
function toProviderAddress(a: QuoteAddress): ProviderAddress {
  return {
    name: a.name,
    line1: a.line1,
    ...(a.line2 ? { line2: a.line2 } : {}),
    city: a.city,
    postalCode: a.postal_code,
    country: a.country,
  };
}

/** Cheapest EUR rate from a quote — the selection the buyer pays for and the
 *  label is later bought against. Non-EUR rates are never selectable (spec
 *  §3); reuse of the provider-independent rate picker on the EUR-filtered
 *  list. Pure. */
export function selectQuoteRate(rates: readonly EasyPostRate[]): EasyPostRate | null {
  return pickRate(rates.filter((r) => r.currency === SHIPPING_QUOTE_CURRENCY));
}

/**
 * Resolves the funding mode and, in label-quote mode, produces the snapshot
 * to persist on the order (spec §1–§2). Pure fall-through: every unmet
 * condition returns { mode: "flat", reason } — this function never throws for
 * an unquotable order; only a genuinely exceptional code bug escapes, and the
 * caller (PR 2) still treats a throw as flat-mode fallback (quoting can never
 * fail an order). The provider call is bounded by inputs.quoteTimeoutMs via
 * an AbortSignal that rides into the actual fetch (C3).
 */
export async function resolveShippingQuote(
  inputs: ShippingQuoteInputs,
  deps: ShippingQuoteDeps = {},
): Promise<ShippingQuoteOutcome> {
  // Provider-selected at call time from the deployment config (THI-1246);
  // the provider id prefixes the not_configured reason, so default
  // deployments emit the exact strings they always have.
  const provider = deps.provider ?? getShippingProvider(orderFlowConfig());
  const createShipment: typeof createEasyPostShipment =
    deps.createShipment ??
    (async (input, _opts, signal) => {
      const shipment = await provider.createShipment(input, signal);
      return shipment ? { id: shipment.shipmentId, rates: shipment.rates } : null;
    });
  const fallback = (reason: ShippingQuoteFallbackReason): ShippingQuoteOutcome => ({ mode: "flat", reason });

  if (inputs.paymentMode !== "stripe") return fallback("off_platform_payment");
  if (inputs.fulfillment !== "shipping") return fallback("not_shippable");
  if (!inputs.easypostEnabled) return fallback(`${provider.id}_not_configured`);
  if (!(typeof inputs.weightGrams === "number" && inputs.weightGrams > 0)) return fallback("no_weight");
  if (!inputs.sellerOrigin) return fallback("no_seller_default_address");
  if (inputs.orderCurrency !== SHIPPING_QUOTE_CURRENCY) return fallback("non_eur_order");

  const destination = toQuoteAddress(inputs.buyerAddress);
  if (!destination) return fallback("buyer_address_incomplete");

  const dimensionsMm = normalizedDimensionsMm(inputs.dimensionsMm);
  const weightGrams = inputs.weightGrams;

  let shipmentId: string;
  let rates: readonly EasyPostRate[];
  try {
    const shipment = await createShipment(
      {
        // Built from exactly the snapshotted fields (spec §2): origin and
        // destination as stored, the listing's parcel. Nothing else rides in
        // from the order row — a §5 re-quote from the snapshot reproduces
        // this call byte-for-byte.
        toAddress: toProviderAddress(destination),
        fromAddress: toProviderAddress(inputs.sellerOrigin),
        weightGrams,
        ...(dimensionsMm ? { dimensionsMm: dimensionsToMm(dimensionsMm) } : {}),
      },
      {},
      AbortSignal.timeout(inputs.quoteTimeoutMs), // C3: bounded, rides into the fetch
    );
    if (!shipment) return fallback(`${provider.id}_not_configured`); // key vanished between cfg read and call — flat
    shipmentId = shipment.id;
    rates = shipment.rates;
  } catch (err) {
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      return fallback("quote_timeout");
    }
    return fallback("quote_failed");
  }

  const rate = selectQuoteRate(rates);
  if (!rate) return fallback("no_eur_rate");
  if (rate.costCents > inputs.labelMaxCostCents) return fallback("rate_above_cap");

  return {
    mode: "label_quote",
    quote: {
      shipment_id: shipmentId,
      rate_id: rate.id,
      carrier: rate.carrier,
      service: rate.service,
      amount_cents: rate.costCents,
      currency: rate.currency,
      weight_grams: weightGrams,
      dimensions_mm: dimensionsMm,
      origin: inputs.sellerOrigin,
      destination,
      quoted_at: (deps.now ? deps.now() : new Date()).toISOString(),
    },
  };
}

/** The quote origin (spec §1): the seller's default saved address
 *  (account_addresses.is_default — the saved-addresses store anticipated this
 *  reuse; no new address storage). Returns null when the seller has no
 *  default or it fails the completeness check labels use — the caller
 *  resolves flat mode. Owner-scoped read: `sellerAccountId` is the item
 *  seller's account, read server-side at create_order. */
export async function getSellerDefaultOrigin(sellerAccountId: string): Promise<QuoteAddress | null> {
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT name, line1, line2, city, postal_code, country
       FROM account_addresses
      WHERE account_id = $1 AND is_default`,
    [sellerAccountId],
  );
  return rows.length > 0 ? toQuoteAddress(rows[0]) : null;
}
