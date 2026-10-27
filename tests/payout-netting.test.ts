// Payout netting — sellers bear the Stripe processing fee (THI-374; spec
// docs/specs/seller-borne-stripe-fees.md; Security review THI-375 incl.
// hardening R1 amount-invariant + R2 succeeded-charge check).
// DB-free: sellerNetTransferCents/createTransferForOrder only touch the
// Stripe client, faked here via setStripeForTests-style plain objects.

import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { createTransferForOrder, sellerNetTransferCents } from "../src/stripe.js";

/** An expanded PaymentIntent as sellerNetTransferCents expects it. */
function piWith(fee: number, opts: { amount?: number; currency?: string; chargeStatus?: string; noBt?: boolean; chargeAsString?: boolean } = {}) {
  return {
    latest_charge: opts.chargeAsString
      ? "ch_1" // unexpanded string — must fail closed
      : {
          id: "ch_1",
          status: opts.chargeStatus ?? "succeeded",
          balance_transaction: opts.noBt ? null : { amount: opts.amount ?? 10500, currency: opts.currency ?? "eur", fee },
        },
  };
}

const order = {
  id: "o1",
  payment_intent_id: "pi_1",
  price_cents: 10000,
  shipping_price_cents: 500,
  currency: "EUR",
};

function stripeReturning(pi: unknown): Stripe {
  return {
    paymentIntents: { retrieve: async () => pi },
    transfers: { create: async (a: { amount: number }) => ({ id: "tr_1", amount: a.amount }) },
  } as unknown as Stripe;
}

describe("sellerNetTransferCents (THI-374)", () => {
  it("returns gross − fee", async () => {
    const net = await sellerNetTransferCents(order, stripeReturning(piWith(182)));
    expect(net).toBe(10500 - 182);
  });

  it("fee 0 → full gross", async () => {
    const net = await sellerNetTransferCents(order, stripeReturning(piWith(0)));
    expect(net).toBe(10500);
  });

  it("clamps a pathological negative fee — never overpays", async () => {
    const net = await sellerNetTransferCents(order, stripeReturning(piWith(-50)));
    expect(net).toBe(10500);
  });

  it("throws payout_netting_unavailable when the balance transaction is missing (fail closed, never gross)", async () => {
    await expect(sellerNetTransferCents(order, stripeReturning(piWith(182, { noBt: true })))).rejects.toThrow(
      /payout_netting_unavailable: no balance transaction/,
    );
  });

  it("throws when latest_charge is an unexpanded string (R2 belt-and-braces)", async () => {
    await expect(sellerNetTransferCents(order, stripeReturning(piWith(182, { chargeAsString: true })))).rejects.toThrow(
      /payout_netting_unavailable: no succeeded charge/,
    );
  });

  it("throws when the latest charge is not succeeded (THI-375 R2)", async () => {
    await expect(sellerNetTransferCents(order, stripeReturning(piWith(182, { chargeStatus: "capturing" })))).rejects.toThrow(
      /payout_netting_unavailable: no succeeded charge/,
    );
  });

  it("throws payout_charge_mismatch on currency mismatch — refuses cross-currency settlement", async () => {
    await expect(sellerNetTransferCents(order, stripeReturning(piWith(182, { currency: "chf" })))).rejects.toThrow(
      /payout_charge_mismatch/,
    );
  });

  it("throws payout_charge_mismatch when bt.amount ≠ order gross (THI-375 R1: wrong base, never net)", async () => {
    await expect(sellerNetTransferCents(order, stripeReturning(piWith(182, { amount: 10000 })))).rejects.toThrow(
      /payout_charge_mismatch: balance transaction 10000 eur ≠ order 10500 eur/,
    );
  });

  it("throws when net < 1 cent (degenerate micro-price)", async () => {
    await expect(sellerNetTransferCents(order, stripeReturning(piWith(10500)))).rejects.toThrow(
      /payout_netting_unavailable: net 0c/,
    );
  });

  it("throws inconsistent_state without a payment intent — prevents blind gross transfer", async () => {
    await expect(sellerNetTransferCents({ ...order, payment_intent_id: null }, stripeReturning(piWith(182)))).rejects.toThrow(
      /inconsistent_state: paid order missing payment intent/,
    );
  });
});

describe("createTransferForOrder (THI-374)", () => {
  it("transfers the net amount under the payout:{order_id} idempotency key", async () => {
    const calls: Array<{ amount: number; currency: string; destination: string; key: string }> = [];
    const stripe = {
      paymentIntents: { retrieve: async () => piWith(182) },
      transfers: {
        create: async (a: { amount: number; currency: string; destination: string }, o: { idempotencyKey: string }) => {
          calls.push({ ...a, key: o.idempotencyKey });
          return { id: "tr_net" };
        },
      },
    } as unknown as Stripe;
    const transfer = await createTransferForOrder(order, "acct_seller", stripe);
    expect(transfer.id).toBe("tr_net");
    expect(calls).toEqual([{ amount: 10318, currency: "eur", destination: "acct_seller", key: "payout:o1" }]);
  });

  it("propagates the fail-closed error — no transfer is attempted when the fee is unknown", async () => {
    let transferCalled = false;
    const stripe = {
      paymentIntents: { retrieve: async () => piWith(182, { noBt: true }) },
      transfers: { create: async () => { transferCalled = true; return { id: "tr_bad" }; } },
    } as unknown as Stripe;
    await expect(createTransferForOrder(order, "acct_seller", stripe)).rejects.toThrow(/payout_netting_unavailable/);
    expect(transferCalled).toBe(false);
  });
});
