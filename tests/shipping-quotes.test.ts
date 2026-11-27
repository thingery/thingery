// Buyer-paid shipping — quoting core unit tests (spec
// docs/specs/buyer-paid-shipping.md §1–§2, data model; build PR 1 of 5).
// Pure — no DB, no network: the provider call is stubbed through the
// createShipment seam, same discipline as tests/easypost.test.ts.
//
// Focus (spec test plan item 1, the resolution half): every §1 fallback
// condition resolves flat with the right reason; the happy path stores the
// full snapshot; selection is EUR-only and cap-bounded; the timeout maps to a
// flat fallback rather than an error. The order-creation integration (quote
// inside createOrder, events, transaction release) is PR 2's suite.

import { describe, expect, it } from "vitest";
import { createEasyPostShipment, type EasyPostRate, type EasyPostShipment } from "../src/easypost.js";
import { orderFlowConfig } from "../src/config.js";
import {
  resolveShippingQuote,
  selectQuoteRate,
  toQuoteAddress,
  type ShippingQuoteInputs, listingParcel } from "../src/shipping-quotes.js";

const ORIGIN = { name: "Seller", line1: "Corso Buenos Aires 2", line2: "Scala B", city: "Milan", postal_code: "20122", country: "IT" };
const BUYER_ADDRESS = { name: "Buyer", line1: "Via Roma 1", city: "Milan", postal_code: "20121", country: "IT" };

const RATE_EUR_CHEAP: EasyPostRate = { id: "rate_bpost", carrier: "BPost", service: "Express", costCents: 715, currency: "EUR" };
const RATE_EUR_DEAR: EasyPostRate = { id: "rate_dhl", carrier: "DHLExpress", service: "ExpressWorldwide", costCents: 1249, currency: "EUR" };
const RATE_USD_CHEAPEST: EasyPostRate = { id: "rate_usps", carrier: "USPS", service: "Priority", costCents: 401, currency: "USD" };

const SHIPMENT: EasyPostShipment = { id: "shp_1", rates: [RATE_EUR_DEAR, RATE_USD_CHEAPEST, RATE_EUR_CHEAP] };

function baseInputs(overrides: Partial<ShippingQuoteInputs> = {}): ShippingQuoteInputs {
  return {
    paymentMode: "stripe",
    fulfillment: "shipping",
    orderCurrency: "EUR",
    weightGrams: 850,
    dimensionsMm: "300x200x150",
    buyerAddress: BUYER_ADDRESS,
    sellerOrigin: ORIGIN,
    easypostEnabled: true,
    labelMaxCostCents: 3000,
    quoteTimeoutMs: 5000,
    ...overrides,
  };
}

/** Stubbed provider: by default one successful shipment; tests override. */
function shipmentStub(
  respond: () => Promise<EasyPostShipment | null> = () => Promise.resolve(SHIPMENT),
): {
  calls: Array<{ weightGrams: number; dimensionsMm?: { length: number; width: number; height: number } }>;
  create: typeof createEasyPostShipment;
} {
  const calls: Array<{ weightGrams: number; dimensionsMm?: { length: number; width: number; height: number } }> = [];
  const create = (async (input: Parameters<typeof createEasyPostShipment>[0]) => {
    const { weightGrams, dimensionsMm } = input;
    calls.push({ weightGrams, ...(dimensionsMm ? { dimensionsMm } : {}) });
    return respond();
  }) as typeof createEasyPostShipment;
  return { calls, create };
}

describe("resolveShippingQuote — §1 fall-through (quoting never fails an order)", () => {
  it("off-platform payment → flat", async () => {
    const { calls, create } = shipmentStub();
    const out = await resolveShippingQuote(baseInputs({ paymentMode: "off_platform" }), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "off_platform_payment" });
    expect(calls).toHaveLength(0); // no provider call before mode gate
  });

  it("local pickup → flat", async () => {
    const { calls, create } = shipmentStub();
    const out = await resolveShippingQuote(baseInputs({ fulfillment: "pickup" }), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "not_shippable" });
    expect(calls).toHaveLength(0);
  });

  it("degraded deployment (EasyPost unset) → flat", async () => {
    const { calls, create } = shipmentStub();
    const out = await resolveShippingQuote(baseInputs({ easypostEnabled: false }), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "easypost_not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("listing without weight → flat", async () => {
    const { calls, create } = shipmentStub();
    const out = await resolveShippingQuote(baseInputs({ weightGrams: null }), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "no_weight" });
    expect(calls).toHaveLength(0);
  });

  it("seller without default address → flat", async () => {
    const { calls, create } = shipmentStub();
    const out = await resolveShippingQuote(baseInputs({ sellerOrigin: null }), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "no_seller_default_address" });
    expect(calls).toHaveLength(0);
  });

  it("non-EUR order → flat, no provider call", async () => {
    const { calls, create } = shipmentStub();
    const out = await resolveShippingQuote(baseInputs({ orderCurrency: "USD" }), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "non_eur_order" });
    expect(calls).toHaveLength(0);
  });

  it("incomplete buyer address → flat (defensive)", async () => {
    const { calls, create } = shipmentStub();
    const out = await resolveShippingQuote(baseInputs({ buyerAddress: { name: "Buyer", city: "Milan" } }), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "buyer_address_incomplete" });
    expect(calls).toHaveLength(0);
  });

  it("provider error → flat quote_failed, never an order error", async () => {
    const { create } = shipmentStub(() => Promise.reject(new Error("easypost shipment creation failed: HTTP 500")));
    const out = await resolveShippingQuote(baseInputs(), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "quote_failed" });
  });

  it("timeout (AbortError/TimeoutError) → flat quote_timeout, never an order error", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "TimeoutError";
    const t1 = shipmentStub(() => Promise.reject(abort));
    const out = await resolveShippingQuote(baseInputs(), { createShipment: t1.create });
    expect(out).toEqual({ mode: "flat", reason: "quote_timeout" });

    const abort2 = new Error("This operation was aborted");
    abort2.name = "AbortError";
    const t2 = shipmentStub(() => Promise.reject(abort2));
    const out2 = await resolveShippingQuote(baseInputs(), { createShipment: t2.create });
    expect(out2).toEqual({ mode: "flat", reason: "quote_timeout" });
  });

  it("degraded seam (null shipment) → flat", async () => {
    const { create } = shipmentStub(() => Promise.resolve(null));
    const out = await resolveShippingQuote(baseInputs(), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "easypost_not_configured" });
  });

  it("quote without any EUR rate → flat no_eur_rate", async () => {
    const { create } = shipmentStub(() => Promise.resolve({ id: "shp_2", rates: [RATE_USD_CHEAPEST] }));
    const out = await resolveShippingQuote(baseInputs(), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "no_eur_rate" });
  });

  it("cheapest EUR rate above the per-label cap → flat rate_above_cap", async () => {
    const { create } = shipmentStub(() => Promise.resolve({ id: "shp_3", rates: [{ ...RATE_EUR_CHEAP, costCents: 3001 }] }));
    const out = await resolveShippingQuote(baseInputs(), { createShipment: create });
    expect(out).toEqual({ mode: "flat", reason: "rate_above_cap" });
  });

  it("cheapest EUR rate exactly at the cap → quote (cap is inclusive)", async () => {
    const { create } = shipmentStub(() => Promise.resolve({ id: "shp_4", rates: [{ ...RATE_EUR_CHEAP, costCents: 3000 }] }));
    const out = await resolveShippingQuote(baseInputs(), { createShipment: create });
    expect(out.mode).toBe("label_quote");
  });
});

describe("resolveShippingQuote — happy path snapshot (§2, data model)", () => {
  it("stores the full snapshot: ids, EUR-only cheapest rate, parcel, origin, destination, quoted_at", async () => {
    const { calls, create } = shipmentStub();
    const out = await resolveShippingQuote(baseInputs(), { createShipment: create, now: () => new Date("2026-11-18T12:00:00Z") });
    expect(out).toEqual({
      mode: "label_quote",
      quote: {
        shipment_id: "shp_1",
        rate_id: "rate_bpost", // cheapest EUR — the cheaper USD rate is never selectable
        carrier: "BPost",
        service: "Express",
        amount_cents: 715,
        currency: "EUR",
        weight_grams: 850,
        dimensions_mm: "300x200x150",
        origin: ORIGIN,
        destination: { name: "Buyer", line1: "Via Roma 1", city: "Milan", postal_code: "20121", country: "IT" },
        quoted_at: "2026-11-18T12:00:00.000Z",
      },
    });
    // The provider call is built from exactly the snapshotted fields (§5
    // re-quote reproducibility): weight + normalized dimensions + the two
    // addresses, nothing else.
    expect(calls).toEqual([
      { weightGrams: 850, dimensionsMm: { length: 300, width: 200, height: 150 } },
    ]);
  });

  it("unparsable dimensions quote without dimensions, snapshot stores null", async () => {
    const { calls, create } = shipmentStub();
    const out = await resolveShippingQuote(baseInputs({ dimensionsMm: "big" }), { createShipment: create });
    expect(out.mode).toBe("label_quote");
    if (out.mode === "label_quote") expect(out.quote.dimensions_mm).toBeNull();
    expect(calls).toEqual([{ weightGrams: 850 }]);
  });

  it("line2 rides in the snapshot when present, omitted when absent", async () => {
    const { create } = shipmentStub();
    const withLine2 = await resolveShippingQuote(
      baseInputs({ buyerAddress: { ...BUYER_ADDRESS, line2: "Interno 3" } }),
      { createShipment: create },
    );
    if (withLine2.mode === "label_quote") expect(withLine2.quote.destination.line2).toBe("Interno 3");
    else throw new Error("expected quote mode");

    const without = await resolveShippingQuote(baseInputs(), { createShipment: create });
    if (without.mode === "label_quote") expect("line2" in without.quote.destination).toBe(false);
    else throw new Error("expected quote mode");
  });
});

describe("selectQuoteRate — EUR-only selection reuse", () => {
  it("picks the cheapest EUR rate and never a non-EUR one", () => {
    expect(selectQuoteRate([RATE_USD_CHEAPEST, RATE_EUR_DEAR, RATE_EUR_CHEAP])).toEqual(RATE_EUR_CHEAP);
    expect(selectQuoteRate([RATE_USD_CHEAPEST])).toBeNull();
    expect(selectQuoteRate([])).toBeNull();
  });
});

describe("toQuoteAddress — stored-shape completeness (same rule as label purchase)", () => {
  it("accepts the five required fields, keeps optional line2", () => {
    expect(toQuoteAddress({ ...BUYER_ADDRESS, line2: "Interno 3" })).toEqual({
      ...BUYER_ADDRESS,
      line2: "Interno 3",
    });
  });
  it("rejects missing/empty required fields", () => {
    expect(toQuoteAddress({ ...BUYER_ADDRESS, city: "" })).toBeNull();
    expect(toQuoteAddress({ ...BUYER_ADDRESS, country: undefined })).toBeNull();
    expect(toQuoteAddress({})).toBeNull();
  });
});

describe("config wiring (§2 / data model: the two new env knobs)", () => {
  const saved: Record<string, string | undefined> = {};
  it("defaults: SHIPPING_QUOTE_TIMEOUT_MS=5000, SHIPPING_QUOTE_ESTIMATE_TTL_MINUTES=15", () => {
    for (const n of ["SHIPPING_QUOTE_TIMEOUT_MS", "SHIPPING_QUOTE_ESTIMATE_TTL_MINUTES"]) {
      saved[n] = process.env[n];
      delete process.env[n];
    }
    const cfg = orderFlowConfig();
    expect(cfg.shippingQuoteTimeoutMs).toBe(5000);
    expect(cfg.shippingQuoteEstimateTtlMinutes).toBe(15);
  });
  it("positive-integer env parse: set values win, malformed falls back", () => {
    process.env.SHIPPING_QUOTE_TIMEOUT_MS = "250";
    process.env.SHIPPING_QUOTE_ESTIMATE_TTL_MINUTES = "30";
    expect(orderFlowConfig().shippingQuoteTimeoutMs).toBe(250);
    expect(orderFlowConfig().shippingQuoteEstimateTtlMinutes).toBe(30);
    process.env.SHIPPING_QUOTE_TIMEOUT_MS = "nope";
    expect(orderFlowConfig().shippingQuoteTimeoutMs).toBe(5000);
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  });
});

describe("listingParcel", () => {
  const listing = { shipping_tier: "parcel", weight_grams: null, dimensions_mm: null };

  it("quotes a parcel or locker listing without measurements as size M", () => {
    for (const shipping_tier of ["parcel", "locker"]) {
      expect(listingParcel({ ...listing, shipping_tier })).toEqual({ weightGrams: 1000, dimensionsMm: "380x300x180" });
    }
  });

  it("defaults each missing or unusable value on its own", () => {
    expect(listingParcel({ ...listing, weight_grams: 300 })).toEqual({ weightGrams: 300, dimensionsMm: "380x300x180" });
    expect(listingParcel({ ...listing, dimensions_mm: "100x100x50" })).toEqual({ weightGrams: 1000, dimensionsMm: "100x100x50" });
    expect(listingParcel({ ...listing, dimensions_mm: "about a shoebox" }).dimensionsMm).toBe("380x300x180");
  });

  it("never guesses for bulky or local listings", () => {
    for (const shipping_tier of ["bulky", "local"]) {
      expect(listingParcel({ ...listing, shipping_tier })).toEqual({ weightGrams: null, dimensionsMm: null });
    }
  });
});
