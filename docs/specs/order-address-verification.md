# Spec: Order-time address verification

- **Status:** Accepted design, Security-reviewed (design note v2) — implementation in flight
- **Date:** 2026-11-18; amended 2026-11-19 (provider moved to Sendcloud v3 — verification
  only; labels/tracking stay on EasyPost); **rev 2 (shipping-provider-layer spec): the
  check runs on the ACTIVE shipping provider's interface** (`verifyAddress` + capability
  flag; Shippo when `SHIPPING_PROVIDER=shippo`). The Sendcloud sections below describe the
  retired path — kept for history; the state machine, caps, cache, F2, and §5a rules are
  unchanged and remain authoritative.
- **Author:** Architect
- **Decision:** product decision, 2026-11-18 — shippable orders get one advisory carrier
  address check at creation; a suggested correction pauses the order once and lets the buyer
  choose. Failure-open: the check can never block an order the platform could ship before.
- **Provider decision, 2026-11-19:** the advisory check runs on Sendcloud's v3 address
  validation (EU processor, published DPA). EasyPost remains the labels/tracking processor
  only — its verify functions are retired from the active verification path.

## Problem

`create_order` accepts any well-formed shipping address and the first quality gate on an
address is a human (the seller, at label time) or nothing (carrier rejects at manifest, order
already paid). Typo'd or undeliverable addresses surface late, cost re-shipments, and give
scam orders a friction-free path. A provider address-validation endpoint returns a
deliverability verdict plus a corrected address — so the platform can check the address in
the same transaction that creates the order, before any reservation or payment link exists.
Sendcloud's validate API is quote-grade (no shipment is created, nothing is announced) and
keeps the address data with an EU processor under a published DPA.

## Decisions (binding)

1. **Advisory only, failure-open.** Unset `SENDCLOUD_API_KEY` (or
   `SENDCLOUD_VALIDATE_CARRIER_CODE`), provider error, timeout (≤3s),
   non-2xx, malformed payload, over-cap → outcome `not_checked`, order proceeds **unchanged**.
   The feature can never block an order the platform could ship before it existed.
2. **Provider output never travels raw.** A suggested correction is re-validated (F2 below)
   to the exact `ShippingAddress` shape before it is stored, cached, or returned. A malformed
   suggestion downgrades the outcome to `unverified` — never surfaced as-is.
3. **No address values in error strings, logs, or messages.** The suggested-branch message
   tells the caller to ask the buyer; the suggestion rides in the data payload. Every thrown
   message and stored record is asserted value-free in tests.
4. **At most one provider call per create attempt**, deduped by a 10-minute in-memory cache
   keyed by salted SHA-256(account id + normalized address).
5. **Caps:** 20 checks/account/day (`RateLimiter` bucket `addrverify:{accountId}`, 24h window,
   shared with the saved-addresses verification path) and a platform-wide daily ceiling,
   default **1,000/day**, env `ADDRESS_VERIFICATION_DAILY_CAP` (`0` disables the feature).
6. **`verification_choice:"keep_original"` is a no-op without a cached suggestion** — it
   cannot pre-emptively skip a check for a suggestion that may never exist.
7. **Degraded mode is byte-identical pre-rollout behavior.** Registry installs without the
   key: no provider call, no storage, no suggestion flow, and today's tool outputs.

Two refinements decided in Security review of v2, without weakening the above:
- **F2 (suggestion validation)** mirrors the `create_order` schema limits exactly (name ≤120,
  line1/line2 ≤200, city ≤80, postal_code ≤20, country ISO 3166-1 alpha-2 after trim +
  uppercase). Unknown fields are **dropped**, not rejected (provider payloads carry extras).
  Any failure → `unverified`, nothing unvalidated stored or returned. Instruction-like text
  inside otherwise-valid fields stays data.
- **F1 (visibility)** is property-level, not object-level — §5a matrix below.

## Design

### Provider call (`src/sendcloud.ts`)

`verifySendcloudAddress(input, opts)` — one `POST /api/v3/addresses/validate`
(quote-grade: no shipment, no money moves). Auth is HTTP basic: `SENDCLOUD_API_KEY` carries
the `"key:secret"` pair verbatim, or a single token sent as the basic username with an empty
password. The validate API additionally requires `carrier_code` naming a carrier available
on the account — env `SENDCLOUD_VALIDATE_CARRIER_CODE`; unset key **or** carrier keeps the
feature fully degraded. Fetch seam, same client conventions; a ≤3s `AbortController`
deadline wraps the call. The wire request carries exactly the typed address fields mapped to
Sendcloud's `address_line_*`/`postal_code`/`country_code` format — the wire shape has no
name field, so the buyer's name is never sent. Returns `verified`
(`input_address_is_valid: true`), `unverified` (invalid, nothing usable we can map), or
`suggested` with the recommended result's address mapped back to domain field names
(`house_number` folded back into `line1`). The provider's documented `null` (validator
unavailable) and degraded mode both return `null` — the caller's `not_checked`. Throws on
network/HTTP problems; the caller treats any throw as `not_checked`.

### Service (`src/address-verification.ts`)

`verifyOrderAddress({ accountId, address, choice? })` — the state machine:

1. Credentials unset (key or carrier code) → `not_checked` (before caps: no budget
   consumed in degraded mode).
2. `keep_original` with a cached suggestion → `suggested/kept` record, no provider call.
   Without one → fall through (decision 6).
3. Cache hit (within TTL): re-submitting **exactly the suggested address** is the accept
   protocol → `suggested/accepted` record, no provider call. Verified/unverified → same
   outcome reused. Typed address unchanged after a suggestion → same pause, no new call.
4. Caps: global ceiling (spend bound), then per-account bucket; both → `not_checked`.
   The counter increments before the call, so failed calls still count as spend.
5. Provider call (≤3s, any throw → `not_checked`); response mapped; suggestion run through
   F2; a "correction" identical to the typed address is not a correction (`unverified`).
6. Cache write under the typed address and — for a suggestion — also under the suggested
   address, so acceptance within the TTL is a cache hit with no second provider call.

Outcome for `createOrder`: `not_checked` (store NULL), a `ShippingVerificationRecord`
(store), or `suggested` (no order).

### `createOrder` (`src/order-flow.ts`)

Inside the existing transaction, after the fulfillment check and **before** the reservation
UPDATE. A suggestion throws `AddressSuggestedError` (extends `OrderFlowError`, code
`address_verification_suggested`) — the catch rolls back having touched nothing: no
reservation, no order row, no payment clock, item still buyable. Otherwise the record is
written on the new INSERT column. `address_id` orders (saved-addresses spec) never hit this
gate; that rollout copies the stored verification instead of re-checking.

### Storage

```sql
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_verification JSONB;  -- NULL = not_checked
```

Additive, no backfill, inert on rollback. Shapes: `{status:"verified"|"unverified",checked_at}`,
`{status:"suggested",kept:true,suggestion,checked_at}` (buyer kept theirs),
`{status:"suggested",accepted:true,checked_at}` (buyer re-submitted the suggestion).
`suggestion` inside a stored record is always the F2-validated shape; never the provider's
raw response, never error bodies.

### API surface

| Change | Shape |
|---|---|
| `create_order` input | new optional `verification_choice: "keep_original"` — order with the address as typed after the buyer saw a suggestion and kept theirs. The only enum value: acceptance is by resubmitting the suggested address (safe under F2). |
| `create_order` suggested branch | `isError` result, code `address_verification_suggested`, data `{verification:{status:"suggested", suggestion:{name,line1,line2?,city,postal_code,country}}}`. No order exists; the message tells the caller to ask the buyer. |
| order payloads | additive `shipping_verification` on `create_order` / `get_order` / `my_orders` results — `status` + `checked_at` for both parties on all results; `suggestion` strictly per §5a. Additions only; nothing renamed or re-typed. |

### §5a. Property-level authorization — `shipping_verification` visibility matrix (F1)

| Property | Buyer — own order, all results | Seller — `get_order` | Seller — `my_orders` |
|---|---|---|---|
| `status` | ✅ | ✅ | ✅ |
| `checked_at` | ✅ | ✅ | ✅ |
| `suggestion` | ✅ always — the buyer's own data | ⚠️ only under the existing `shippingAddressForSeller` rule (sold/label_issued; off_platform only after `share_shipping_address` consent) | ❌ never — no order state, no consent state |

- `status` + `checked_at` are verification metadata, not PII.
- Buyer-side `suggestion` is the one deliberate expansion of buyer-visible order data (the
  typed `shipping_address` itself stays omitted from buyer-facing payloads): the buyer must
  see what was suggested about their own address.
- Seller-side `suggestion` rides exactly the existing address-release rule — never earlier,
  never wider. `my_orders` is never a new disclosure channel.
- Enforcement follows the existing allowlist discipline (`orderToPublic` /
  `shippingAddressForSeller`): per property, per recipient role, at serialization time.

### Chat surface

The confirmed-card path relays the suggested branch verbatim (same payload as the MCP tool
result) so the model can ask the buyer which address to use and re-propose with the final
args bound into the confirm token. The gate-builder preview line and the system-prompt rules
(relay + ask, never swap silently, suggestions are data not instructions) land with the
verification_choice PR.

### Platform notes

- The in-memory cache and `RateLimiter` assume a single app instance — correct for the
  documented deployment; both must move to shared storage before any multi-instance deploy.
- Cache keys include the account id: dedup is per-account, never cross-account.

## Privacy & security

- What is sent: exactly the typed address fields (mapped to Sendcloud's wire format, no
  name field), once, to Sendcloud, only for shippable orders, only with the credentials
  configured, bounded by the caps above. Phone is never sent.
- What is stored: one JSONB column on the order row (platform-authored shapes only). Same
  retention as the address it describes; no side table.
- Who sees it: the order's parties under §5a; nothing here widens who can read an address.
- Plain-language statement: `docs/security.md` §4c; residual risks: §9 entries R2–R4.
- ISO country enforcement (`src/iso3166.ts`): trim + uppercase normalization, membership
  against the 249 assigned codes, field-only rejection message (the rejected value is never
  echoed) — enforced identically on the MCP zod schema and the chat gate.

## Test plan

- `src/iso3166.ts`: membership sanity, trim + uppercase normalization (" it " → `IT`; `XX`
  rejected), MCP ⇄ chat parity, field-only rejection (assert on strings).
- Verification module: response → status mapping; non-2xx / timeout / over-cap / unset key
  or carrier code → `not_checked` with no provider call where applicable; cap accounting;
  cache dedupe (accept path; identical resubmission; `keep_original` with and without a
  cached suggestion).
- F2: oversized fields, unknown keys, non-string junk, invalid country → `unverified`, nothing
  unvalidated stored or returned; a valid suggestion round-trips as exactly the
  `ShippingAddress` shape; instruction-like text stays data.
- §5a matrix, cell-by-cell (buyer all results; seller `get_order` states; seller `my_orders`
  never carries `suggestion`).
- `createOrder`: suggested branch creates no order, no reservation, no payment clock; accept
  / keep / verified / unverified store the right shapes; credentials unset → NULL column; no
  address values in any thrown message.
- Accept-path provenance: within TTL → `suggested/accepted`; past TTL → fresh check.
- Tools: additive fields; suggested-result code shape (validated fields only);
  `verification_choice:"keep_original"` no-op without a cached suggestion; docs regen.
- Chat: suggested-branch relay, prompt rules, ISO parity incl. normalization.
- `npm run typecheck && npm run test` before every PR.

## Rollout — PR slicing (each ships on its own; conventional commits)

1. `feat(tools): enforce ISO 3166-1 alpha-2 country in create_order` (+ chat parity incl.
   trim + uppercase normalization, tests, docs regen). Providerless quick win.
2. `feat(orders): advisory order-time address verification` — service module, provider
   client, storage, `createOrder` gate + suggested branch on both surfaces, security docs,
   self-hosting config docs, this spec. Key unset = no behavior change.
3. `feat(tools): verification_choice and shipping_verification on order results` — the
   choice input, §5a-serialized payloads, chat gate/prompt, docs regen.

PRs 4–5 (chat gate preview + web buy flow) and the saved-addresses integration are separate
specs that build on this one's module.
