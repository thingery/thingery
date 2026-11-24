// Shippo provider tests (THI-1247; spec docs/specs/shipping-provider-layer.md
// §Test plan — adapter contract + the nine fixtures, parent THI-1244).
//
// Layers, mirroring the easypost suite shape:
//  1. Transport (src/shippo.ts): auth header, endpoint bodies, rate/label
//     mapping, error mapping, tracker-id synthesis, the webhook HMAC scheme.
//  2. Adapter (src/shipping/shippo-adapter.ts): degraded nulls (F1),
//     status normalization (§ mapping table), verify→parse→dedupe webhook
//     contract with F6 redaction, and address verification with the 6-row
//     outcome mapping — exercised through the NINE fixtures (mocked v2
//     validate responses; exact key fields frozen as the wire contract).
// Test mode only: everything runs against `shippo_test_…`-shaped keys and
// stubbed fetch — no live call is ever made.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import {
  buyShippoLabel,
  createShippoShipment,
  createShippoTracker,
  shippoTrackerId,
  SHIPPO_SIG_HEADER,
  validateShippoAddressRaw,
  verifyShippoSignature,
  type ShippoOptions,
} from "../src/shippo.js";
import { ShippoShippingProvider } from "../src/shipping/shippo-adapter.js";
import { EasyPostShippingProvider } from "../src/shipping/easypost-adapter.js";
import { ProviderError, VerificationError, WebhookParseError, type ProviderAddress, type ProviderShipmentInput } from "../src/shipping/provider.js";

const NAMES = [
  "SHIPPING_PROVIDER",
  "EASYPOST_API_KEY", "EASYPOST_WEBHOOK_SECRET", "EASYPOST_WEBHOOK_SECRET_PREVIOUS",
  "SHIPPO_API_KEY", "SHIPPO_WEBHOOK_SECRET", "SHIPPO_WEBHOOK_SECRET_PREVIOUS",
];

const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  saved.clear();
  for (const n of NAMES) delete process.env[n];
});
afterEach(() => {
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SHIPMENT_INPUT: ProviderShipmentInput = {
  toAddress: { name: "Buyer", line1: "Via Roma 1", city: "Milano", postalCode: "20121", country: "IT" },
  fromAddress: { name: "Seller", line1: "Weg 2", city: "Berlin", postalCode: "10115", country: "DE" },
  weightGrams: 500,
  dimensionsMm: { length: 300, width: 200, height: 100 },
};

const SHIPMENT_RESPONSE = {
  object_id: "shp_abc",
  status: "SUCCESS",
  rates: [
    {
      object_id: "rate_1",
      provider: "DHL Germany",
      servicelevel: { token: "dhl_paket", name: "Paket National" },
      amount: "4.50",
      currency: "EUR",
    },
    { object_id: "rate_bad", provider: "X", amount: "not-a-number", currency: "EUR" }, // unparseable → dropped
  ],
};

// ---------------------------------------------------------------------------
// 1. Transport — shipment + rates
// ---------------------------------------------------------------------------

describe("createShippoShipment", () => {
  it("returns null in degraded mode (key unset; empty string = unset)", async () => {
    await expect(createShippoShipment(SHIPMENT_INPUT)).resolves.toBeNull();
    setEnv("SHIPPO_API_KEY", "");
    await expect(createShippoShipment(SHIPMENT_INPUT)).resolves.toBeNull();
    setEnv("SHIPPO_API_KEY", "   ");
    await expect(createShippoShipment(SHIPMENT_INPUT)).resolves.toBeNull();
  });

  it("POSTs addresses + metric parcel with async:false, auth via ShippoToken; maps rates", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(SHIPMENT_RESPONSE));
    vi.stubGlobal("fetch", fetchMock);
    const shipment = await createShippoShipment(SHIPMENT_INPUT, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(shipment).toEqual({
      id: "shp_abc",
      rates: [{ id: "rate_1", carrier: "DHL Germany", service: "Paket National", costCents: 450, currency: "EUR" }],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.goshippo.com/shipments");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("ShippoToken shippo_test_KEY");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.async).toBe(false);
    expect(body.address_to).toEqual({
      name: "Buyer", street1: "Via Roma 1", city: "Milano", zip: "20121", country: "IT",
    });
    expect(body.address_from).toEqual({
      name: "Seller", street1: "Weg 2", city: "Berlin", zip: "10115", country: "DE",
    });
    // mm → cm, grams as declared mass unit:
    expect(body.parcel).toEqual({
      weight: 500, mass_unit: "g", length: 30, width: 20, height: 10, distance_unit: "cm",
    });
  });

  it("omits parcel dimensions when the input has none; phone rides only when present", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(SHIPMENT_RESPONSE));
    const input = { ...SHIPMENT_INPUT, dimensionsMm: undefined, toAddress: { ...SHIPMENT_INPUT.toAddress, phone: "+39 02 1234" } };
    await createShippoShipment(input, { fetchImpl: fetchMock as unknown as typeof fetch });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    expect(body.parcel).toEqual({ weight: 500, mass_unit: "g" });
    expect(body.address_to).toMatchObject({ phone: "+39 02 1234" });
  });

  it("weight must be positive (defensive repeat of the schema rule)", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      createShippoShipment({ ...SHIPMENT_INPUT, weightGrams: 0 }, { fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/weight_grams must be positive/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("non-2xx → ShippoError (a ProviderError) carrying status + code; never the body text", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ detail: "secret sauce" }, 429));
    await expect(
      createShippoShipment(SHIPMENT_INPUT, { fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 429, code: undefined });
    try {
      await createShippoShipment(SHIPMENT_INPUT, { fetchImpl: fetchMock as unknown as typeof fetch });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as Error).message).toBe("shippo shipment creation failed: HTTP 429");
      expect((err as Error).message).not.toContain("secret sauce");
    }
  });

  it("malformed success payload (no shipment id) throws — never a fabricated shipment", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ rates: [] }));
    await expect(
      createShippoShipment(SHIPMENT_INPUT, { fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/no shipment id/);
  });
});

// ---------------------------------------------------------------------------
// 2. Transport — buy label (THE spend call)
// ---------------------------------------------------------------------------

const TRANSACTION_SUCCESS = {
  object_id: "transaction_1",
  status: "SUCCESS",
  label_url: "https://shippo-deliveries.s3.amazonaws.com/label.pdf",
  tracking_number: "TRACK123DE",
  tracking_status: "TRANSIT",
  rate: {
    object_id: "rate_1",
    provider: "DHL Germany",
    servicelevel: { token: "dhl_paket", name: "Paket National" },
    amount: "4.50",
    currency: "EUR",
  },
};

describe("buyShippoLabel", () => {
  it("returns null in degraded mode", async () => {
    await expect(buyShippoLabel("shp_abc", "rate_1")).resolves.toBeNull();
  });

  it("POSTs {rate, async:false} to /transactions; maps the bought label incl. synthesized tracker id", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(TRANSACTION_SUCCESS));
    const label = await buyShippoLabel("shp_abc", "rate_1", { fetchImpl: fetchMock as unknown as typeof fetch });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.goshippo.com/transactions");
    expect(JSON.parse(init.body as string)).toEqual({ rate: "rate_1", async: false });
    expect(label).toEqual({
      shipmentId: "shp_abc",
      rateId: "rate_1",
      carrier: "DHL Germany",
      service: "Paket National",
      costCents: 450,
      currency: "EUR",
      labelUrl: TRANSACTION_SUCCESS.label_url,
      trackerId: shippoTrackerId("DHL Germany", "TRACK123DE"),
      trackingCode: "TRACK123DE",
    });
  });

  it("throws on non-SUCCESS transaction statuses (queued/error are exceptional, never swallowed)", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ ...TRANSACTION_SUCCESS, status: "QUEUED" }));
    await expect(buyShippoLabel("shp_abc", "rate_1", { fetchImpl: fetchMock as unknown as typeof fetch })).rejects.toThrow(
      /transaction status QUEUED/,
    );
  });

  it("throws on an incomplete success payload (missing label_url / tracking_number / rate echo)", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    for (const omit of ["label_url", "tracking_number", "rate"] as const) {
      const body = { ...TRANSACTION_SUCCESS } as Record<string, unknown>;
      delete body[omit];
      const fetchMock = vi.fn().mockResolvedValue(jsonRes(body));
      await expect(buyShippoLabel("shp_abc", "rate_1", { fetchImpl: fetchMock as unknown as typeof fetch })).rejects.toThrow(
        /incomplete success payload/,
      );
    }
  });

  it("refuses a non-https label_url (F16 discipline)", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ ...TRANSACTION_SUCCESS, label_url: "http://shippo-deliveries.example/label.pdf" }),
    );
    await expect(buyShippoLabel("shp_abc", "rate_1", { fetchImpl: fetchMock as unknown as typeof fetch })).rejects.toThrow(
      /label_url is not https/,
    );
  });

  it("non-2xx → ShippoError with status + provider code", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ code: "rate_error" }, 402));
    try {
      await buyShippoLabel("shp_abc", "rate_1", { fetchImpl: fetchMock as unknown as typeof fetch });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as Error).message).toBe("shippo label purchase failed: HTTP 402 (rate_error)");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Transport — tracker registration + id synthesis
// ---------------------------------------------------------------------------

describe("createShippoTracker + shippoTrackerId", () => {
  it("returns null in degraded mode", async () => {
    await expect(createShippoTracker("shippo", "TRACK123")).resolves.toBeNull();
  });

  it("POSTs {carrier, tracking_number, metadata} to /tracks; the id is synthesized (no tracker object on the wire)", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRes({ carrier: "shippo", tracking_number: "TRACK123", tracking_status: { status: "TRANSIT" } }),
    );
    const ref = await createShippoTracker("shippo", "TRACK123", "thingery:ord_1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.goshippo.com/tracks");
    expect(JSON.parse(init.body as string)).toEqual({
      carrier: "shippo", tracking_number: "TRACK123", metadata: "thingery:ord_1",
    });
    expect(ref).toEqual({ id: shippoTrackerId("shippo", "TRACK123") });
  });

  it("shippoTrackerId is deterministic, sha256-prefixed with `shippo:`, and distinct per carrier/code", () => {
    const a = shippoTrackerId("shippo", "TRACK123");
    expect(a).toBe(shippoTrackerId("shippo", "TRACK123"));
    expect(a).toMatch(/^shippo:[0-9a-f]{32}$/);
    expect(a).not.toBe(shippoTrackerId("shippo", "TRACK124"));
    expect(a).not.toBe(shippoTrackerId("usps", "TRACK123"));
    // Never collides with EasyPost trk_… ids (UNIQUE constraint safety).
    expect(a.startsWith("trk_")).toBe(false);
  });

  it("non-2xx → ShippoError (registration failures are non-fatal for callers)", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({}, 400));
    await expect(createShippoTracker("carrier", "X", undefined, { fetchImpl: fetchMock as unknown as typeof fetch }))
      .rejects.toThrow(/HTTP 400/);
  });
});

// ---------------------------------------------------------------------------
// 4. Webhook HMAC scheme + signature verification
// ---------------------------------------------------------------------------

function shippoSign(payload: Buffer, secret: string, ts = 1_735_000_000): string {
  const digest = crypto.createHmac("sha256", secret).update(`${ts}.`).update(payload).digest("hex");
  return `t=${ts},v1=${digest}`;
}

const RAW_EVENT = Buffer.from(
  JSON.stringify({
    event: "track_updated",
    test: true,
    data: {
      carrier: "shippo",
      tracking_number: "SHIPPO_DELIVERED",
      address_from: { name: "Should Not Leak", street1: "Via Segreta 1", city: "Milano", zip: "20121", country: "IT" },
      address_to: { name: "Also Should Not Leak", street1: "Weg Geheim 2", city: "Berlin", zip: "10115", country: "DE" },
      tracking_status: { status: "DELIVERED", substatus: null, status_date: "2026-11-20T12:00:00Z" },
      tracking_history: [
        { status: "TRANSIT", message: "handled in transit Cologne" },
        { status: "DELIVERED", message: "Delivered - Signed for by FOO BAR" },
      ],
      metadata: "thingery:ord_123",
    },
  }),
);

describe("verifyShippoSignature (t=,v1= HMAC scheme)", () => {
  it("accepts a correctly signed payload with the current secret", () => {
    expect(verifyShippoSignature(RAW_EVENT, shippoSign(RAW_EVENT, "sec"), "sec")).toBe(true);
  });

  it("rejects a wrong secret, a tampered body, and a tampered timestamp", () => {
    expect(verifyShippoSignature(RAW_EVENT, shippoSign(RAW_EVENT, "wrong"), "sec")).toBe(false);
    expect(verifyShippoSignature(RAW_EVENT, shippoSign(RAW_EVENT, "sec"), "sec")).toBe(true);
    const tampered = Buffer.from(RAW_EVENT.toString("utf8").replace("DELIVERED", "DELIVEREY"));
    expect(verifyShippoSignature(tampered, shippoSign(RAW_EVENT, "sec"), "sec")).toBe(false);
    // timestamp swapped WITHOUT re-signing: the v1 still covers the old ts
    const mismatched = shippoSign(RAW_EVENT, "sec", 111).replace("t=111", "t=222");
    expect(verifyShippoSignature(RAW_EVENT, mismatched, "sec")).toBe(false);
  });

  it("rejects malformed header forms", () => {
    expect(verifyShippoSignature(RAW_EVENT, "", "sec")).toBe(false);
    expect(verifyShippoSignature(RAW_EVENT, "v1=deadbeef", "sec")).toBe(false);
    expect(verifyShippoSignature(RAW_EVENT, `t=notdigits,v1=${"0".repeat(64)}`, "sec")).toBe(false);
    expect(verifyShippoSignature(RAW_EVENT, `t=123,v1=${"zz".repeat(32)}`, "sec")).toBe(false);
    expect(verifyShippoSignature(RAW_EVENT, `t=123,v1=${"a".repeat(32)}`, "sec")).toBe(false); // length mismatch
  });
});

// ---------------------------------------------------------------------------
// 5. Adapter — degraded contract + capability flag
// ---------------------------------------------------------------------------

describe("ShippoShippingProvider — degraded contract (null iff not configured)", () => {
  it("createShipment / buyLabel / registerTracker / verifyAddress return null with no API key", async () => {
    const provider = new ShippoShippingProvider();
    expect(provider.id).toBe("shippo");
    expect(provider.displayName).toBe("Shippo");
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.createShipment(SHIPMENT_INPUT)).resolves.toBeNull();
    await expect(provider.buyLabel("shp_x", "rate_x")).resolves.toBeNull();
    await expect(provider.registerTracker("shippo", "JJD000")).resolves.toBeNull();
    await expect(provider.verifyAddress(PROVIDER_ADDRESS)).resolves.toBeNull();
  });

  it("isConfigured follows the env at call time (F1: empty/whitespace = unset)", async () => {
    const provider = new ShippoShippingProvider();
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    expect(provider.isConfigured()).toBe(true);
    setEnv("SHIPPO_API_KEY", "");
    expect(provider.isConfigured()).toBe(false);
    setEnv("SHIPPO_API_KEY", "   ");
    expect(provider.isConfigured()).toBe(false);
  });

  it("capability flag: shippo true, easypost false with a null verifyAddress", async () => {
    expect(new ShippoShippingProvider().supportsAddressVerification).toBe(true);
    const ez = new EasyPostShippingProvider();
    expect(ez.supportsAddressVerification).toBe(false);
    await expect(ez.verifyAddress(PROVIDER_ADDRESS)).resolves.toBeNull();
  });
});

const PROVIDER_ADDRESS: ProviderAddress = {
  name: "Alice Rossi",
  line1: "Via del Corzo 100",
  city: "Roma",
  postalCode: "00186",
  country: "IT",
};

// ---------------------------------------------------------------------------
// 6. Adapter — status normalization (§ mapping table)
// ---------------------------------------------------------------------------

describe("ShippoShippingProvider — carrier status normalization", () => {
  const provider = new ShippoShippingProvider({ webhookSecret: "sec" });

  function parse(status: string | undefined, substatus?: string | null): import("../src/shipping/provider.js").NormalizedStatus | null {
    return provider.parseWebhook(
      Buffer.from(
        JSON.stringify({
          event: "track_updated",
          test: true,
          data: {
            carrier: "shippo",
            tracking_number: "X1",
            tracking_status: { status, ...(substatus === undefined ? {} : { substatus }), status_date: "2026-11-20T12:00:00Z" },
          },
        }),
      ),
    ).status;
  }

  it("maps the documented status/substatus pairs", () => {
    expect(parse("PRE_TRANSIT")).toBe("pre_transit");
    expect(parse("TRANSIT")).toBe("in_transit");
    expect(parse("TRANSIT", null)).toBe("in_transit");
    expect(parse("TRANSIT", "in_transit")).toBe("in_transit");
    expect(parse("TRANSIT", "out_for_delivery")).toBe("out_for_delivery");
    expect(parse("TRANSIT", "pickup_available")).toBe("out_for_delivery");
    expect(parse("DELIVERED")).toBe("delivered");
    expect(parse("RETURNED")).toBe("return_to_sender");
    expect(parse("FAILURE")).toBe("failure");
    expect(parse("FAILURE", "package_lost")).toBe("failure");
  });

  it("maps unrecognized statuses to unknown and compares case-insensitively", () => {
    expect(parse("cancelled")).toBe("unknown");
    expect(parse("WEIRD_STATUS")).toBe("unknown");
    expect(parse("delivered")).toBe("delivered");
    expect(parse("transit", "OUT_FOR_DELIVERY")).toBe("out_for_delivery");
    expect(parse(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Adapter — webhook contract (verify → parse/redact → dedupe)
// ---------------------------------------------------------------------------

describe("ShippoShippingProvider — webhook contract", () => {
  const SECRET = "shippo_webhook_secret";
  const PREVIOUS = "shippo_old_secret";
  const provider = new ShippoShippingProvider({ webhookSecret: SECRET, webhookSecretPrevious: PREVIOUS });

  it("missing header → VerificationError with the exact wire message", () => {
    expect(() => provider.verifyWebhook(RAW_EVENT, {})).toThrow(VerificationError);
    try {
      provider.verifyWebhook(RAW_EVENT, {});
    } catch (err) {
      expect((err as VerificationError).wireMessage).toBe(`missing ${SHIPPO_SIG_HEADER} header`);
    }
  });

  it("bad signature → VerificationError 'signature verification failed'", () => {
    expect(() => provider.verifyWebhook(RAW_EVENT, { [SHIPPO_SIG_HEADER]: shippoSign(RAW_EVENT, "wrong") })).toThrow(
      /signature verification failed/,
    );
  });

  it("current secret verifies; previous secret verifies with the rotation warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => provider.verifyWebhook(RAW_EVENT, { [SHIPPO_SIG_HEADER]: shippoSign(RAW_EVENT, SECRET) })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(() => provider.verifyWebhook(RAW_EVENT, { [SHIPPO_SIG_HEADER]: shippoSign(RAW_EVENT, PREVIOUS) })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("SHIPPO_WEBHOOK_SECRET_PREVIOUS");
  });

  it("fails closed when built without a secret (defense in depth behind the route's 503)", () => {
    const bare = new ShippoShippingProvider();
    expect(() => bare.verifyWebhook(RAW_EVENT, { [SHIPPO_SIG_HEADER]: shippoSign(RAW_EVENT, SECRET) })).toThrow(
      VerificationError,
    );
  });

  it("invalid JSON after a valid signature → WebhookParseError (400 at the route)", () => {
    const raw = Buffer.from("not json at all");
    expect(() => provider.verifyWebhook(raw, { [SHIPPO_SIG_HEADER]: shippoSign(raw, SECRET) })).not.toThrow();
    expect(() => provider.parseWebhook(raw)).toThrow(WebhookParseError);
  });

  it("parseWebhook emits F6 fields only — addresses, history and metadata never leave parse", () => {
    const event = provider.parseWebhook(RAW_EVENT);
    expect(Object.keys(event).sort()).toEqual(
      ["carrier", "carrier_status", "description", "mode", "occurred_at", "status", "tracker_id", "tracking_code"].sort(),
    );
    expect(event.description).toBeNull(); // no description field on the wire — nothing fabricated
    expect(event.mode).toBe("test"); // payload.test === true
    expect(event.carrier).toBe("shippo");
    expect(event.tracking_code).toBe("SHIPPO_DELIVERED");
    expect(event.tracker_id).toBe(shippoTrackerId("shippo", "SHIPPO_DELIVERED")); // SYNTHESIZED
    expect(event.carrier_status).toBe("DELIVERED");
    expect(event.status).toBe("delivered");
    expect(event.occurred_at).toBe("2026-11-20T12:00:00Z");
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("Should Not Leak");
    expect(serialized).not.toContain("Via Segreta");
    expect(serialized).not.toContain("Weg Geheim");
    expect(serialized).not.toContain("thingery:ord_123");
    expect(serialized).not.toContain("Signed for by");
  });

  it("mode: test=false → production; field absent → null", () => {
    const production = provider.parseWebhook(Buffer.from(JSON.stringify({ event: "track_updated", test: false, data: { carrier: "shippo", tracking_number: "X" } })));
    expect(production.mode).toBe("production");
    const unknown = provider.parseWebhook(Buffer.from(JSON.stringify({ event: "track_updated", data: {} })));
    expect(unknown.mode).toBeNull();
    expect(unknown.tracker_id).toBeNull(); // no carrier/tracking_number
    expect(unknown.status).toBeNull(); // no data.tracking_status
  });

  it("dedupeId: `shippo:<sha256>` — byte-identical redelivery dedupes, any change is a new event", () => {
    const id1 = provider.dedupeId(RAW_EVENT);
    expect(id1).toBe(provider.dedupeId(RAW_EVENT));
    expect(id1).toMatch(/^shippo:[0-9a-f]{64}$/);
    expect(id1).not.toBe(provider.dedupeId(Buffer.from(RAW_EVENT.toString("utf8").replace("true", "false"))));
  });
});

// ---------------------------------------------------------------------------
// 8. Adapter — address verification: the 6-row mapping via the NINE fixtures
//    (mocked v2 responses; key fields frozen as the wire contract)
// ---------------------------------------------------------------------------

/** A v2 validate response built from the recorded key fields. */
function validateResponse(fields: {
  value: "valid" | "partially_valid" | "invalid";
  changed?: string[];
  score?: "high" | "medium" | "low";
  recommended?: Record<string, unknown>;
  recommendedInAnalysis?: boolean;
  reason?: string;
}): Record<string, unknown> {
  const analysis: Record<string, unknown> = {
    validation_result: { value: fields.value, ...(fields.reason ? { reason: fields.reason } : {}) },
    changed_attributes: fields.changed ?? [],
  };
  const recommended = fields.recommendedInAnalysis ? undefined : fields.recommended;
  if (fields.recommendedInAnalysis && fields.recommended) analysis.recommended_address = fields.recommended;
  if (fields.score) analysis.confidence_result = { score: fields.score };
  return { analysis, ...(recommended ? { recommended_address: recommended } : {}) };
}

/** Stubbed fetch that answers every call with a mutable fixture. */
function stubValidate(state: { body: Record<string, unknown> }): { calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push([String(url), (init ?? {}) as RequestInit]);
    return jsonRes(state.body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

const IT_STREET_FIXTURE_INPUT: ProviderAddress = {
  name: "Marco Bianchi",
  line1: "Via del Corzo 100",
  city: "Roma",
  postalCode: "00186",
  country: "IT",
};

describe("verifyAddress — the nine fixtures (6-row mapping)", () => {
  let state: { body: Record<string, unknown> };
  let stubbed: { calls: Array<[string, RequestInit]> };

  beforeEach(() => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    state = { body: {} };
    stubbed = stubValidate(state);
  });

  function expectRow(outcome: { status: string; reason?: string; suggestion?: ProviderAddress } | null): void {
    expect(outcome).not.toBeNull();
  }

  // Fixture 1 — IT street typo corrected: partially_valid, changed street, high → suggested
  it("1. IT street typo → suggested with the corrected line", async () => {
    state.body = validateResponse({
      value: "partially_valid",
      changed: ["street"],
      score: "high",
      recommended: { street1: "Via del Corso 100", street2: null, city: "ROMA", zip_code: "00186", country: "IT" },
    });
    const provider = new ShippoShippingProvider();
    const outcome = await provider.verifyAddress(IT_STREET_FIXTURE_INPUT);
    expectRow(outcome);
    expect(outcome!.status).toBe("suggested");
    expect(outcome!.suggestion).toEqual({
      name: "Marco Bianchi", // caller's name carried (the wire has none)
      line1: "Via del Corso 100",
      city: "ROMA",
      postalCode: "00186",
      country: "IT",
    });
  });

  // Fixture 2 — IT wrong CAP corrected: changed postal, high → suggested
  it("2. IT wrong CAP → suggested", async () => {
    state.body = validateResponse({
      value: "partially_valid",
      changed: ["postal"],
      score: "high",
      recommended: { street1: "Via Montenapoleone 1", city: "Milano", zip_code: "20121", country: "IT" },
    });
    const provider = new ShippoShippingProvider();
    const outcome = await provider.verifyAddress({
      name: "Marco Bianchi", line1: "Via Montenapoleone 1", city: "Milano", postalCode: "10100", country: "IT",
    });
    expectRow(outcome);
    expect(outcome!.status).toBe("suggested");
    expect(outcome!.suggestion!.postalCode).toBe("20121");
  });

  // Fixture 3 — IT province added: changed state_province ONLY → verified, NO suggestion
  it("3. IT province-only correction → verified (never a suggestion)", async () => {
    state.body = validateResponse({
      value: "partially_valid",
      changed: ["state_province"],
      score: "high",
      recommended: { street1: "Via del Corso 100", city: "Roma", zip_code: "00186", country: "IT", state_province: "RM" },
    });
    const provider = new ShippoShippingProvider();
    const outcome = await provider.verifyAddress(IT_STREET_FIXTURE_INPUT);
    expectRow(outcome);
    expect(outcome).toEqual({ status: "verified" });
  });

  // Fixture 4 — IT false negative: invalid → unverified + code, recommended ignored
  it("4. false negative (Piazza del Duomo 1, Milano → invalid) → unverified + shippo_address_invalid", async () => {
    state.body = validateResponse({
      value: "invalid",
      reason: "address_premise_invalid",
      recommended: { street1: "Piazza del Duomo 1", city: "Milano", zip_code: "20122", country: "IT" },
    });
    const provider = new ShippoShippingProvider();
    const outcome = await provider.verifyAddress({
      name: "Marco Bianchi", line1: "Piazza del Duomo 1", city: "Milano", postalCode: "20122", country: "IT",
    });
    expectRow(outcome);
    expect(outcome).toEqual({ status: "unverified", reason: "shippo_address_invalid" });
  });

  // Fixtures 5+6 — DE correct addresses → verified
  it("5+6. DE correct addresses → verified", async () => {
    state.body = validateResponse({ value: "valid" });
    const provider = new ShippoShippingProvider();
    await expect(
      provider.verifyAddress({ name: "Hans Müller", line1: "Hauptstraße 1", city: "Berlin", postalCode: "10115", country: "DE" }),
    ).resolves.toEqual({ status: "verified" });
    await expect(
      provider.verifyAddress({ name: "Hans Müller", line1: "Marienplatz 8", city: "München", postalCode: "80331", country: "DE" }),
    ).resolves.toEqual({ status: "verified" });
  });

  // Fixture 7 — DE wrong PLZ corrected, high → suggested
  it("7. DE wrong PLZ, high confidence → suggested", async () => {
    state.body = validateResponse({
      value: "partially_valid",
      changed: ["postal"],
      score: "high",
      recommended: { street1: "Kurfürstendamm 21", city: "Berlin", zip_code: "10719", country: "DE" },
    });
    const provider = new ShippoShippingProvider();
    const outcome = await provider.verifyAddress({
      name: "Hans Müller", line1: "Kurfürstendamm 21", city: "Berlin", postalCode: "99999", country: "DE",
    });
    expectRow(outcome);
    expect(outcome!.status).toBe("suggested");
    expect(outcome!.suggestion!.postalCode).toBe("10719");
  });

  // Fixtures 8+9 — DE low-confidence partial validity → unverified + low-confidence code
  it("8+9. DE street typos, low confidence → unverified + shippo_address_low_confidence", async () => {
    state.body = validateResponse({ value: "partially_valid", changed: ["street"], score: "low" });
    const provider = new ShippoShippingProvider();
    for (const line1 of ["Lindn 5", "Xyzstraße 999"]) {
      const outcome = await provider.verifyAddress({
        name: "Hans Müller", line1, city: "Berlin", postalCode: "10115", country: "DE",
      });
      expectRow(outcome);
      expect(outcome).toEqual({ status: "unverified", reason: "shippo_address_low_confidence" });
    }
  });

  it("medium confidence is treated conservatively like low (row 4)", async () => {
    state.body = validateResponse({ value: "partially_valid", changed: ["street"], score: "medium" });
    const provider = new ShippoShippingProvider();
    await expect(provider.verifyAddress(IT_STREET_FIXTURE_INPUT)).resolves.toEqual({
      status: "unverified",
      reason: "shippo_address_low_confidence",
    });
  });

  it("high score WITHOUT a suggestion-eligible change is not a suggestion (row 6 fallback)", async () => {
    state.body = validateResponse({
      value: "partially_valid",
      changed: ["name_tag"],
      score: "high",
      recommended: { street1: "Via del Corso 100", city: "Roma", zip_code: "00186", country: "IT" },
    });
    const provider = new ShippoShippingProvider();
    await expect(provider.verifyAddress(IT_STREET_FIXTURE_INPUT)).resolves.toEqual({ status: "unverified" });
  });

  it("missing/unmappable analysis → unverified with NO reason (row 6)", async () => {
    state.body = { something: "else entirely" };
    const provider = new ShippoShippingProvider();
    await expect(provider.verifyAddress(IT_STREET_FIXTURE_INPUT)).resolves.toEqual({ status: "unverified" });
  });

  it("wire-name freeze: recommended_address + confidence under analysis (root fallback) still maps", async () => {
    state.body = validateResponse({
      value: "partially_valid",
      changed: ["street"],
      score: "high",
      recommended: { street1: "Via del Corso 100", city: "Roma", zip_code: "00186", country: "IT" },
      recommendedInAnalysis: true,
    });
    const provider = new ShippoShippingProvider();
    const outcome = await provider.verifyAddress(IT_STREET_FIXTURE_INPUT);
    expect(outcome!.status).toBe("suggested");
  });

  it("malformed recommended_address (missing fields) downgrades the suggestion path to plain unverified", async () => {
    state.body = validateResponse({
      value: "partially_valid",
      changed: ["street"],
      score: "high",
      recommended: { street1: "Via del Corso 100" }, // city/zip/country missing
    });
    const provider = new ShippoShippingProvider();
    await expect(provider.verifyAddress(IT_STREET_FIXTURE_INPUT)).resolves.toEqual({ status: "unverified" });
  });
});

describe("verifyAddress — wire hygiene", () => {
  it("GET /v2/addresses/validate carries ONLY typed fields — never the name, never free text", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const state = { body: validateResponse({ value: "valid" }) };
    const { calls } = stubValidate(state);
    const provider = new ShippoShippingProvider();
    await provider.verifyAddress(
      { name: "Secretive Name", line1: "Via del Corso 100", line2: "Int 3", city: "Roma", postalCode: "00186", country: "IT" },
      AbortSignal.timeout(3000),
    );
    const [url, init] = calls[0]!;
    expect(url.startsWith("https://api.goshippo.com/v2/addresses/validate?")).toBe(true);
    expect(init.method).toBe("GET");
    const params = new URL(url).searchParams;
    expect(params.get("street1")).toBe("Via del Corso 100");
    expect(params.get("street2")).toBe("Int 3");
    expect(params.get("city")).toBe("Roma");
    expect(params.get("zip_code")).toBe("00186");
    expect(params.get("country")).toBe("IT");
    expect([...params.keys()].sort()).toEqual(["city", "country", "street1", "street2", "zip_code"].sort());
    expect(params.get("name")).toBeNull();
  });

  it("respects the caller's signal (passed through to fetch)", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const state = { body: validateResponse({ value: "valid" }) };
    const { calls } = stubValidate(state);
    const provider = new ShippoShippingProvider();
    const signal = AbortSignal.timeout(3000);
    await provider.verifyAddress(PROVIDER_ADDRESS, signal);
    expect((calls[0]![1] as { signal?: AbortSignal }).signal).toBe(signal);
  });

  it("provider fault (HTTP 500 / malformed JSON) THROWS — callers map to not_checked", async () => {
    setEnv("SHIPPO_API_KEY", "shippo_test_KEY");
    const provider = new ShippoShippingProvider();
    const fail = vi.fn().mockResolvedValue(jsonRes({}, 500));
    vi.stubGlobal("fetch", fail);
    await expect(provider.verifyAddress(PROVIDER_ADDRESS)).rejects.toThrow(/HTTP 500/);
    const html = vi.fn().mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));
    vi.stubGlobal("fetch", html);
    await expect(provider.verifyAddress(PROVIDER_ADDRESS)).rejects.toThrow();
  });

  it("key unset (even after construction) → null, never a call", async () => {
    const provider = new ShippoShippingProvider();
    const state = { body: validateResponse({ value: "valid" }) };
    const { calls } = stubValidate(state);
    await expect(provider.verifyAddress(PROVIDER_ADDRESS)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});
