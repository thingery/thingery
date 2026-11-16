// THI-760 plan Phase 2 / THI-780 PR 1: notification preferences + policy
// classes (pure — no DB). The locked money class is the headline: attempts to
// disable money email are rejected at write time and ignored at read time,
// while ordinary transactional email honors per-channel opt-out.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  emailAllowedByPrefs,
  eventPolicyClass,
  parseNotificationPrefs,
  sanitizePrefsUpdate,
} from "../src/notify/prefs.js";

describe("parseNotificationPrefs (tolerant read)", () => {
  it("defaults for missing/garbage input", () => {
    expect(parseNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs("nope")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs([1, 2])).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs({})).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("keeps legal values, falls back per-key on garbage values", () => {
    expect(parseNotificationPrefs({ transactional_orders: "in_app", digest: "weekly" })).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      transactional_orders: "in_app",
      digest: "weekly",
    });
    expect(parseNotificationPrefs({ transactional_orders: "carrier-pigeon", digest: 7, locale: "fr" })).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );
  });

  it("money class is locked at read time — stored attempts to unlock are ignored", () => {
    expect(parseNotificationPrefs({ transactional_money: "in_app" }).transactional_money).toBe("email+in_app");
  });
});

describe("sanitizePrefsUpdate (strict write)", () => {
  it("accepts legal partial updates", () => {
    const r = sanitizePrefsUpdate({ transactional_orders: "in_app" });
    expect(r.errors).toEqual([]);
    expect(r.prefs).toEqual({ transactional_orders: "in_app" });

    const r2 = sanitizePrefsUpdate({ digest: "daily", locale: "en" });
    expect(r2.errors).toEqual([]);
    expect(r2.prefs).toEqual({ digest: "daily", locale: "en" });
  });

  it("rejects attempts to disable the locked money class (plan §5a)", () => {
    for (const bad of ["in_app", "none", "email", "off", ""]) {
      const r = sanitizePrefsUpdate({ transactional_money: bad });
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0].field).toBe("transactional_money");
      expect(r.errors[0].reason).toContain("locked");
    }
  });

  it("explicit no-op write of the locked value is accepted", () => {
    const r = sanitizePrefsUpdate({ transactional_money: "email+in_app" });
    expect(r.errors).toEqual([]);
    expect(r.prefs).toEqual({}); // nothing to change
  });

  it("rejects illegal values and unknown fields", () => {
    const r = sanitizePrefsUpdate({ transactional_orders: "sms", digest: "hourly", locale: "de", spam: "yes" });
    expect(r.errors.map((e) => e.field)).toEqual(["transactional_orders", "digest", "locale", "spam"]);
    expect(r.prefs).toEqual({});
  });

  it("rejects non-object bodies; ignores null values (merge-patch)", () => {
    expect(sanitizePrefsUpdate("x").errors[0].reason).toContain("object");
    expect(sanitizePrefsUpdate([1]).errors[0].reason).toContain("object");
    const r = sanitizePrefsUpdate({ digest: null });
    expect(r.errors).toEqual([]);
    expect(r.prefs).toEqual({});
  });
});

describe("policy classes (plan §5 — one decision, used by the delivery sweep)", () => {
  it("classifies money/security-critical events", () => {
    for (const e of [
      "buyer.payment_received",
      "buyer.refund_initiated",
      "buyer.refund_confirmed",
      "buyer.dispute_outcome",
      "seller.dispute_opened",
      "seller.chargeback",
      "seller.dispute_resolved",
      "seller.payout_paid",
    ]) {
      expect(eventPolicyClass(e)).toBe("money");
      expect(eventPolicyClass(`${e}.v1`)).toBe("money"); // outbox template form
    }
  });

  it("classifies everything else as ordinary transactional", () => {
    expect(eventPolicyClass("seller.item_sold")).toBe("orders");
    expect(eventPolicyClass("buyer.item_shipped.v1")).toBe("orders");
    expect(eventPolicyClass("buyer.order_placed")).toBe("orders");
  });

  it("money email cannot be disabled — even fully opted-out prefs keep it on", () => {
    const optedOut = { ...DEFAULT_NOTIFICATION_PREFS, transactional_orders: "in_app" as const };
    expect(emailAllowedByPrefs(optedOut, "seller.item_sold.v1")).toBe(false);
    expect(emailAllowedByPrefs(optedOut, "buyer.order_placed.v1")).toBe(false);
    expect(emailAllowedByPrefs(optedOut, "buyer.refund_confirmed.v1")).toBe(true);
    expect(emailAllowedByPrefs(optedOut, "seller.chargeback.v1")).toBe(true);
    expect(emailAllowedByPrefs(optedOut, "seller.payout_paid.v1")).toBe(true);
  });

  it("ordinary transactional follows transactional_orders; default is email", () => {
    expect(emailAllowedByPrefs(DEFAULT_NOTIFICATION_PREFS, "seller.item_sold.v1")).toBe(true);
    expect(
      emailAllowedByPrefs({ ...DEFAULT_NOTIFICATION_PREFS, transactional_orders: "in_app" }, "buyer.item_shipped.v1"),
    ).toBe(false);
  });

  it("digest templates are opt-in only (default none)", () => {
    expect(emailAllowedByPrefs(DEFAULT_NOTIFICATION_PREFS, "digest.daily.v1")).toBe(false);
    expect(emailAllowedByPrefs({ ...DEFAULT_NOTIFICATION_PREFS, digest: "daily" }, "digest.daily.v1")).toBe(true);
    expect(emailAllowedByPrefs({ ...DEFAULT_NOTIFICATION_PREFS, digest: "weekly" }, "digest.daily.v1")).toBe(true);
  });
});
