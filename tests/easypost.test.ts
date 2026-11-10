// EasyPost shipment/label client unit tests (spec docs/specs/label-purchase.md,
// THI-562 work item 2; THI-568 PR-A). Pure — no DB, no network: everything goes
// through the fetchImpl seam, same discipline as the LLM client tests.
//
// Focus (spec test plan, "easypost client"): rate list mapping, buy mapping,
// error mapping, degraded mode, and the pure rate picker the service layer
// will gate spend with (THI-566 amendments A1/A2 slot in at that layer).

import { describe, expect, it } from "vitest";
import {
  buyEasyPostLabel,
  createEasyPostShipment,
  EasyPostError,
  pickEasyPostRate,
  type EasyPostRate,
} from "../src/easypost.js";

const OPTS = { apiKey: "EZAK_test", baseUrl: "https://easypost.test" } as const;

interface Captured {
  url: string;
  init: RequestInit;
}

/** Stubbed fetch: captures the one call, replies with `respond()`. */
function fetchStub(respond: () => Response): { calls: Captured[]; fetch: typeof fetch } {
  const calls: Captured[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, fetch: impl };
}

const TO = { name: "Buyer", line1: "Via Roma 1", city: "Milan", postalCode: "20121", country: "IT" };
const FROM = { name: "Seller", line1: "Corso Buenos Aires 2", line2: "Scala B", city: "Milan", postalCode: "20122", country: "IT", phone: "+39 02 1234567" };

const RATE_USPS = { id: "rate_usps", carrier: "USPS", service: "Priority", rate: "12.30", currency: "USD" };
const RATE_DHL = { id: "rate_dhl", carrier: "DHLExpress", service: "ExpressWorldwide", rate: "10.45", currency: "USD" };

function shipmentResponse(): Response {
  return new Response(JSON.stringify({ id: "shp_123", rates: [RATE_USPS, RATE_DHL] }), { status: 200 });
}

describe("createEasyPostShipment", () => {
  it("degraded mode: no API key → null, no network call", async () => {
    const { calls, fetch } = fetchStub(shipmentResponse);
    const out = await createEasyPostShipment(
      { toAddress: TO, fromAddress: FROM, weightGrams: 500 },
      { apiKey: undefined, baseUrl: OPTS.baseUrl, fetchImpl: fetch },
    );
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("posts the shipment with basic auth and maps addresses to the wire format", async () => {
    const { calls, fetch } = fetchStub(shipmentResponse);
    const out = await createEasyPostShipment(
      { toAddress: TO, fromAddress: FROM, weightGrams: 453.59237, dimensionsMm: { length: 254, width: 101.6, height: 50.8 } },
      { ...OPTS, fetchImpl: fetch },
    );
    expect(calls[0].url).toBe("https://easypost.test/v2/shipments");
    expect(calls[0].init.method).toBe("POST");
    // EasyPost basic auth: the key is the username.
    expect(calls[0].init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("EZAK_test:").toString("base64")}`,
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(calls[0].init.body)).shipment;
    expect(body.to_address).toEqual({ name: "Buyer", street1: "Via Roma 1", city: "Milan", zip: "20121", country: "IT" });
    expect(body.from_address).toEqual({
      name: "Seller", street1: "Corso Buenos Aires 2", street2: "Scala B",
      city: "Milan", zip: "20122", country: "IT", phone: "+39 02 1234567",
    });
    // grams→ounces, mm→inches
    expect(body.parcel).toEqual({ weight: 16, length: 10, width: 4, height: 2 });

    expect(out).toEqual({
      id: "shp_123",
      rates: [
        { id: "rate_usps", carrier: "USPS", service: "Priority", costCents: 1230, currency: "USD" },
        { id: "rate_dhl", carrier: "DHLExpress", service: "ExpressWorldwide", costCents: 1045, currency: "USD" },
      ],
    });
  });

  it("rejects non-positive weight before any network call", async () => {
    const { calls, fetch } = fetchStub(shipmentResponse);
    await expect(
      createEasyPostShipment({ toAddress: TO, fromAddress: FROM, weightGrams: 0 }, { ...OPTS, fetchImpl: fetch }),
    ).rejects.toThrow(/weight_grams must be positive/);
    expect(calls).toHaveLength(0);
  });

  it("maps a non-2xx JSON error body onto EasyPostError with the provider code", async () => {
    const { fetch } = fetchStub(() => new Response(JSON.stringify({ error: { message: "bad", code: "INVALID_ADDRESS" } }), { status: 422 }));
    const err = await createEasyPostShipment(
      { toAddress: TO, fromAddress: FROM, weightGrams: 500 },
      { ...OPTS, fetchImpl: fetch },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(EasyPostError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("INVALID_ADDRESS");
    expect(err.message).toContain("HTTP 422");
  });

  it("maps a non-JSON error body onto EasyPostError without a code", async () => {
    const { fetch } = fetchStub(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const err = await buyEasyPostLabel("shp_1", "rate_1", { ...OPTS, fetchImpl: fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(EasyPostError);
    expect(err.status).toBe(502);
    expect(err.code).toBeUndefined();
  });

  it("throws on a success payload without a shipment id", async () => {
    const { fetch } = fetchStub(() => new Response(JSON.stringify({ rates: [RATE_DHL] }), { status: 200 }));
    await expect(
      createEasyPostShipment({ toAddress: TO, fromAddress: FROM, weightGrams: 500 }, { ...OPTS, fetchImpl: fetch }),
    ).rejects.toThrow(/no shipment id/);
  });

  it("drops malformed rate entries instead of crashing", async () => {
    const { fetch } = fetchStub(
      () => new Response(JSON.stringify({ id: "shp_1", rates: [RATE_DHL, { id: "rate_broken" }, "junk"] }), { status: 200 }),
    );
    const out = await createEasyPostShipment({ toAddress: TO, fromAddress: FROM, weightGrams: 500 }, { ...OPTS, fetchImpl: fetch });
    expect(out?.rates).toEqual([{ id: "rate_dhl", carrier: "DHLExpress", service: "ExpressWorldwide", costCents: 1045, currency: "USD" }]);
  });
});

describe("buyEasyPostLabel", () => {
  it("degraded mode: no API key → null, no network call", async () => {
    const { calls, fetch } = fetchStub(boughtResponse());
    const out = await buyEasyPostLabel("shp_123", "rate_dhl", { apiKey: undefined, baseUrl: OPTS.baseUrl, fetchImpl: fetch });
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("buys the chosen rate and maps the result onto the persisted shape", async () => {
    const { calls, fetch } = fetchStub(boughtResponse);
    const out = await buyEasyPostLabel("shp_123", "rate_dhl", { ...OPTS, fetchImpl: fetch });
    expect(calls[0].url).toBe("https://easypost.test/v2/shipments/shp_123/buy");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ rate: { id: "rate_dhl" } });
    expect(out).toEqual({
      shipmentId: "shp_123",
      rateId: "rate_dhl",
      carrier: "DHLExpress",
      service: "ExpressWorldwide",
      costCents: 1045,
      currency: "USD",
      labelUrl: "https://easypost.test/labels/abc.pdf",
      trackerId: "trk_456",
      trackingCode: "9400100000000000000000",
    });
  });

  it("refuses a non-https label_url", async () => {
    const { fetch } = fetchStub(() => boughtResponse("http://easypost.test/labels/abc.pdf"));
    await expect(buyEasyPostLabel("shp_123", "rate_dhl", { ...OPTS, fetchImpl: fetch })).rejects.toThrow(/not https/);
  });

  it("throws on a bought label with no tracker (spend happened — must surface)", async () => {
    const { fetch } = fetchStub(() => new Response(JSON.stringify({ id: "shp_1", selected_rate: RATE_DHL, postage_label: { label_url: "https://x/l.pdf" }, tracking_code: "9400" }), { status: 200 }));
    await expect(buyEasyPostLabel("shp_1", "rate_dhl", { ...OPTS, fetchImpl: fetch })).rejects.toThrow(/incomplete success payload/);
  });

  it("escapes the shipment id into the URL", async () => {
    const { calls, fetch } = fetchStub(boughtResponse);
    await buyEasyPostLabel("shp/123 x", "rate_dhl", { ...OPTS, fetchImpl: fetch });
    expect(calls[0].url).toBe("https://easypost.test/v2/shipments/shp%2F123%20x/buy");
  });
});

describe("pickEasyPostRate (pure — the seam THI-566 A1/A2 guards hang off)", () => {
  const usps: EasyPostRate = { id: "rate_usps", carrier: "USPS", service: "Priority", costCents: 1230, currency: "USD" };
  const dhl: EasyPostRate = { id: "rate_dhl", carrier: "DHLExpress", service: "ExpressWorldwide", costCents: 1045, currency: "USD" };
  const dhlSlow: EasyPostRate = { id: "rate_dhl2", carrier: "DHLExpress", service: "Ground", costCents: 900, currency: "USD" };

  it("picks the cheapest rate overall", () => {
    expect(pickEasyPostRate([usps, dhl, dhlSlow])?.id).toBe("rate_dhl2");
  });

  it("picks the cheapest matching a case-insensitive carrier substring", () => {
    expect(pickEasyPostRate([usps, dhl, dhlSlow], "dhl")?.id).toBe("rate_dhl2");
    expect(pickEasyPostRate([usps, dhl, dhlSlow], "USPS")?.id).toBe("rate_usps");
  });

  it("returns null when the preference matches nothing — never silently spends on another carrier", () => {
    expect(pickEasyPostRate([usps, dhl], "FedEx")).toBeNull();
  });

  it("returns null on an empty rate list", () => {
    expect(pickEasyPostRate([])).toBeNull();
    expect(pickEasyPostRate([], "DHL")).toBeNull();
  });

  it("treats a whitespace-only preference as absent", () => {
    expect(pickEasyPostRate([usps], "  ")?.id).toBe("rate_usps");
  });
});

function boughtResponse(labelUrl = "https://easypost.test/labels/abc.pdf"): Response {
  return new Response(
    JSON.stringify({
      id: "shp_123",
      selected_rate: RATE_DHL,
      postage_label: { label_url: labelUrl },
      tracker: { id: "trk_456" },
      tracking_code: "9400100000000000000000",
    }),
    { status: 200 },
  );
}
