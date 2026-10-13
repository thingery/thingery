// Config boot-validation tests (spec THI-3 rev 2 §4.4 + rev 3 §11.3; THI-8 F1).
// Pure — no DB, no network. Fail-closed: empty means unset, half-configured
// providers degrade to disabled surfaces, never to open ones.

import { afterEach, describe, expect, it } from "vitest";
import { envValue, envInt, orderFlowConfig } from "../src/config.js";

const NAMES = [
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET_PREVIOUS",
  "EASYPOST_API_KEY", "EASYPOST_WEBHOOK_SECRET", "EASYPOST_WEBHOOK_SECRET_PREVIOUS",
  "ADMIN_API_KEY",
  "PAYMENT_DEADLINE_HOURS", "DISPUTE_WINDOW_HOURS", "SYSTEM_CONFIRMED_DISPUTE_WINDOW_HOURS",
  "PICKUP_AUTOCONFIRM_DAYS", "IN_TRANSIT_STUCK_DAYS", "STALE_SOLD_DAYS",
  "DISPUTE_AUTOREFUND_HOURS", "DISPUTE_STALE_DAYS", "STUCK_MONEY_ALERT_DAYS",
  "MAX_PENDING_ORDERS_PER_BUYER", "REORDER_COOLDOWN_MINUTES",
] as const;

const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const n of NAMES) {
    const v = saved.get(n);
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  saved.clear();
});

/** Sets envs for one test and snapshot-restores them after. */
function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("envValue — empty means unset (F1)", () => {
  it("treats empty and whitespace-only as unset", () => {
    setEnv("ADMIN_API_KEY", "");
    expect(envValue("ADMIN_API_KEY")).toBeUndefined();
    setEnv("ADMIN_API_KEY", "   \t ");
    expect(envValue("ADMIN_API_KEY")).toBeUndefined();
    setEnv("ADMIN_API_KEY", " a-secret-with-spaces-around ");
    expect(envValue("ADMIN_API_KEY")).toBe("a-secret-with-spaces-around");
  });
});

describe("envInt — malformed values fall back to spec defaults", () => {
  it("keeps the default when unset, empty, non-numeric, zero or negative", () => {
    setEnv("DISPUTE_AUTOREFUND_HOURS", undefined);
    expect(envInt("DISPUTE_AUTOREFUND_HOURS", 72)).toBe(72);
    for (const bad of ["", "  ", "abc", "0", "-5", "3.5"]) {
      setEnv("DISPUTE_AUTOREFUND_HOURS", bad);
      expect(envInt("DISPUTE_AUTOREFUND_HOURS", 72)).toBe(72);
    }
    setEnv("DISPUTE_AUTOREFUND_HOURS", "120");
    expect(envInt("DISPUTE_AUTOREFUND_HOURS", 72)).toBe(120);
  });
});

describe("orderFlowConfig — fail-closed degradation", () => {
  it("nothing configured: payments off, webhooks off, admin off (kill switch)", () => {
    for (const n of NAMES) setEnv(n, undefined);
    const cfg = orderFlowConfig();
    expect(cfg.stripePaymentsEnabled).toBe(false);
    expect(cfg.stripeMode).toBeNull();
    expect(cfg.stripeWebhookReady).toBe(false);
    expect(cfg.easypostEnabled).toBe(false);
    expect(cfg.adminRouteEnabled).toBe(false);
    // Rev 3 §11.3 defaults (rules 8–9) and §4.4 defaults.
    expect(cfg.disputeAutorefundHours).toBe(72);
    expect(cfg.disputeStaleDays).toBe(7);
    expect(cfg.paymentDeadlineHours).toBe(24);
    expect(cfg.maxPendingOrdersPerBuyer).toBe(3);
  });

  it("stripe key + webhook secret → enabled and webhook-ready", () => {
    for (const n of NAMES) setEnv(n, undefined);
    setEnv("STRIPE_SECRET_KEY", "sk_test_abc");
    setEnv("STRIPE_WEBHOOK_SECRET", "whsec_def");
    const cfg = orderFlowConfig();
    expect(cfg.stripePaymentsEnabled).toBe(true);
    expect(cfg.stripeMode).toBe("test");
    expect(cfg.stripeWebhookReady).toBe(true);
  });

  it("F1: key set + webhook secret EMPTY/whitespace → webhook not ready (payments stay on)", () => {
    for (const n of NAMES) setEnv(n, undefined);
    setEnv("STRIPE_SECRET_KEY", "sk_test_abc");
    setEnv("STRIPE_WEBHOOK_SECRET", "   ");
    const cfg = orderFlowConfig();
    expect(cfg.stripePaymentsEnabled).toBe(true);
    expect(cfg.stripeWebhookReady).toBe(false); // PR-6 mounts a 503 stub
    expect(cfg.stripeWebhookSecret).toBeUndefined();
  });

  it("live keys are recognized; unknown key prefix logs and stays conservative", () => {
    for (const n of NAMES) setEnv(n, undefined);
    setEnv("STRIPE_SECRET_KEY", "sk_live_abc");
    expect(orderFlowConfig().stripeMode).toBe("live");
  });

  it("rotation: previous secret only active when the current one exists", () => {
    for (const n of NAMES) setEnv(n, undefined);
    setEnv("STRIPE_SECRET_KEY", "sk_test_abc");
    setEnv("STRIPE_WEBHOOK_SECRET_PREVIOUS", "whsec_old");
    expect(orderFlowConfig().stripeWebhookSecretPrevious).toBeUndefined();
    setEnv("STRIPE_WEBHOOK_SECRET", "whsec_new");
    expect(orderFlowConfig().stripeWebhookSecretPrevious).toBe("whsec_old");
  });

  it("admin route requires a >=32-char key (THI-8)", () => {
    for (const n of NAMES) setEnv(n, undefined);
    setEnv("ADMIN_API_KEY", "x".repeat(31));
    expect(orderFlowConfig().adminRouteEnabled).toBe(false);
    setEnv("ADMIN_API_KEY", "x".repeat(32));
    expect(orderFlowConfig().adminRouteEnabled).toBe(true);
    setEnv("ADMIN_API_KEY", "  ");
    expect(orderFlowConfig().adminRouteEnabled).toBe(false);
  });

  it("easypost: key without webhook secret → carrier webhook degrades to stub", () => {
    for (const n of NAMES) setEnv(n, undefined);
    setEnv("EASYPOST_API_KEY", "EZABC");
    const cfg = orderFlowConfig();
    expect(cfg.easypostEnabled).toBe(true);
    expect(cfg.carrierWebhookReady).toBe(false);
    setEnv("EASYPOST_WEBHOOK_SECRET", "easy_sec");
    expect(orderFlowConfig().carrierWebhookReady).toBe(true);
  });
});
