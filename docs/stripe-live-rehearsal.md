# Stripe-live rehearsal runbook — test-mode dry run (THI-562 work item 4)

Status: proposed (2026-11-10) · Owner: Architect (runbook) / DevOps (execution) ·
Hard gate: **do not flip Stripe live.** Live payments wait for board sign-off on
the Phase 0 terms rewrite. Test-mode keys only.

## Purpose

`src/stripe.ts` implements charge → hold → payout, but payments have never run
against the production deployment. This runbook rehearses the **exact config
flip** documented in `docs/deploy-vps.md` §5, with **test-mode** keys, so that
going live later is: swap three env values, recreate the container, re-register
the webhook. The rehearsal is done when every checklist row below has evidence.

## Prerequisites

- Test-mode Stripe account (dashboard in "test mode"): `sk_test_…` key,
  Connect enabled, one test express/standard connected account for the seller.
- A production-like seller + listing on the deployment (shippable item, small
  price, e.g. €1.00 — the seller-borne-fee verification amounts in
  `docs/deploy-vps.md` assume €1).
- DevOps executes on the VPS; all secrets stay in `/opt/thingery/.env` or the
  operator's password manager — never in this repo, issues, or chat.

## Steps

1. **Config flip (test mode).** In `/opt/thingery/.env` set
   `STRIPE_SECRET_KEY=sk_test_…`; in the Stripe **test-mode** dashboard
   register webhook `https://thingery.dev/api/webhooks/stripe` with the same
   nine events as §5 (`checkout.session.completed`,
   `payment_intent.succeeded`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`, `transfer.created`,
   `transfer.updated`, `transfer.paid`, `account.updated`); set
   `STRIPE_WEBHOOK_SECRET=whsec_…` (test signing secret). Recreate:
   `cd /opt/thingery && docker compose -f docker-compose.prod.yml up -d`.
2. **Boot verify.** Healthz `200`; boot log shows test mode; a listing shows
   `payment_available: true` via MCP `get_item`; dashboard webhook page shows
   signature-verified deliveries.
3. **Charge.** As the buyer, `create_order` → follow `payment_url` → pay with
   test card `4242 4242 4242 4242`. Expect: order `pending → sold` via
   `stripe_payment` (#2); `payment_intent.succeeded` event consumed; seller
   sees the shipping address in `get_order`.
4. **Ship.** Seller `record_tracking` (or `buy_shipping_label` once work item
   2 ships); carrier/pending test tracker moves the order through
   `label_issued → in_transit → delivered` (or buyer `confirm_receipt`).
5. **Hold → payout.** Buyer `release_funds` (#17) → `payout_pending`; test
   `transfer.paid` event → `paid_out` (#20). Verify the seller-borne-fee
   invariant (THI-374/THI-375 R1): transfer = `bt.amount − bt.fee`, `bt.amount`
   = order gross; for €1 expect seller ≈ €0.73. Use read-only Stripe CLI
   retrieval — never a second charge.
6. **Dispute paths.** (a) `open_dispute` (#15) on a second delivered test
   order → resolve via the **admin UI** (work item 3) `refund`: transfer
   reversal + refund → `refunded`; (b) a third order resolved `release` →
   `paid_out`. (c) If Stripe test mode supports it, file a test chargeback
   (`charge.dispute.created`) → `disputed` (#22); close it won → restore
   (#22r). If the test dashboard cannot produce it, note it and rely on the
   webhook fixture tests — do not skip silently.
7. **Sweep sanity.** With two orders parked `sold` (no tracking) confirm the
   stale-sale sweep arms the deadline (rules per `src/orders-sweep.ts`);
   no action needed beyond observing the scheduled deadline in `get_order`.
8. **Rollback.** Remove/unset the `STRIPE_*` lines, recreate the container,
   confirm `payments_not_configured` returns and healthz stays `200`. Test
   orders remain as data; that is expected and harmless.

## Evidence checklist (post on the DevOps issue, no secrets)

- [ ] Boot log line (test mode) + healthz 200
- [ ] Order id + event trail for the paid order (`order_events` rows #2…#20)
- [ ] Transfer id + fee-invariant numbers for the €1 payout
- [ ] Dispute-refund and dispute-release order ids + admin UI screenshots
- [ ] Chargeback round-trip order id, or the noted gap
- [ ] Webhook delivery log screenshot (signature-verified)
- [ ] Rollback confirmation (payments_not_configured + healthz 200)

## Exit condition

Rehearsal documented + evidence posted → the **only** remaining step to go
live is board sign-off on the terms rewrite (Phase 0). DevOps must not
proceed to live keys without that sign-off recorded on THI-562.
