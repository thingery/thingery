# Spec: buy shipping labels through the product — EasyPost live (THI-562 work item 2)

Status: proposed (2026-11-10) · Owner: Architect · Review: Security (spend + external API + addresses), CEO sign-off required — touches protected paths `db/schema.sql`, `src/tools.ts`.

## Problem

Nobody buys a label through Thingery. Sellers record carrier + tracking by
hand (`record_tracking`), and production has no EasyPost keys
(`docs/deploy-vps.md` §5 "Known gap"). The north-star exit — first completed,
protected order — needs `sold → label_issued` to be a purchase, not a
keystroke: the seller prints a Thingery-bought label, the tracker is real,
carrier webhooks drive `in_transit → delivered`.

## Context

- `src/easypost.ts` registers **trackers only** (`createEasyPostTracker`,
  degraded mode when `EASYPOST_API_KEY` unset). Carrier webhooks
  (`src/webhooks-carrier.ts`) already resolve trackers → orders and apply
  transitions #10/#12/#14.
- `orders` already has `carrier`, `tracking_code`, `tracker_id` (unique),
  `label_url` (https-only, F16).
- The buyer's address is on the order and released to the seller while
  shipping is due (stripe: from `sold`; off_platform: after buyer consent).
- The seller's **from** address is not stored anywhere — supplied per
  purchase, not persisted (YAGNI; see Open questions).
- `items` carries `weight_grams` / `dimensions_mm` estimates from listing
  time — good defaults, seller-overridable at purchase.

## Proposed design

New seller tool `buy_shipping_label` on a `sold`, shippable order:

1. Validate: caller is the seller; `status = sold` (exact CAS precondition);
   `fulfillment = shipping`; the buyer address is visible to the seller
   (stripe: yes; off_platform: requires `shipping_address_shared_at`).
2. Build the EasyPost shipment: `to_address` = order `shipping_address`;
   `from_address` = seller-supplied zod-validated address (same shape as the
   buyer address schema, F16 rules: max lengths, unknown keys rejected);
   parcel = `weight_grams` + `dimensions_mm` from the item, overridable.
3. Create shipment → fetch rates → pick the lowest-cost rate, or the cheapest
   rate matching an optional `carrier_preference` (e.g. `"DHL"`).
4. Buy the label (EasyPost `/v2/shipments/:id/buy`). Result gives
   `label_url` (https), `tracker.id`, `tracking_code`, `carrier`.
5. Persist `carrier, tracking_code, tracker_id, label_url` and a
   `label_purchase` snapshot, **in the same transaction** as the state
   transition `sold → label_issued` via a **new trigger `label_purchased`**
   (transition #5b, actor `seller`, both payment modes — off_platform sellers
   ship too).

**Blast radius of the spend race:** the label is bought at EasyPost *before*
the status CAS. If the order left `sold` first (cancel race), the CAS fails,
we keep the label orphaned at EasyPost, log a `label_bought_orphan` security
event with the order id and shipment id, and the operator reconciles manually
(EasyPost refunds unused labels). This is a bounded, rare, observable cost —
accepted; alternatives (CAS-then-buy leaves orders labeled but unbuyable, or
two-phase EasyPost holds) add state for no v1 benefit (Simplicity lens).

**Who pays:** the platform's EasyPost account (labels are Thingery-borne
cost, consistent with "free for buyers and sellers"). Cost exposure is capped
by a durable daily quota.

**Quota (durable, DB-backed):** `seller_label_quota` mirrors the
`seller_upload_quota` pattern — 10 label purchases per seller per UTC day.
Over-quota returns `rate_limited` with the reset time.

## Data model changes (protected: `db/schema.sql`)

Additive:

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_purchase JSONB;
-- {shipment_id, rate_id, carrier, service, cost_cents, currency, bought_at}

CREATE TABLE IF NOT EXISTS seller_label_quota (
  seller_id  UUID NOT NULL REFERENCES sellers(id),
  day        DATE NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (seller_id, day)
);
```

## API / MCP tool changes (protected: `src/tools.ts`)

One new tool (additive; registry count 9 → 10 after messaging lands):

- **`buy_shipping_label`** — `order_id: uuid`;
  `from_address: {name, line1, line2?, city, postal_code, country, phone?}`;
  `weight_grams?: int (default: item's, else required)`;
  `dimensions_mm?: {length, width, height} (default: item's)`;
  `carrier_preference?: string (optional carrier name substring)`.
- Returns the updated order (same shape as `record_tracking`) plus
  `label: {label_url, carrier, tracking_code, cost: "{currency} {cost}"}`.
- Idempotency: calling again on a `label_issued` order with the same shipment
  returns the stored label (no second purchase); different input → error
  directing to the existing `record_tracking` correction path.
- `src/easypost.ts` grows `createEasyPostShipment` + `buyEasyPostLabel`
  (not a protected path; same degraded-mode conventions as trackers).

State machine: `TRANSITIONS` gains
`{ id: "5b", from: ["sold"], to: "label_issued", trigger: "label_purchased", actors: ["seller"] }`.
Illegal for any other status; the CAS enforces it.

## Migration plan

Additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS` + new quota table, both
replay-safe. `label_purchase` stays NULL for every existing order — old rows
and all existing tool outputs unchanged. Expand-contract: no contract phase
required (nothing is removed or narrowed).

## Test plan

- Unit: easypost client (fetch seam: rate list, buy, error mapping),
  address zod (F16 parity with buyer address), quota increment/reset,
  transition #5b legality matrix.
- Integration: happy path sold → label_issued with persisted tracker + label
  snapshot; off_platform without consent → error naming `share_shipping_address`;
  cancel-race (order moves between validate and CAS) → orphan alert fired,
  order untouched; quota wall at 11th label; idempotent re-call.
- Webhook: the bought tracker's carrier events drive #10/#12 unchanged
  (existing tests must pass with a `label_purchased`-originated tracker).

## Rollout + rollback

- Roll out code with `EASYPOST_API_KEY` still unset → tool answers
  `payments_not_configured`-style `easypost_not_configured` (degraded mode,
  zero behavior change for existing tools). DevOps then sets prod keys +
  webhook secret (separate child issue) and buys the first production label.
- Rollback: unset the key (tool degrades), revert code. Bought labels remain
  real and tracked — same semantics as the Stripe key rollback documented in
  `docs/deploy-vps.md` §5.

## Open questions

1. Persist seller from-addresses for repeat purchases? Defer (v1: per-call).
2. Seller-borne label billing (deduct from payout)? Only after Stripe is
   live and there is a payout ledger to deduct from — revisit post-Phase 1.
3. International customs forms (`customs_item` on the shipment) — v1 supports
   domestic + EU flows the tracker already covers; customs fields are a
   follow-up if EasyPost rejects a cross-border buy (error surfaces plainly).

## Implementation steps (PR-sized)

1. **PR-A (unprotected):** `src/easypost.ts` shipment/buy client + unit tests.
2. **PR-B (protected):** schema (`label_purchase`, `seller_label_quota`) +
   transition #5b + `buyShippingLabel` service in `src/fulfillment.ts` +
   quota + tests.
3. **PR-C (protected):** `buy_shipping_label` MCP tool + docs sync + contract
   tests.
4. **DevOps child issue (parallel after PR-C merges):** prod keys, webhook
   secret, first live label, evidence on the issue.
