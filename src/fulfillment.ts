// Fulfillment + dispute tools (spec THI-3 rev 2 §4.2/§5.2 + rev 3 §11.2; PR-5).
//
// record_tracking (#5/#23), confirm_payment (#24), confirm_receipt (#6/#13),
// open_dispute (#15), release_funds (#17/#17b), buy_shipping_label (#5b —
// label-purchase spec). All state changes go through
// the PR-2 transition core (src/orders.ts). Money only moves on
// release_funds (stripe mode): transition first (the conditional UPDATE
// guarantees we exclusively hold delivered → payout_pending — a racing
// chargeback #22 loses), then transfers.create under the payout:{order_id}
// idempotency key (F3). If the Stripe call fails after the transition the
// order sits in payout_pending with no transfer_id — surfaced to the caller
// and reconciled later by the PR-8 sweep with the same idempotency key.

import { pool } from "./db.js";
import type { OrderRow } from "./orders.js";
import { applyTransition, transitionsFrom, IllegalTransitionError } from "./orders.js";
import { orderFlowConfig } from "./config.js";
import {
  ProviderError,
  pickRate,
  providerApiKeyEnv,
  type BoughtLabel,
  type ProviderAddress,
  type ProviderShipment,
  type ShippingProvider,
  type ShipmentRate,
} from "./shipping/provider.js";
import { OrderFlowError } from "./order-flow.js";
import { shippingAddressForSeller } from "./order-flow.js";
import { createTransferForOrder, getStripe } from "./stripe.js";
import { createEasyPostTracker } from "./easypost.js";
// THI-1246: the provider transport is reached only via the ShippingProvider
// interface (src/shipping/registry.ts → src/shipping/provider.ts); easypost.ts
// keeps the EasyPost wire details.

import { getShippingProvider } from "./shipping/registry.js";
import type { LabelQuoteSnapshot, QuoteAddress } from "./shipping-quotes.js";
import { logSecurityEvent } from "./security-events.js";

export { OrderFlowError };

/** Loads the order; outsiders (and wrong ids) get not_found — no leak. */
async function partyOrder(orderId: string, actorId: string, mustBe: "buyer" | "seller"): Promise<OrderRow> {
  const { rows } = await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [orderId]);
  const order = rows[0];
  if (!order) throw new OrderFlowError("not_found", "Order not found.");
  if (mustBe === "buyer" && order.buyer_id !== actorId) {
    throw new OrderFlowError("not_found", "Order not found.");
  }
  if (mustBe === "seller" && order.seller_id !== actorId) {
    throw new OrderFlowError("not_found", "Order not found.");
  }
  return order;
}

function rethrow(err: unknown): never {
  if (err instanceof IllegalTransitionError) {
    throw new OrderFlowError("invalid_transition", err.message);
  }
  throw err;
}

export interface RecordTrackingInput {
  carrier: string;
  trackingCode: string;
  labelUrl?: string;
}

/**
 * §6 unused-quote refund: on a quote-mode order where the seller ships with
 * their own label (record_tracking, no platform label bought), the buyer's
 * label line goes back immediately as a partial refund under
 * `labelrefund:{order_id}` — retrieve-before-create via the idempotency key —
 * with line_refund_id + line_refunded_at persisted in the same step and a
 * `label_line_refunded` event. Shared with the sweep retry rule: a transient
 * failure (or a crash between the Stripe call and the commit) leaves the row
 * with tracking recorded, label_purchase absent and line_refund_id null —
 * exactly the states the sweep retries.
 */
export async function refundLabelLineForOrder(order: OrderRow): Promise<string> {
  const quote = order.label_quote as LabelQuoteSnapshot | null;
  if (!quote || quote.line_refund_id) throw new Error("inconsistent_state: label line refund already fired or no quote");
  const stripe = getStripe();
  if (!stripe || !order.payment_intent_id) throw new Error("payments_not_configured");
  const refund = await stripe.refunds.create(
    { payment_intent: order.payment_intent_id, amount: quote.amount_cents },
    { idempotencyKey: `labelrefund:${order.id}` },
  );
  await pool.query(
    `UPDATE orders SET label_quote = label_quote || $2::jsonb, updated_at = now()
      WHERE id = $1 AND label_quote->>'line_refund_id' IS NULL`,
    [order.id, JSON.stringify({ line_refund_id: refund.id, line_refunded_at: new Date().toISOString() })],
  );
  await pool.query(
    `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload)
     VALUES ($1, 'label_line_refunded', 'system', NULL, 'own label recorded — unused buyer shipping line refunded', $2::jsonb)`,
    [order.id, JSON.stringify({ refund_id: refund.id, amount_cents: quote.amount_cents, currency: quote.currency })],
  );
  return refund.id;
}

/**
 * Seller records tracking (#5 sold → label_issued, shipping only) or
 * corrects it pre-transit (#23 — not a state change: fields replaced and
 * logged as an event while still label_issued). Registers a carrier tracker
 * via the deployment's shipping provider when configured (best-effort —
 * failures are event-logged, the order still advances; the carrier only
 * automates). Disabled/missing provider ⇒ stored-without-automation, as in
 * the pre-interface degraded mode.
 */
export async function recordTracking(
  orderId: string,
  sellerId: string,
  input: RecordTrackingInput,
): Promise<{ order: OrderRow; trackerRegistered: boolean; note?: string }> {
  const order = await partyOrder(orderId, sellerId, "seller");

  let trackerId: string | null = null;
  let trackerRegistered = false;
  let note: string | undefined;
  try {
    const cfg = orderFlowConfig();
    const provider = getShippingProvider(cfg);
    const tracker = cfg.shippingEnabled
      ? await provider.registerTracker(input.carrier, input.trackingCode, `thingery:${orderId}`)
      : null;
    if (tracker) {
      trackerId = tracker.id;
      trackerRegistered = true;
    }
  } catch (err) {
    await pool.query(
      `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload)
       VALUES ($1, 'tracker_registration_failed', 'system', NULL, $2, $3::jsonb)`,
      [orderId, (err as Error).message, JSON.stringify({ carrier: input.carrier })],
    );
    note = "Tracking stored, but carrier tracker registration failed — retry with a corrected record_tracking call.";
  }

  const sets = {
    carrier: input.carrier,
    tracking_code: input.trackingCode,
    ...(trackerId ? { tracker_id: trackerId } : {}),
    ...(input.labelUrl ? { label_url: input.labelUrl } : {}),
  };

  if (order.status === "label_issued") {
    // #23 — correction, not a transition (§2.3): replace tracking fields
    // while still pre-transit and log it; never move the state machine.
    const { rows } = await pool.query<OrderRow>(
      `UPDATE orders SET carrier = $2, tracking_code = $3,
         tracker_id = $4, label_url = COALESCE($5, label_url), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [orderId, input.carrier, input.trackingCode, trackerId, input.labelUrl ?? null],
    );
    await pool.query(
      `INSERT INTO order_events (order_id, event_type, from_status, to_status, actor_type, actor_id, reason, payload)
       VALUES ($1, 'tracking_corrected', 'label_issued', 'label_issued', 'seller', $2, 'record_tracking #23', $3::jsonb)`,
      [orderId, sellerId, JSON.stringify({ carrier: input.carrier, tracking_code: input.trackingCode })],
    );
    return { order: rows[0], trackerRegistered, note };
  }

  if (order.fulfillment !== "shipping") {
    throw new OrderFlowError(
      "fulfillment_mismatch",
      "This is a local-pickup order — there is nothing to ship. Use confirm_receipt when the buyer collects.",
    );
  }
  try {
    const next = await applyTransition({
      orderId,
      trigger: "record_tracking",
      actor: { type: "seller", id: sellerId },
      reason: `carrier ${input.carrier}, code ${input.trackingCode}`,
      sets,
    });
    // §6 unused-quote refund: the seller shipped with their own label on a
    // quote-mode order — the buyer's label line bought no label and goes back
    // now. Best-effort here (the order already advanced); the sweep retries.
    if (
      order.label_quote &&
      !order.label_purchase &&
      !order.label_quote.line_refund_id &&
      order.payment_mode === "stripe" &&
      order.payment_intent_id
    ) {
      try {
        await refundLabelLineForOrder(order);
        return {
          order: next,
          trackerRegistered,
          note: `${note ?? ""}Tracking recorded. The buyer's unused shipping line (€${(order.label_quote.amount_cents / 100).toFixed(2)}) was refunded.`.trim(),
        };
      } catch (err) {
        console.error(`[record_tracking] label line refund failed for order ${order.id} (sweep will retry):`, err);
        return {
          order: next,
          trackerRegistered,
          note: `${note ?? ""}Tracking recorded. The buyer's unused shipping-line refund is pending and will be retried automatically.`.trim(),
        };
      }
    }
    return { order: next, trackerRegistered, note };
  } catch (err) {
    return rethrow(err);
  }
}

// ---------------------------------------------------------------------------
// buy_shipping_label (spec docs/specs/label-purchase.md, THI-562 work item 2;
// THI-568 PR-B). The platform buys the seller's label on its own EasyPost
// account (Thingery-borne cost) and moves the order sold → label_issued via
// transition #5b in the SAME transaction as the persisted snapshot.
//
// Spend is bounded three ways, all enforced here BEFORE the single /buy call:
//   1. per-seller quota  — seller_label_quota, 10/day, atomic upsert-increment
//      (mirrors seller_upload_quota; consumed pre-spend, fail-closed);
//   2. A1 per-label cap  — chosen rate ≤ LABEL_MAX_COST_CENTS (default €30);
//   3. A2 daily budget   — today's persisted spend + rate ≤
//      LABEL_DAILY_BUDGET_CENTS (default €200; 0 = kill switch), derived from
//      label_purchase rows so no secondary counter can drift. Every refusal
//      while over budget emits a label_budget_exceeded security event.
//
// Blast radius (spec): the EasyPost /buy call precedes the status CAS. If the
// order left `sold` first (cancel race), the CAS loses, the label stays
// orphaned at EasyPost, and a label_bought_orphan security event carries the
// order + shipment ids into the operator's reconcile runbook (spec A3).
// ---------------------------------------------------------------------------

/** Per-seller daily label purchases (spec: quota mirrors seller_upload_quota). */
export const MAX_LABELS_PER_SELLER_PER_DAY = 10;

/** Rates are only selectable in the EasyPost account base currency (spec §3:
 *  non-base-currency rates are skipped at selection so every stored cost_cents
 *  is comparable by plain integer — fail-securely). */
const LABEL_BASE_CURRENCY = "EUR";

/** The persisted orders.label_purchase snapshot (spec data model). */
export interface LabelPurchaseSnapshot {
  shipment_id: string;
  rate_id: string;
  carrier: string;
  service: string;
  cost_cents: number;
  currency: string;
  bought_at: string; // ISO UTC — the A2 daily-budget aggregation key
}

export interface BuyShippingLabelInput {
  /** Seller's from address — zod-validated at the tool layer (F16 parity with
   *  the buyer address); never persisted (spec YAGNI, per-call). */
  fromAddress: ProviderAddress;
  weightGrams?: number; // default: the item's listing estimate, else required
  dimensionsMm?: { length: number; width: number; height: number }; // default: the item's
  carrierPreference?: string; // optional carrier name substring, e.g. "DHL"
}

export interface BuyShippingLabelResult {
  order: OrderRow;
  label: { label_url: string; carrier: string; tracking_code: string; cost: string };
  note?: string;
}

/** §5 remedy set — the message every quote-mode rate/guard refusal names:
 *  retry later, cancel for a full refund, or ship own-label (line refunded). */
const QUOTE_MODE_REMEDIES =
  "Retry later (rates drift), cancel the order for a full refund (no label was bought), or ship with your own label via record_tracking (the buyer's shipping line is then refunded).";

function labelCost(costCents: number, currency: string): string {
  return `${currency} ${(costCents / 100).toFixed(2)}`;
}

/** "300x200x150" → {300,200,150}; anything unparsable → undefined (the rate
 *  quote simply omits dimensions — same as a listing without them). */
function parseDimensionsMm(raw: string | null | undefined): { length: number; width: number; height: number } | undefined {
  const m = /^(\d+)x(\d+)x(\d+)$/.exec(raw?.trim() ?? "");
  if (!m) return undefined;
  const [length, width, height] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return length > 0 && width > 0 && height > 0 ? { length, width, height } : undefined;
}

/** orders.shipping_address (wire/storage shape) → the client's domain shape. */
function storedAddressToDomain(a: Record<string, unknown>): ProviderAddress {
  const str = (k: string): string | undefined => (typeof a[k] === "string" && (a[k] as string).length > 0 ? (a[k] as string) : undefined);
  const name = str("name");
  const line1 = str("line1");
  const city = str("city");
  const postalCode = str("postal_code");
  const country = str("country");
  if (!name || !line1 || !city || !postalCode || !country) {
    throw new OrderFlowError("inconsistent_state", "Stored shipping address is incomplete; refusing to buy a label against it.");
  }
  return {
    name,
    line1,
    ...(str("line2") ? { line2: str("line2") } : {}),
    city,
    postalCode,
    country,
    ...(str("phone") ? { phone: str("phone") } : {}),
  };
}

/** A2: the platform's persisted label spend for the current UTC day, derived
 *  from label_purchase rows (the source of truth — replay-safe, no drift).
 *  bought_at is always ISO UTC, so its 10-char date prefix IS the UTC date. */
async function todayLabelSpendCents(): Promise<number> {
  const { rows } = await pool.query<{ cents: number }>(
    `SELECT COALESCE(SUM((label_purchase->>'cost_cents')::int), 0) AS cents
       FROM orders
      WHERE label_purchase IS NOT NULL
        AND left(label_purchase->>'bought_at', 10) = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD')`,
  );
  // SUM() is bigint — node-pg hands those back as strings; coerce here so
  // every caller (and the security-event payload) carries a real number.
  return Number(rows[0].cents);
}

function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

// ---------------------------------------------------------------------------
// Buyer-paid label quote mode (spec docs/specs/buyer-paid-shipping.md §5).
// The buyer paid the label line at checkout; the purchase buys against that
// paid amount — never more (rate-up rule), never re-resolved from editable
// account data (snapshot-only re-quote), never against a mutated address
// (destination invariant). Guards still bound every purchase on the actual
// rate (§5.5).
// ---------------------------------------------------------------------------

/** QuoteAddress (snapshot) → the provider's domain shape — the only mapping
 *  used on the quote-mode paths so the snapshot fully determines the
 *  shipment (§5.3: re-quote never reads re-resolved account data). */
function quoteAddressToDomain(a: QuoteAddress): ProviderAddress {
  return {
    name: a.name,
    line1: a.line1,
    ...(a.line2 ? { line2: a.line2 } : {}),
    city: a.city,
    postalCode: a.postal_code,
    country: a.country,
  };
}

/** §5.3 fail-closed invariant: the quote's destination must equal the
 *  order's stored shipping address field-for-field. Belt-and-braces against
 *  any future feature mutating order addresses after the quote. */
function quoteDestinationMatches(quote: LabelQuoteSnapshot, stored: Record<string, unknown>): boolean {
  const f = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return (
    f(quote.destination.name) === f(stored.name) &&
    f(quote.destination.line1) === f(stored.line1) &&
    f(quote.destination.line2 ?? "") === f(stored.line2) &&
    f(quote.destination.city) === f(stored.city) &&
    f(quote.destination.postal_code) === f(stored.postal_code) &&
    f(quote.destination.country) === f(stored.country)
  );
}

/** §5.5 spend guards on the actual rate, quote-mode remedy set (a guard
 *  refusal strands the buyer's paid line exactly like a rate failure). Same
 *  three bounds as the flat path, checked before any /buy. */
async function enforceQuoteModeSpendGuards(
  order: OrderRow,
  rate: { costCents: number; currency: string },
  cfg: ReturnType<typeof orderFlowConfig>,
): Promise<void> {
  if (rate.costCents > cfg.labelMaxCostCents) {
    throw new OrderFlowError(
      "label_cost_exceeds_cap",
      `The label rate (${labelCost(rate.costCents, rate.currency)}) exceeds the per-label cap — LABEL_MAX_COST_CENTS=${cfg.labelMaxCostCents}. No label was purchased. ${QUOTE_MODE_REMEDIES}`,
    );
  }
  const spentToday = await todayLabelSpendCents();
  if (cfg.labelDailyBudgetCents <= 0 || spentToday + rate.costCents > cfg.labelDailyBudgetCents) {
    logSecurityEvent(
      { type: "label_budget_exceeded", cost_cents: rate.costCents, daily_total_cents: spentToday, budget_cents: cfg.labelDailyBudgetCents },
      { sellerId: order.seller_id },
    );
    throw new OrderFlowError(
      "label_budget_exceeded",
      cfg.labelDailyBudgetCents <= 0
        ? `Label purchases are disabled on this deployment (LABEL_DAILY_BUDGET_CENTS=0). No label was purchased. ${QUOTE_MODE_REMEDIES}`
        : `The platform's daily label budget is exhausted — ${labelCost(spentToday, rate.currency)} of ${labelCost(cfg.labelDailyBudgetCents, rate.currency)} spent today. No label was purchased. ${QUOTE_MODE_REMEDIES}`,
    );
  }
  const quota = await pool.query(
    `INSERT INTO seller_label_quota (seller_id, day, used)
     VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1)
     ON CONFLICT (seller_id, day) DO UPDATE
       SET used = seller_label_quota.used + 1
     WHERE seller_label_quota.used < $2
     RETURNING used`,
    [order.seller_id, MAX_LABELS_PER_SELLER_PER_DAY],
  );
  if (quota.rows.length === 0) {
    throw new OrderFlowError(
      "rate_limited",
      `Daily label purchase quota reached (${MAX_LABELS_PER_SELLER_PER_DAY} per day) — resets at ${nextUtcMidnight().toISOString()}. ${QUOTE_MODE_REMEDIES}`,
    );
  }
}

/** Shared purchase tail: persist the snapshot (+funded_by on quote mode) and
 *  move sold → label_issued in the same transaction. The cancel-race orphan
 *  path is identical for both funding modes (§5.6). */
async function persistBoughtLabel(
  orderId: string,
  sellerId: string,
  label: BoughtLabel,
  provider: ShippingProvider,
  fundedBy?: "buyer_quote",
): Promise<BuyShippingLabelResult> {
  const snapshot: LabelPurchaseSnapshot = {
    shipment_id: label.shipmentId,
    rate_id: label.rateId,
    carrier: label.carrier,
    service: label.service,
    cost_cents: label.costCents,
    currency: label.currency,
    bought_at: new Date().toISOString(),
    ...(fundedBy ? { funded_by: fundedBy } : {}),
  };
  try {
    const next = await applyTransition({
      orderId,
      trigger: "label_purchased",
      actor: { type: "seller", id: sellerId },
      reason: `label bought via ${provider.displayName} (${label.carrier} ${label.service}, ${labelCost(label.costCents, label.currency)}${fundedBy ? ", buyer-funded" : ""})`,
      sets: {
        carrier: label.carrier,
        tracking_code: label.trackingCode,
        tracker_id: label.trackerId,
        label_url: label.labelUrl,
        label_purchase: snapshot as unknown as Record<string, unknown>,
      },
    });
    return {
      order: next,
      label: {
        label_url: label.labelUrl,
        carrier: label.carrier,
        tracking_code: label.trackingCode,
        cost: labelCost(label.costCents, label.currency),
      },
    };
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      logSecurityEvent({ type: "label_bought_orphan", order_id: orderId, shipment_id: label.shipmentId }, { sellerId });
      throw new OrderFlowError(
        "invalid_transition",
        `${err.message} — the label was already bought (${provider.displayName} shipment ${label.shipmentId}); an operator alert was filed for reconciliation and no tracking was recorded on this order.`,
      );
    }
    throw err;
  }
}

/** §5: buy against the paid quote. Guards on the actual rate → single /buy →
 *  shared persistence with funded_by: "buyer_quote". */
async function buyQuoteModeLabel(
  order: OrderRow,
  sellerId: string,
  input: BuyShippingLabelInput,
  quote: LabelQuoteSnapshot,
): Promise<BuyShippingLabelResult> {
  const cfg = orderFlowConfig();
  const provider = getShippingProvider(cfg);

  // Fail-closed on a BROKEN provider selection (SHIPPING_PROVIDER invalid ⇒
  // shipping disabled): refuse before any spend gate runs. A normally
  // degraded deployment (key unset) does NOT hit this — its behavior is the
  // unchanged null-path below, byte-identical message and order of checks.
  const selectionInvalid = !cfg.shippingEnabled && provider.isConfigured();
  const notConfigured = (tail: string): OrderFlowError =>
    new OrderFlowError(
      `${provider.id}_not_configured`,
      selectionInvalid
        ? `Shipping is disabled on this deployment (the SHIPPING_PROVIDER selection is invalid — see the boot log). ${tail}`
        : `Shipping labels are not configured on this deployment (${providerApiKeyEnv(provider.id)} unset). ${tail}`,
    );
  if (selectionInvalid) {
    throw notConfigured(
      "Record your own carrier label with record_tracking instead — the buyer's shipping line is refunded when you do.",
    );
  }

  if (!quoteDestinationMatches(quote, order.shipping_address)) {
    throw new OrderFlowError(
      "label_destination_mismatch",
      "The order's shipping address no longer matches the address the buyer's shipping line was quoted for — refusing to buy (no spend). Cancel the order for a full refund or ship with your own label via record_tracking.",
    );
  }

  // Path A — the exact paid rate: cost is the paid amount (guards bound it).
  // If the provider rejects it (rate/shipment no longer purchasable) or the
  // key is unset, fall through to the snapshot-only re-quote.
  try {
    await enforceQuoteModeSpendGuards(order, { costCents: quote.amount_cents, currency: quote.currency }, cfg);
    const label = await provider.buyLabel(quote.shipment_id, quote.rate_id);
    if (label) {
      return await persistBoughtLabel(order.id, sellerId, label, provider, "buyer_quote");
    }
    throw notConfigured(
      "Record your own carrier label with record_tracking instead — the buyer's shipping line is refunded when you do.",
    );
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    // Rate or shipment no longer purchasable — re-quote solely from snapshot
    // fields (§5.3): never re-resolved account data.
    let shipment: ProviderShipment | null;
    try {
      const dims = parseDimensionsMm(quote.dimensions_mm);
      shipment = await provider.createShipment({
        toAddress: quoteAddressToDomain(quote.destination),
        fromAddress: quoteAddressToDomain(quote.origin),
        weightGrams: quote.weight_grams,
        ...(dims ? { dimensionsMm: dims } : {}),
      });
    } catch (quoteErr) {
      throw new OrderFlowError(`${provider.id}_error`, `${provider.displayName} refused to re-quote this shipment: ${describeProviderError(quoteErr)}`);
    }
    if (!shipment) {
      throw notConfigured(
        "Record your own carrier label with record_tracking instead — the buyer's shipping line is refunded when you do.",
      );
    }
    const selectable = shipment.rates.filter((r: ShipmentRate) => r.currency.toUpperCase() === LABEL_BASE_CURRENCY);
    let rate = pickRate(selectable); // cheapest EUR
    if (!rate) {
      throw new OrderFlowError(
        "label_no_rate",
        `No rates were re-quoted for this shipment in the account currency (${LABEL_BASE_CURRENCY}). ${QUOTE_MODE_REMEDIES}`,
      );
    }
    // carrier_preference is honored only when its cheapest match does not
    // exceed the paid amount (§5.3) — otherwise ignored for the cheapest.
    if (input.carrierPreference) {
      const preferred = pickRate(selectable, input.carrierPreference);
      if (preferred && preferred.costCents <= quote.amount_cents) rate = preferred;
    }
    // Rate-up rule (§5.4): the deployment never supplements a buyer-funded
    // label — the live cheapest rate must cost ≤ the paid amount.
    if (rate.costCents > quote.amount_cents) {
      throw new OrderFlowError(
        "label_rate_exceeded",
        `The cheapest live rate (${labelCost(rate.costCents, rate.currency)}) now exceeds the shipping line the buyer paid (${labelCost(quote.amount_cents, quote.currency)}). No label was purchased. ${QUOTE_MODE_REMEDIES}`,
      );
    }
    await enforceQuoteModeSpendGuards(order, rate, cfg);
    let label;
    try {
      label = await provider.buyLabel(shipment.shipmentId, rate.id);
    } catch (buyErr) {
      throw new OrderFlowError(`${provider.id}_error`, `${provider.displayName} refused the label purchase: ${describeProviderError(buyErr)}`);
    }
    if (!label) {
      throw notConfigured(
        "Record your own carrier label with record_tracking instead — the buyer's shipping line is refunded when you do.",
      );
    }
    await pool.query(
      `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload)
       VALUES ($1, 'label_requoted', 'seller', $2, 'paid rate no longer purchasable — re-quoted from snapshot', $3::jsonb)`,
      [order.id, sellerId, JSON.stringify({ shipment_id: shipment.shipmentId, rate_id: rate.id, amount_cents: rate.costCents, currency: rate.currency, paid_amount_cents: quote.amount_cents })],
    );
    return await persistBoughtLabel(order.id, sellerId, label, provider, "buyer_quote");
  }
}

/**
 * Seller buys a shipping label through the platform (#5b sold →
 * label_issued). Idempotent: a label_issued order that already carries a
 * label_purchase returns the stored label — no second purchase. All spend
 * gates (quota, A1 cap, A2 budget) run before the single EasyPost /buy call.
 */
export async function buyShippingLabel(
  orderId: string,
  sellerId: string,
  input: BuyShippingLabelInput,
): Promise<BuyShippingLabelResult> {
  const order = await partyOrder(orderId, sellerId, "seller");

  if (order.fulfillment !== "shipping") {
    throw new OrderFlowError(
      "fulfillment_mismatch",
      "This is a local-pickup order — there is nothing to ship. Use confirm_receipt when the buyer collects.",
    );
  }

  // Idempotent replay (spec §API): returning the stored label is the only
  // re-call outcome that does not spend again.
  if (order.status === "label_issued") {
    const snap = order.label_purchase as Partial<LabelPurchaseSnapshot> | null;
    if (snap?.shipment_id && snap.carrier && snap.cost_cents !== undefined && snap.currency !== undefined && order.label_url && order.tracking_code) {
      return {
        order,
        label: {
          label_url: order.label_url,
          carrier: snap.carrier,
          tracking_code: order.tracking_code,
          cost: labelCost(snap.cost_cents, snap.currency),
        },
        note: "A shipping label was already purchased for this order — returning the stored label (no second purchase). To change tracking, use record_tracking.",
      };
    }
    throw new OrderFlowError(
      "label_already_issued",
      "This order already has tracking recorded via record_tracking. To correct it while the order is label_issued, call record_tracking again — a second label purchase is not supported.",
    );
  }

  // Spec §1: status = sold is the exact CAS precondition — check it before
  // quoting rates so no provider call is wasted on an ineligible order.
  if (order.status !== "sold") {
    const allowed = [...new Set(transitionsFrom(order.status, order.payment_mode).map((t) => t.trigger))];
    throw new OrderFlowError(
      "invalid_transition",
      `Labels can only be bought while an order is sold (this one is ${order.status}; ` +
        (allowed.length ? `allowed triggers from here: ${allowed.join(", ")}` : "no transitions leave this state") +
        ").",
    );
  }

  // Address visibility (spec §1): the buyer address must be releasable to the
  // seller — stripe: from `sold`; off_platform: only after buyer consent.
  const toAddress = shippingAddressForSeller(order, sellerId);
  if (!toAddress) {
    if (order.payment_mode !== "stripe" && !order.shipping_address_shared_at) {
      throw new OrderFlowError(
        "shipping_address_not_shared",
        "The buyer has not agreed to share their shipping address with you. Ask whether they agree, and only then have them call share_shipping_address — you cannot buy a label before that.",
      );
    }
    throw new OrderFlowError("inconsistent_state", "Shipping address unavailable; refusing to buy a label.");
  }

  // Buyer-paid quote mode (§5) buys against the paid amount. Everything below
  // is paid by the deployment, so it runs only when the operator opted in.
  if (order.label_quote) {
    return await buyQuoteModeLabel(order, sellerId, input, order.label_quote);
  }
  if (!orderFlowConfig().labelAllowOperatorFunded) {
    throw new OrderFlowError(
      "label_not_paid_by_buyer",
      "The buyer did not pay a quoted shipping label on this order, so none can be bought here. Ship with your own carrier label and record it with record_tracking.",
    );
  }

  // Parcel defaults from the listing, seller-overridable (spec §2).
  const item = await pool.query<{ weight_grams: number | null; dimensions_mm: string | null }>(
    "SELECT weight_grams, dimensions_mm FROM items WHERE id = $1",
    [order.item_id],
  );
  const weightGrams = input.weightGrams ?? item.rows[0]?.weight_grams ?? undefined;
  if (!(weightGrams && weightGrams > 0)) {
    throw new OrderFlowError(
      "weight_required",
      "No usable parcel weight — the listing carries no weight_grams. Pass weight_grams with the buy_shipping_label call.",
    );
  }
  const dimensionsMm = input.dimensionsMm ?? parseDimensionsMm(item.rows[0]?.dimensions_mm);

  const cfg = orderFlowConfig();
  const provider = getShippingProvider(cfg);

  // Fail-closed on a BROKEN provider selection (see buyQuoteModeLabel): a
  // normally degraded deployment (key unset) keeps the unchanged null-path
  // below, byte-identical message.
  if (!cfg.shippingEnabled && provider.isConfigured()) {
    throw new OrderFlowError(
      `${provider.id}_not_configured`,
      `Shipping is disabled on this deployment (the SHIPPING_PROVIDER selection is invalid — see the boot log). Record your own carrier label with record_tracking instead.`,
    );
  }

  // Quote rates — no money moves until /buy. Null = degraded mode (key unset).
  let shipment: ProviderShipment | null;
  try {
    shipment = await provider.createShipment({
      toAddress: storedAddressToDomain(toAddress),
      fromAddress: input.fromAddress,
      weightGrams,
      ...(dimensionsMm ? { dimensionsMm } : {}),
    });
  } catch (err) {
    throw new OrderFlowError("easypost_error", `${provider.displayName} refused to quote this shipment: ${describeProviderError(err)}`);
  }
  if (!shipment) {
    throw new OrderFlowError(
      `${provider.id}_not_configured`,
      `Shipping labels are not configured on this deployment (${providerApiKeyEnv(provider.id)} unset). Record your own carrier label with record_tracking instead.`,
    );
  }

  // Selection (spec §3): non-base-currency rates are skipped here so every
  // stored cost_cents is comparable by plain integer; then cheapest (or the
  // cheapest carrier-preference match) wins.
  const selectable = shipment.rates.filter((r: ShipmentRate) => r.currency.toUpperCase() === LABEL_BASE_CURRENCY);
  const rate = pickRate(selectable, input.carrierPreference);
  if (!rate) {
    throw new OrderFlowError(
      "label_no_rate",
      input.carrierPreference
        ? `No rate matched carrier preference "${input.carrierPreference}" in the account currency (${LABEL_BASE_CURRENCY}) — drop the preference or try another carrier.`
        : `No rates were quoted for this shipment in the account currency (${LABEL_BASE_CURRENCY}).`,
    );
  }

  // A1 per-label cap — before any spend call (spec: no /buy is issued).
  if (rate.costCents > cfg.labelMaxCostCents) {
    throw new OrderFlowError(
      "label_cost_exceeds_cap",
      `The chosen rate (${labelCost(rate.costCents, rate.currency)}) exceeds the per-label cap — LABEL_MAX_COST_CENTS=${cfg.labelMaxCostCents} (${labelCost(cfg.labelMaxCostCents, rate.currency)}). No label was purchased; ship a cheaper service or use record_tracking with your own label.`,
    );
  }

  // A2 platform daily budget, derived from persisted spend (spec §“Spend
  // controls”): 0 = kill switch — every purchase is refused while tracker-only
  // flows continue unchanged. Every refusal emits the alert event.
  const spentToday = await todayLabelSpendCents();
  if (cfg.labelDailyBudgetCents <= 0 || spentToday + rate.costCents > cfg.labelDailyBudgetCents) {
    logSecurityEvent(
      { type: "label_budget_exceeded", cost_cents: rate.costCents, daily_total_cents: spentToday, budget_cents: cfg.labelDailyBudgetCents },
      { sellerId },
    );
    throw new OrderFlowError(
      "label_budget_exceeded",
      cfg.labelDailyBudgetCents <= 0
        ? "Label purchases are disabled on this deployment (LABEL_DAILY_BUDGET_CENTS=0). Use record_tracking with your own carrier label."
        : `The platform's daily label budget is exhausted — ${labelCost(spentToday, rate.currency)} of ${labelCost(cfg.labelDailyBudgetCents, rate.currency)} spent today. No label was purchased; try again tomorrow or use record_tracking.`,
    );
  }

  // Per-seller quota: one atomic conditional upsert (mirrors the upload path —
  // consumed BEFORE the spend call; on a later failure the slot is spent,
  // fail-closed over-counting, never under-counting). Zero rows = over quota.
  const quota = await pool.query(
    `INSERT INTO seller_label_quota (seller_id, day, used)
     VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1)
     ON CONFLICT (seller_id, day) DO UPDATE
       SET used = seller_label_quota.used + 1
     WHERE seller_label_quota.used < $2
     RETURNING used`,
    [sellerId, MAX_LABELS_PER_SELLER_PER_DAY],
  );
  if (quota.rows.length === 0) {
    throw new OrderFlowError(
      "rate_limited",
      `Daily label purchase quota reached (${MAX_LABELS_PER_SELLER_PER_DAY} per day) — resets at ${nextUtcMidnight().toISOString()}.`,
    );
  }

  // The one spend call.
  let label;
  try {
    label = await provider.buyLabel(shipment.shipmentId, rate.id);
  } catch (err) {
    throw new OrderFlowError("easypost_error", `${provider.displayName} refused the label purchase: ${describeProviderError(err)}`);
  }
  if (!label) {
    throw new OrderFlowError(
      `${provider.id}_not_configured`,
      `Shipping labels are not configured on this deployment (${providerApiKeyEnv(provider.id)} unset). Record your own carrier label with record_tracking instead.`,
    );
  }

  return await persistBoughtLabel(orderId, sellerId, label, provider);
}

function describeProviderError(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  return (err as Error).message;
}

/** Seller confirms an off-platform payment (#24, rev 3 §11.2) — pending → sold. */
export async function confirmPayment(orderId: string, sellerId: string, note?: string): Promise<OrderRow> {
  await partyOrder(orderId, sellerId, "seller");
  try {
    return await applyTransition({
      orderId,
      trigger: "confirm_payment",
      actor: { type: "seller", id: sellerId },
      reason: note?.slice(0, 500),
    });
  } catch (err) {
    return rethrow(err);
  }
}

/**
 * Buyer confirms receipt (#6 pickup: sold → delivered; #13 early confirm:
 * in_transit → delivered). Opens the dispute window (§4.4:
 * DISPUTE_WINDOW_HOURS, default 48h) in the same transition.
 */
export async function confirmReceipt(orderId: string, buyerId: string): Promise<OrderRow> {
  const order = await partyOrder(orderId, buyerId, "buyer");
  const cfg = orderFlowConfig();
  if (order.status === "sold" && order.fulfillment !== "pickup") {
    throw new OrderFlowError(
      "fulfillment_mismatch",
      "This item ships — the seller records tracking first; you confirm receipt after it arrives.",
    );
  }
  const disputeDeadline = new Date(Date.now() + cfg.disputeWindowHours * 3600_000);
  try {
    return await applyTransition({
      orderId,
      trigger: "confirm_receipt",
      actor: { type: "buyer", id: buyerId },
      sets: { dispute_deadline: disputeDeadline },
    });
  } catch (err) {
    return rethrow(err);
  }
}

/** Buyer opens a dispute (#15) — delivered → disputed, within the dispute window. */
export async function openDispute(orderId: string, buyerId: string, reason: string): Promise<OrderRow> {
  const order = await partyOrder(orderId, buyerId, "buyer");
  if (order.dispute_deadline && new Date(order.dispute_deadline).getTime() < Date.now()) {
    throw new OrderFlowError(
      "dispute_window_closed",
      "The dispute window has closed. Contact the deployment operator if you believe this is in error.",
    );
  }
  try {
    return await applyTransition({
      orderId,
      trigger: "open_dispute",
      actor: { type: "buyer", id: buyerId },
      reason: reason.slice(0, 1000),
    });
  } catch (err) {
    return rethrow(err);
  }
}

export interface ReleaseResult {
  order: OrderRow;
  note?: string;
}

/**
 * Buyer releases funds early (#17 stripe → payout_pending, #17b off_platform
 * → completed) — waives the remaining dispute window. Stripe mode then moves
 * the money: transfers.create under payout:{order_id} (F3; a replayed or
 * retried release can never produce a second transfer). A Stripe failure
 * after the transition leaves payout_pending without a transfer_id — the
 * PR-8 sweep reconciles with the same idempotency key; never retried blind.
 */
export async function releaseFunds(orderId: string, buyerId: string): Promise<ReleaseResult> {
  const order = await partyOrder(orderId, buyerId, "buyer");
  if (order.payment_mode === "off_platform") {
    try {
      const next = await applyTransition({
        orderId,
        trigger: "release_funds",
        actor: { type: "buyer", id: buyerId },
        reason: "buyer released — off_platform",
      });
      return { order: next, note: "Deal completed — thank you." };
    } catch (err) {
      return rethrow(err);
    }
  }

  const stripe = getStripe();
  if (!stripe) throw new OrderFlowError("payments_not_configured", "Stripe payments are not configured on this deployment.");
  const dest = await pool.query<{ stripe_account_id: string | null }>(
    "SELECT stripe_account_id FROM sellers WHERE id = $1",
    [order.seller_id],
  );
  const destination = dest.rows[0]?.stripe_account_id;
  if (!destination) {
    throw new OrderFlowError("inconsistent_state", "Seller payout account missing; refusing to release.");
  }

  const next = await applyTransition({
    orderId,
    trigger: "release_funds",
    actor: { type: "buyer", id: buyerId },
    reason: "buyer released — payout initiated",
  });

  try {
    const transfer = await createTransferForOrder(order, destination, stripe);
    const { rows } = await pool.query<OrderRow>(
      "UPDATE orders SET transfer_id = $2 WHERE id = $1 RETURNING *",
      [orderId, transfer.id],
    );
    return { order: rows[0] };
  } catch (err) {
    await pool.query(
      `INSERT INTO order_events (order_id, event_type, actor_type, actor_id, reason, payload)
       VALUES ($1, 'payout_attempt_failed', 'system', NULL, $2, '{}'::jsonb)`,
      [orderId, (err as Error).message.slice(0, 500)],
    );
    return {
      order: next,
      note: "Funds released; the payout call failed and will be retried automatically — no action needed.",
    };
  }
}
