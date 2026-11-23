// ShippingProvider interface + registry contract tests (THI-1246; spec
// docs/specs/shipping-provider-layer.md §Test plan, parent THI-1244).
//
// Two layers:
//  1. Registry/config: exactly one provider per deployment, selected once via
//     SHIPPING_PROVIDER (case-insensitive, empty = unset = default easypost);
//     an unrecognized value fails CLOSED (boot error + shipping disabled) no
//     matter which API keys are present; only the selected provider's env
//     pair is read, another provider's keys are ignored with a boot warning.
//  2. Adapter contract: the checks every ShippingProvider implementation must
//     satisfy — degraded nulls (F1 empty-is-unset), ProviderError mapping,
//     webhook verify/parse/redact/dedupe semantics. THI-1247 (shippo) reuses
//     this suite shape for its adapter; under the default easypost provider
//     every asserted string is byte-identical to the pre-interface behavior.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { orderFlowConfig } from "../src/config.js";
import { getShippingProvider } from "../src/shipping/registry.js";
import { EasyPostShippingProvider } from "../src/shipping/easypost-adapter.js";
import {
  pickRate,
  ProviderError,
  VerificationError,
  WebhookParseError,
  type ProviderShipmentInput,
} from "../src/shipping/provider.js";
import { EasyPostError } from "../src/easypost.js";

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
});

// ---------------------------------------------------------------------------
// 1. Registry + selection (config.ts)
// ---------------------------------------------------------------------------

describe("SHIPPING_PROVIDER selection — one provider per deployment", () => {
  it("unset → default easypost, enabled iff its API key is set", () => {
    const cfg = orderFlowConfig();
    expect(cfg.shippingProvider).toBe("easypost");
    expect(cfg.shippingEnabled).toBe(false); // no EASYPOST_API_KEY in the test env
    setEnv("EASYPOST_API_KEY", "EZABC");
    expect(orderFlowConfig().shippingEnabled).toBe(true);
  });

  it("case-insensitive + whitespace-tolerant (\" EASYPOST \")", () => {
    setEnv("EASYPOST_API_KEY", "EZABC");
    setEnv("SHIPPING_PROVIDER", "  EASYPOST ");
    const cfg = orderFlowConfig();
    expect(cfg.shippingProvider).toBe("easypost");
    expect(cfg.shippingEnabled).toBe(true);
  });

  it("unrecognized value → boot error + fail-closed (shipping fully disabled)", () => {
    const boot = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv("EASYPOST_API_KEY", "EZABC");
    setEnv("EASYPOST_WEBHOOK_SECRET", "ez_sec");
    setEnv("SHIPPING_PROVIDER", "carrierpigeon");
    const cfg = orderFlowConfig();
    expect(boot).toHaveBeenCalled();
    expect(String(boot.mock.calls.at(-1)?.[0])).toContain("SHIPPING_PROVIDER");
    // Disabled even though the easypost env pair is fully present:
    expect(cfg.shippingEnabled).toBe(false);
    expect(cfg.carrierWebhookReady).toBe(false);
    expect(cfg.carrierWebhookSecret).toBeUndefined();
    expect(cfg.carrierWebhookSecretPrevious).toBeUndefined();
  });

  it("reads only the SELECTED provider's env pair; other providers' keys are ignored with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setEnv("EASYPOST_API_KEY", "EZABC");
    setEnv("EASYPOST_WEBHOOK_SECRET", "ez_sec");
    setEnv("SHIPPO_API_KEY", "SHIPPO-XYZ");
    const cfg = orderFlowConfig();
    expect(cfg.carrierWebhookSecret).toBe("ez_sec"); // selected provider's secret
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("SHIPPO_API_KEY");
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("easypost");
  });

  it("rotation secret is only carried when the current secret is set (F13 parity)", () => {
    setEnv("EASYPOST_API_KEY", "EZABC");
    setEnv("EASYPOST_WEBHOOK_SECRET_PREVIOUS", "old");
    const cfg = orderFlowConfig();
    expect(cfg.carrierWebhookReady).toBe(false);
    expect(cfg.carrierWebhookSecretPrevious).toBeUndefined();
  });
});

describe("getShippingProvider — the registry hands out the configured instance", () => {
  it("default configuration → the easypost adapter, wired with the cfg secrets", () => {
    setEnv("EASYPOST_API_KEY", "EZABC");
    setEnv("EASYPOST_WEBHOOK_SECRET", "ez_sec");
    setEnv("EASYPOST_WEBHOOK_SECRET_PREVIOUS", "ez_old");
    const cfg = orderFlowConfig();
    const provider = getShippingProvider(cfg);
    expect(provider.id).toBe("easypost");
    expect(provider.displayName).toBe("EasyPost");
    expect(provider.isConfigured()).toBe(true);
    setEnv("EASYPOST_API_KEY", "");
    expect(provider.isConfigured()).toBe(false); // F1: empty = unset
    setEnv("EASYPOST_API_KEY", "   ");
    expect(provider.isConfigured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Adapter contract — what every ShippingProvider must satisfy
// ---------------------------------------------------------------------------

function sign(payload: Buffer, secret: string): string {
  return "hmac-sha256-hex=" + crypto.createHmac("sha256", secret.normalize("NFKD")).update(payload).digest("hex");
}

const VALID_ADDRESS: ProviderShipmentInput = {
  toAddress: { name: "Buyer", line1: "Weg 1", city: "Berlin", postalCode: "10115", country: "DE" },
  fromAddress: { name: "Seller", line1: "Weg 2", city: "Berlin", postalCode: "10115", country: "DE" },
  weightGrams: 500,
};

describe("EasyPostShippingProvider — degraded contract (null iff not configured)", () => {
  it("createShipment / buyLabel / registerTracker return null with no API key", async () => {
    const provider = new EasyPostShippingProvider();
    expect(provider.isConfigured()).toBe(false);
    await expect(provider.createShipment(VALID_ADDRESS)).resolves.toBeNull();
    await expect(provider.buyLabel("shp_x", "rate_x")).resolves.toBeNull();
    await expect(provider.registerTracker("DHL", "JJD000")).resolves.toBeNull();
  });

  it("createShipment maps the transport result onto the interface shape", async () => {
    setEnv("EASYPOST_API_KEY", "EZABC");
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        id: "shp_123",
        rates: [{ id: "rate_1", carrier: "DHLExpress", service: "ExpressWorldwide", rate: "10.45", currency: "EUR" }],
      }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = new EasyPostShippingProvider();
      const shipment = await provider.createShipment(VALID_ADDRESS);
      expect(shipment).not.toBeNull();
      expect(shipment!.shipmentId).toBe("shp_123");
      expect(shipment!.rates).toEqual([
        { id: "rate_1", carrier: "DHLExpress", service: "ExpressWorldwide", costCents: 1045, currency: "EUR" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("EasyPostShippingProvider — error mapping", () => {
  it("EasyPostError IS a ProviderError carrying status + code (messages unchanged)", () => {
    const err = new EasyPostError("label purchase", 402, "rate_error");
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("rate_error");
    expect(err.message).toBe("easypost label purchase failed: HTTP 402 (rate_error)");
  });
});

describe("EasyPostShippingProvider — webhook contract (verify → parse → dedupe)", () => {
  const SECRET = "ez_webhook_secret";
  const PREVIOUS = "ez_old_secret";
  const provider = new EasyPostShippingProvider({ webhookSecret: SECRET, webhookSecretPrevious: PREVIOUS });

  const trackerEvent = (status: string, trackerId = "trk_abc"): Buffer =>
    Buffer.from(
      JSON.stringify({
        description: "tracker.updated",
        mode: "production",
        result: {
          id: trackerId,
          tracking_code: "JJD000123",
          carrier: "DHL",
          status,
          tracking_details: [
            { status: "in_transit", message: "sorted at hub Cologne", datetime: "2026-11-24T10:00:00Z" },
            { status, message: "signed for by FOO BAR", datetime: "2026-11-24T12:00:00Z" },
          ],
        },
      }),
    );

  it("missing header → VerificationError with the exact wire message", () => {
    expect(() => provider.verifyWebhook(Buffer.from("{}"), {})).toThrow(VerificationError);
    try {
      provider.verifyWebhook(Buffer.from("{}"), {});
    } catch (err) {
      expect((err as VerificationError).wireMessage).toBe("missing X-Hmac-Signature header");
    }
  });

  it("bad signature → VerificationError 'signature verification failed'", () => {
    const raw = trackerEvent("in_transit");
    expect(() => provider.verifyWebhook(raw, { "x-hmac-signature": sign(raw, "wrong") })).toThrow(
      /signature verification failed/,
    );
  });

  it("current secret verifies; previous secret verifies with the rotation warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = trackerEvent("in_transit");
    expect(() => provider.verifyWebhook(raw, { "x-hmac-signature": sign(raw, SECRET) })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    expect(() => provider.verifyWebhook(raw, { "x-hmac-signature": sign(raw, PREVIOUS) })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("EASYPOST_WEBHOOK_SECRET_PREVIOUS");
  });

  it("verifyWebhook fails closed when the adapter was built without a secret", () => {
    const bare = new EasyPostShippingProvider();
    const raw = trackerEvent("in_transit");
    expect(() => provider.verifyWebhook(raw, { "x-hmac-signature": sign(raw, SECRET) })).not.toThrow(); // sanity
    try {
      bare.verifyWebhook(raw, { "x-hmac-signature": sign(raw, SECRET) });
      expect.unreachable("expected VerificationError");
    } catch (err) {
      expect((err as VerificationError).wireMessage).toBe("signature verification failed");
    }
  });

  it("invalid JSON after a VALID signature → WebhookParseError with the wire message", () => {
    const raw = Buffer.from("this is not json");
    try {
      provider.parseWebhook(raw);
      expect.unreachable("expected WebhookParseError");
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookParseError);
      expect((err as WebhookParseError).wireMessage).toBe("invalid JSON body");
    }
  });

  it("parseWebhook redacts to exactly the F6 fields (free text never survives)", () => {
    const raw = trackerEvent("delivered");
    const ev = provider.parseWebhook(raw);
    expect(Object.keys(ev).sort()).toEqual(
      ["carrier", "carrier_status", "description", "mode", "occurred_at", "status", "tracking_code", "tracker_id"].sort(),
    );
    expect(ev).toEqual({
      description: "tracker.updated",
      mode: "production",
      tracker_id: "trk_abc",
      tracking_code: "JJD000123",
      carrier: "DHL",
      carrier_status: "delivered",
      status: "delivered",
      occurred_at: "2026-11-24T12:00:00Z", // LAST detail — and NOT its message text
    });
    expect(JSON.stringify(ev)).not.toContain("signed for by");
    expect(JSON.stringify(ev)).not.toContain("sorted at hub");
  });

  it("status normalization: available_for_pickup → out_for_delivery; unknown → unknown", () => {
    expect(provider.parseWebhook(trackerEvent("available_for_pickup")).status).toBe("out_for_delivery");
    expect(provider.parseWebhook(trackerEvent("cancelled")).status).toBe("unknown");
    expect(provider.parseWebhook(trackerEvent("something_new")).status).toBe("unknown");
  });

  it("dedupeId is provider-prefixed sha256 of the raw bytes", () => {
    const raw = trackerEvent("in_transit");
    const id = provider.dedupeId(raw);
    expect(id).toBe(`easypost:${crypto.createHash("sha256").update(raw).digest("hex")}`);
    expect(provider.dedupeId(raw)).toBe(id); // deterministic
    expect(provider.dedupeId(Buffer.concat([raw, Buffer.from(" ")]))).not.toBe(id);
  });
});

// ---------------------------------------------------------------------------
// 3. Provider-independent selection (pickRate — the shared implementation)
// ---------------------------------------------------------------------------

describe("pickRate — cheapest overall / preference substring / no-match null", () => {
  const rates = [
    { id: "r1", carrier: "DHLExpress", service: "Express", costCents: 900, currency: "EUR" },
    { id: "r2", carrier: "USPS", service: "Priority", costCents: 500, currency: "EUR" },
    { id: "r3", carrier: "DPD", service: "Standard", costCents: 700, currency: "USD" },
  ];

  it("cheapest overall", () => {
    expect(pickRate(rates)?.id).toBe("r2");
  });
  it("preference matches case-insensitively on a substring and picks the cheapest match", () => {
    expect(pickRate(rates, "dhl")?.id).toBe("r1");
    expect(pickRate(rates, "  DHL  ")?.id).toBe("r1"); // trimmed
  });
  it("no match → null (never silently buy a non-preferred carrier)", () => {
    expect(pickRate(rates, "UPS")).toBeNull();
    expect(pickRate([], null)).toBeNull();
  });
});
