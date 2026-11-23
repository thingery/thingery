# Spec: ShippingProvider interface + provider registry

- **Status:** Proposed. This document is the required written spec for the protected paths it
  touches (`src/tools.ts` description text, a comment-only edit in `db/schema.sql`).
  Implementation starts only after Security review of §6/§8 and CEO sign-off (THI-36).
- **Date:** 2026-11-23
- **Author:** Architect
- **Parent:** THI-1244 (pluggable shipping provider layer + activate Shippo test mode in place
  of EasyPost). Decision context: THI-922; address verification stays on Sendcloud: THI-911.
- **CEO decision recorded here (binding):** label purchase and tracking stay in **one provider
  per deployment**. The registry must allow adding providers later (e.g. Sendcloud), but a
  deployment never mixes providers across label purchase and tracking.
- **Scope guard:** this spec covers exactly what the code uses today — create shipment + rates
  (quote at order time), buy a label against a stored quote, register a tracker, and carrier
  webhook verification + normalization into the existing normalized statuses. Nothing else.

Thingery is the open item database and MCP server for AI agents to list, find, and trade
second-hand goods.

## Problem

Carrier automation (quotes, labels, trackers, carrier webhooks) is hard-wired to EasyPost:
`src/easypost.ts` is imported directly by `src/shipping-quotes.ts`, `src/fulfillment.ts`,
and `src/webhooks-carrier.ts`; reason codes, dedupe id prefixes, config fields, and the
`db/schema.sql` comment all say "easypost". THI-1244 wants to run the same order-flow
machinery on Shippo (test mode first) without changing order state machines, buyer/seller
behavior, or degraded deployments — and later possibly on Sendcloud for labels/tracking.
Today there is no seam: every provider touch point names EasyPost.

## Context (repo @ bea451a)

- **Quoting** — `resolveShippingQuote` (`src/shipping-quotes.ts`) calls
  `createEasyPostShipment` at `create_order` time, selects the cheapest EUR rate under the
  per-label cap, and persists the `label_quote` snapshot (shipment id, rate id, carrier,
  service, amount, addresses, weight). Every unmet condition falls through to flat mode with a
  reason; quoting can never fail an order. Reasons are provider-prefixed today:
  `easypost_not_configured`, `quote_failed`, `quote_timeout`, `no_eur_rate`, `rate_above_cap`.
- **Label purchase** — `buyShippingLabel` (`src/fulfillment.ts`) buys against the stored
  snapshot (`buyEasyPostLabel(shipment_id, rate_id)`); if the paid rate is no longer
  purchasable it re-quotes fresh (`createEasyPostShipment` + `pickEasyPostRate`) under the
  same guards (per-label cap, daily budget, seller quota, `label_rate_exceeded` check for
  buyer-paid quotes). The bought label is persisted in the same transaction as the `#5b`
  transition: carrier, tracking_code, tracker_id, label_url (https-only, F16), and the
  `label_purchase` snapshot. Spend-relevant flow is split: quote (no money) then buy (money).
- **Own-label tracking** — `recordTracking` (`src/fulfillment.ts`) stores carrier +
  tracking_code, then registers an EasyPost tracker (`createEasyPostTracker`); registration is
  best-effort (failures are event-logged, the order still advances). Degraded mode (key unset)
  returns null and only carrier + tracking_code persist.
- **Carrier webhooks** — `src/webhooks-carrier.ts`: verify-then-parse (HMAC-SHA256 over raw
  bytes via `X-Hmac-Signature: hmac-sha256-hex=<hex>`, NFKD-normalized secret, timing-safe
  compare, current + previous secret rotation F13); redact-at-ingest (F6 — free-text/facility
  details never stored); dedupe on `external_id = easypost:<sha256(raw body)>` (EasyPost
  tracker webhooks carry no per-delivery event id); resolution: `orders.tracker_id` first
  (UNIQUE), then `(carrier, tracking_code)` with exactly one live match else skip + operator
  alert (F4, never guess); normalized statuses drive transitions #10/#12/#14/#14b through the
  PR-2 core (`src/orders.ts` — untouched by this spec). `webhook_events.source` CHECK allows
  `'stripe','carrier'`; stale-but-valid transitions are 200s, real failures 500 (sweep rule 6
  reprocesses).
- **Config** — `orderFlowConfig()` (`src/config.ts`): `easypostEnabled = EASYPOST_API_KEY` set;
  `carrierWebhookReady = EASYPOST_WEBHOOK_SECRET` set (else the endpoint mounts as a 503
  stub); `easypostWebhookSecret{,Previous}`; empty/whitespace counts as unset (F1);
  half-configured degrades disabled, never open (F-rule #2).
- **Schema** — `orders.tracker_id TEXT UNIQUE` commented as "carrier-aggregator tracker id
  (EasyPost result.id) — PRIMARY webhook event-resolution key"; `orders.label_quote`,
  `orders.label_purchase` JSONB snapshots; `webhook_events(source, external_id, payload,
  processed_at, process_error)`.
- **Tools** — `create_order` (quote at checkout), `quote_shipping` (rate-limited estimate;
  description lists fallback reasons incl. `easypost_not_configured`), `buy_shipping_label`
  (description names EasyPost, `easypost_not_configured`, `EASYPOST_API_KEY`),
  `record_tracking` (description names the carrier tracker registration).

## Shippo facts (official docs only; verified 2026-11-23)

Sources: `docs.goshippo.com` — `tracking/tracking-carriers.md` (supported tracking carriers +
tokens), `tracking/tracking.md` (registering trackers, event definitions, carrier
restrictions, test tracking), `tracking/webhook-security.md` (auth schemes),
`tracking/webhooks.md` (event types + payloads), `addresses/address-validation.md` (global
validation), `carriers.md` (carrier accounts), `guides/testing.md` (test mode).

### Carrier capabilities IT/DE

Shippo's default pre-connected carrier accounts cover **U.S. outbound only**; EU label
purchase requires connecting the deployment's **own carrier accounts** (per-carrier
credentials) in Shippo. Confirmed tracking coverage (carrier token):

| Carrier | Tracking via Shippo | Source / caveat |
| --- | --- | --- |
| Poste Italiane | **Confirmed** (`poste_italiane`) | tracking-carriers list; **restriction:** requires the deployment's own Poste Italiane account connected to Shippo to register trackers |
| Deutsche Post | **Confirmed** (`deutsche_post`) | **restriction:** only permits tracking shipments *created through Shippo* (own-carrier labels cannot be tracked) |
| DHL Paket (DHL Germany) | **Confirmed** (`dhl_germany`) | same restriction — Shippo-created shipments only |
| DPD Germany | **Confirmed** (`dpd_de`) | not listed in either restriction group (no own-account requirement documented) |
| GLS (IT/DE) | **Not confirmed** | only "GLS US" (`gls_us`, own-account required) appears in the official lists; no European GLS entry |
| BRT / Bartolini | **Not confirmed** | absent from every official carrier list (tracking carriers + service-levels index) |

Consequence for `record_tracking` under Shippo: own-carrier labels can be tracked for
Poste Italiane (with own account) and DPD DE; Deutsche Post and DHL Paket own-labels are
**not trackable** through Shippo at all. Registration stays best-effort/non-fatal exactly as
today — the seller's tracking data is stored regardless; only automation is lost.

### Address validation IT/DE

- **DE: yes (documented)** — the official global-validation example validates a Berlin
  address to premises level (`country: "DE"`). Caveats: with a **test** token, non-US
  validation is a pass-through (no real validation); **live** global validation is a
  paid, per-validation charge.
- **IT: unknown** — docs describe "global address validation" for non-US addresses
  generically (precision messages, corrections) but publish **no country coverage list**;
  no Italy-specific statement exists in the official docs.
- Regardless: **address verification stays on Sendcloud** (THI-911, `src/sendcloud.ts`). The
  `ShippingProvider` interface deliberately has **no** address-validation method; the facts
  above are recorded for THI-1244 planning only.

### Webhook authentication scheme

Three options, combinable (`tracking/webhook-security.md`):

1. **Inbound IP allowlist** — documented Shippo egress ranges (US + EU lists in docs).
2. **Self-generated URL token** — `?token=<secret>` appended to the configured webhook URL,
   echoed back on delivery. Weaker: secret-in-URL (leaks via logs/referrers).
3. **HMAC** — **not self-service**: provisioned by Shippo's solutions team via account
   manager/sales contact, "up to 10 business days". Scheme per the docs' verification
   script: signature header surfaced as `HTTP_SHIPPO_AUTH_SIGNATURE` (exact wire header name
   to be confirmed at provisioning), format `t=<unix-ts>,v1=<hex>`; signed payload is
   `<timestamp>.<raw body>`; HMAC-SHA256, hex compare. This is a **Stripe-style timestamped
   scheme, not EasyPost-style** (EasyPost: plain HMAC over raw bytes, `X-Hmac-Signature`,
   NFKD-normalized secret). No timestamp-freshness window is documented — treat out-of-window
   as valid-but-stale only if the transition guard accepts it; freshness checking stays off
   unless Security requires it.

Dedupe: `track_updated` payloads carry **no per-delivery event id**, and Shippo documents
that "tracking webhooks are not idempotent" (duplicates possible). Dedupe stays content-hash
based: `shippo:<sha256(raw body)>` (mirroring the EasyPost scheme; any content change is a
new event and the transition guard keeps re-application a no-op).

Payload: `{ event: "track_updated", test: boolean, data: { TrackingStatus } }` with
`carrier`, `tracking_number`, `tracking_status {status, substatus, status_date, ...}`,
`tracking_history`, `metadata` (free-text echo of what we set at registration),
`address_from/to` (city/zip/country only). `test` maps to the stored `mode`
("test"/"production"). Redaction (F6): store only the fields `RedactedCarrierEvent` carries;
drop `address_from/to`, `messages[]`, `tracking_history` bodies and free-text details —
keep last status's `status_date` as `occurred_at`.

Tracker registration: `POST /tracks {carrier, tracking_number, metadata}` — **requires a
webhook subscription to exist first** (account-level, created once via portal or Webhooks
API beta; not per-shipment). The response is a TrackingStatus object; **there is no tracker
object/id** (unlike EasyPost `trk_…`). `metadata` is the provider-native correlation field.
Shippo auto-tracks labels bought through Shippo (registration only needed for external
codes). Tracking external (non-Shippo-label) numbers may incur a per-number cost.

Test mode: `shippo_test_` keys; all features incl. label purchase are free; mock tracking via
carrier `shippo` with `SHIPPO_PRE_TRANSIT|SHIPPO_TRANSIT|SHIPPO_DELIVERED|SHIPPO_RETURNED|SHIPPO_FAILURE|SHIPPO_UNKNOWN`;
webhook payloads carry `"test": true`.

### Label purchase + rates

`POST /shipments` (addresses + parcel) returns the shipment with quoted rates; each rate has
`object_id`, `servicelevel {token, name}`, `amount` (decimal string), `currency`,
`amount_local`. `POST /transactions {rate}` buys the label → `label_url` (https, **signed and
expiring** — stored as data at purchase, same discipline as today), `tracking_number`,
`tracking_status`, `tracking_url_provider`. Shipments/rates are retrievable up to 390 days.
Auth: `Authorization: ShippoToken <key>`.

### Normalized status mapping (Shippo → existing `NormalizedStatus`)

| Shippo `status` | Shippo `substatus` | Normalized | Transition |
| --- | --- | --- | --- |
| `PRE_TRANSIT` | any | `pre_transit` | timeline event only |
| `TRANSIT` | `out_for_delivery` | `out_for_delivery` | #10 |
| `TRANSIT` | `pickup_available` | `out_for_delivery` | #10 (mirrors EasyPost `available_for_pickup`) |
| `TRANSIT` | any other | `in_transit` | #10 |
| `DELIVERED` | any | `delivered` | #12 (carrier-confirmed window) |
| `RETURNED` | any (`return_to_sender`, `package_unclaimed`) | `return_to_sender` | #14b-path (item back active) |
| `FAILURE` | any (`package_lost`, `package_undeliverable`, `package_disposed`) | `failure` | #14-path (item deleted) |
| `UNKNOWN` / unrecognized | any | `unknown` | logged, never a transition |

The order state machine (`src/orders.ts`) is **unchanged**; only the adapter's status map
differs per provider.

## Proposed design

### ShippingProvider interface (`src/shipping/provider.ts`, new)

```ts
export interface ShipmentRate {
  id: string;          // provider rate id — opaque, single-use, provider-scoped
  carrier: string;     // display/selection name ("DHL Paket", "USPS", …)
  service: string;     // provider service label/token
  costCents: number;   // integer cents — never float math
  currency: string;    // ISO 4217
}
export interface TrackerRef { id: string; } // provider-namespaced opaque tracker id
export interface BoughtLabel {
  shipmentId: string; rateId: string; carrier: string; service: string;
  costCents: number; currency: string;
  labelUrl: string;    // https-only, enforced by the adapter (F16)
  trackerId: string;   // provider tracker id (see per-provider rules)
  trackingCode: string;
}
export interface ProviderShipmentInput {
  toAddress: ProviderAddress; fromAddress: ProviderAddress;
  weightGrams: number; dimensionsMm?: { length: number; width: number; height: number };
}

export interface ShippingProvider {
  readonly id: string; // "easypost" | "shippo" | … — registry key
  /** true iff the provider's API key is configured (F1 empty-is-unset). */
  isConfigured(): boolean;
  /** Quote rates. Returns null iff not configured (degraded). Throws ProviderError on
   *  provider faults; respects `signal` (order-time quotes pass AbortSignal.timeout). */
  createShipment(input: ProviderShipmentInput, signal?: AbortSignal):
    Promise<{ shipmentId: string; rates: ShipmentRate[] } | null>;
  /** THE spend call. Buys against a previously quoted shipment+rate of THIS provider.
   *  Null iff not configured; throws ProviderError on provider faults/malformed payloads. */
  buyLabel(shipmentId: string, rateId: string): Promise<BoughtLabel | null>;
  /** Best-effort tracker registration for an own-carrier code. Null iff not configured.
   *  Throws on provider faults; callers treat as non-fatal (event-logged). */
  registerTracker(carrier: string, trackingCode: string): Promise<TrackerRef | null>;
  /** Verify the carrier webhook over RAW bytes. Throws VerificationError on any failure.
   *  Implementations MUST compare timing-safe and support current+previous secrets (F13). */
  verifyWebhook(raw: Buffer, headers: Record<string, string | undefined>): void;
  /** Parse AFTER verify: produce the redacted, provider-neutral event (F6 fields only). */
  parseWebhook(raw: Buffer): RedactedCarrierEvent;
  /** Deterministic dedupe key for raw bytes: `${id}:<sha256(raw)>` (no provider today
   *  documents a per-delivery event id; keep the scheme uniform). */
  dedupeId(raw: Buffer): string;
}
```

`ProviderError { status: number; code?: string }` replaces `EasyPostError` as the carrier of
provider error details; `RedactedCarrierEvent` is the existing shape from
`src/webhooks-carrier.ts` (description, mode, tracker_id, tracking_code, carrier,
carrier_status, status, occurred_at) — already provider-neutral, it moves to
`src/shipping/provider.ts` unchanged. Rate selection (`pickEasyPostRate` — cheapest, optional
carrier substring preference) is provider-independent and becomes a shared pure helper
(`pickRate`) in `src/shipping/provider.ts`.

### The two adapters

- **`src/shipping/easypost-adapter.ts`** — thin wrapper delegating to the existing functions
  in `src/easypost.ts` (unchanged): existing HTTP client, auth, error mapping, status map,
  `X-Hmac-Signature` verification, `easypost:` dedupe prefix, `trk_…` tracker ids.
  Under the default configuration its observable behavior is byte-identical to today.
- **`src/shipping/shippo-adapter.ts`** — new, against the documented REST API
  (`Authorization: ShippoToken …`):
  - `createShipment` → `POST /shipments`; maps rates (`object_id`, `servicelevel.name`,
    `amount` → cents, `currency`). Reuses the metric→parcel conversion already in
    `src/easypost.ts` (shared helper).
  - `buyLabel` → `POST /transactions {rate}`; https-only label_url check; tracker id
    **synthesized deterministically**: `shippo:` + first 32 hex chars of
    `sha256(carrier + "|" + tracking_number)` — identical at registration and at webhook
    ingest, so `orders.tracker_id` resolution (F4) keeps working without EasyPost-style
    tracker objects; the `shippo:` prefix prevents collision with `trk_…` ids under the
    UNIQUE constraint.
  - `registerTracker` → `POST /tracks {carrier, tracking_number, metadata}` where
    `metadata = "thingery:{order_id}"` (provider-native correlation echo; set by the caller
    through an optional `metadata` argument on the interface method so fulfillment passes it).
  - `verifyWebhook` → HMAC scheme per docs (`t=…,v1=…` over `<ts>.<body>`, SHA-256 hex,
    timing-safe, current+previous secret); header name constant isolated in the adapter and
    confirmed at HMAC provisioning (see Open questions).
  - `parseWebhook` → per the mapping table above; `payload.test` → `mode`; F6 redaction
    (drop addresses, messages, history free text).
  - `dedupeId` → `shippo:<sha256(raw)>`.

### Registry + selection (`src/shipping/provider.ts` + `src/config.ts`)

- Env: `SHIPPING_PROVIDER` — `easypost | shippo`, **case-insensitive, trimmed;
  default `easypost` when unset** (backward compatibility: existing deployments change
  nothing until activation).
- Unrecognized value → **boot error, shipping disabled** (fail-closed: never silently fall
  back to a provider the operator did not choose; same discipline as the F-rule half-config
  posture). Empty/whitespace counts as unset (F1).
- Per-provider env (read only for the selected provider; the other set is ignored with a boot
  warning): `EASYPOST_API_KEY`, `EASYPOST_WEBHOOK_SECRET{,_PREVIOUS}` / `SHIPPO_API_KEY`,
  `SHIPPO_WEBHOOK_SECRET{,_PREVIOUS}`.
- `OrderFlowConfig` gains `shippingProvider: "easypost" | "shippo"` and
  `shippingEnabled: boolean` (selected provider's API key present); `easypostEnabled` and
  `easypostWebhookSecret*` collapse into the provider-scoped fields (internal TypeScript
  interface — not user-facing; tests updated in the same PR). `carrierWebhookReady` keeps its
  semantics against the **selected** provider's webhook secret (unset → 503 stub, unchanged).
- `getShippingProvider(cfg)` returns the single configured instance. **One provider per
  process** — structurally enforced: rate/shipment/tracker ids only ever flow between the
  order row and the same provider instance; there is no per-call provider choice anywhere in
  the interface.

### Degraded mode (no provider configured) — behaviorally unchanged

- Quoting falls back to flat mode with the not-configured reason; `quote_shipping` returns
  `quotable: false`.
- `record_tracking` stores carrier + tracking_code, no tracker registration.
- `buy_shipping_label` fails with `{provider}_not_configured` before any spend.
- Carrier webhook endpoint mounts as the 503 stub (`carrierWebhookReady = false`).
- Byte-compatibility: with the default (`SHIPPING_PROVIDER` unset, `EASYPOST_API_KEY` set or
  unset) every tool output, fallback reason, and event payload is identical to today —
  including the reason strings (see next section).

### Reason / error code scheme: provider-prefixed, not renamed

Today's codes become a **scheme**: `{provider}_not_configured`, `{provider}_error` where
`{provider}` is the active registry id. Under the default `easypost`, the emitted strings are
exactly today's (`easypost_not_configured`, `easypost_error`) — **no observable string
changes for existing deployments** (API-evolution lens: extend, don't mutate). A `shippo`
deployment emits `shippo_not_configured` / `shippo_error` in the same positions
(`quote_shipping` reasons, `buy_shipping_label`/`create_order` errors,
`label_quote_fallback` event reasons). Tool descriptions stop naming EasyPost and say
"`<provider>_not_configured` (e.g. `easypost_not_configured`)".

### Provider switch semantics (one-provider invariant over time)

- Quotes, rate ids, shipment ids, and tracker ids are **provider-scoped strings**. On a
  provider switch, in-flight `label_quote` orders re-quote under the new provider at buy
  time (the re-quote path already exists when a stored rate is no longer purchasable); a
  stale id is **never** sent to the new provider — the adapter receives only ids it issued
  (enforced by the buy path: snapshot → adapter.buyLabel; any ProviderError → re-quote →
  guards → buy, as today).
- `orders.tracker_id` values minted by the old provider remain stored but inert (the old
  provider stops delivering webhooks; resolution via `(carrier, tracking_code)` fallback
  still works for live orders).
- No data migration is needed in either direction.

### Sendcloud non-preclusion

The registry is a string-keyed map id → factory. Adding a provider = new adapter implementing
the six operations + the env suffix pair (`SENDCLOUD_API_KEY`, `SENDCLOUD_WEBHOOK_SECRET`)
+ one line in the registry + extending the `SHIPPING_PROVIDER` validation. Address
verification (`src/sendcloud.ts`, THI-911) is **out** of the interface and untouched; a
future Sendcloud labels/tracking adapter composes with it independently.

## Data model changes

**None.** No DDL, no column, no constraint change. Explicitly:

- `orders.tracker_id` keeps its name, type, and UNIQUE constraint; it is **reinterpreted** as
  the *provider tracker id* (EasyPost `trk_…` or the synthesized `shippo:…` id). The only
  `db/schema.sql` edit is the line-414 **doc comment** ("EasyPost result.id" → "provider
  tracker id"). `db/schema.sql` is a protected path: this comment-only edit still ships with
  Security review + CEO sign-off in the PR per THI-36.
- `webhook_events.source` stays `'carrier'` for both providers; `external_id` is
  provider-prefixed (`easypost:…` / `shippo:…`) so the same column serves both.
- `label_quote` / `label_purchase` snapshots are provider-agnostic already (ids are opaque
  strings; add nothing).

## API / MCP tool changes

- **No new tools; no signature or schema changes** to `create_order`, `quote_shipping`,
  `buy_shipping_label`, `record_tracking`.
- Observable string changes are limited to the provider-prefixed code scheme above and apply
  only when the deployment selects a non-default provider; descriptions are updated to the
  generic form in the same PR.
- Blast radius (lens check): registry-listed npm installs and live MCP sessions see **no**
  change under the default; a `shippo`-mode deployment changes reason strings only in the
  not-configured/provider-error paths. Agents that compare those strings literally on an
  easypost deployment are unaffected.

## Migration plan (expand–contract, additive only)

1. **Expand (PRs 1–3, default `easypost`):** interface + registry + adapters land with
   `SHIPPING_PROVIDER` unset ⇒ all existing behavior, all existing tests green. No schema
   change, no env change required.
2. **Switch (activation, operational):** on the VPS, set `SHIPPING_PROVIDER=shippo` +
   `SHIPPO_API_KEY` + `SHIPPO_WEBHOOK_SECRET` (+ create the Shippo webhook subscription in
   the portal pointing at `/api/webhooks/carrier`) — DevOps runbook, THI-1244, test mode
   first. No code change, no migration.
3. **Contract:** none required. `src/easypost.ts` stays as the EasyPost transport used by its
   adapter; if a future cleanup wants to fold it in, that is a separate refactor PR after
   Shippo activation settles.

## Test plan

- **Adapter units (fetch seam, mirroring `src/easypost.ts` tests):** shippo adapter —
  shipment/rate mapping (decimal-string → cents, EUR selection), buy mapping (label_url
  https-only, tracker-id synthesis determinism), registerTracker (metadata echo), error
  mapping (`ProviderError`), degraded null paths.
- **Verification vectors:** EasyPost — existing tests unchanged; Shippo — HMAC vectors built
  per the documented scheme (`t=…,v1=…` over `<ts>.<body>`, current + previous secret,
  timing-safe reject paths, bad/missing header ⇒ `VerificationError`).
- **Normalization table:** all Shippo statuses + the `out_for_delivery`/`pickup_available`
  substatus picks, `test` → mode mapping, F6 redaction (addresses/messages/history absent
  from stored payload).
- **Registry/selection:** default = easypost (byte-compat assertions on quote reasons),
  `shippo` selection, invalid value ⇒ boot error + shipping disabled, mixed env ⇒ warning +
  selected-provider-only reads, `carrierWebhookReady` per selected secret.
- **Webhook ingest:** `shippo:` dedupe (byte-identical redelivery dedupes; content change =
  new row), tracker_id resolution via synthesized id, F4 fallback/ambiguity unchanged,
  stale-but-valid = 200, process_error paths unchanged.
- **Degraded byte-compat:** with provider unset, the full existing tool-output test suite
  passes unmodified.
- **E2E smoke (activation PR, test mode):** quote → buy (`shippo_test_`) → mock tracking
  webhook (`SHIPPO_TRANSIT`, `SHIPPO_DELIVERED`) drives #10/#12 on a test order.

## Rollout + rollback

- **Rollout:** PRs 1–3 merge and deploy behind the default (`easypost`) — no behavior change.
  Activation is a pure env/portal operation executed by DevOps per THI-1244 (test mode
  first), including the Shippo portal webhook subscription and the HMAC provisioning request
  (10-business-day lead — start early). Production-mode activation additionally requires the
  HMAC scheme live: the URL-token/IP-allowlist options are acceptable **only** for test mode;
  Security signs off on the production verification posture (§ Security note).
- **Rollback:** set `SHIPPING_PROVIDER=easypost` (keys retained) and redeploy-restart —
  quotes/labels/trackers return to EasyPost; in-flight shippo quotes re-quote under EasyPost
  at buy time. Complete removal = unset provider keys ⇒ degraded mode, byte-compatible with
  pre-carrier deployments. No schema rollback exists or is needed.

## Security note (for Security review)

- Shippo HMAC is provisioning-gated (sales-led); until provisioned, the only verification
  options are URL token and IP allowlist, both materially weaker (token-in-URL leakage;
  spoofable allowlist). Test-mode activation on token+allowlist is acceptable; **production
  activation must wait for HMAC** (or an explicitly approved compensating-control posture).
- Verify-then-parse ordering, raw-byte HMAC, timing-safe compare, NFKD/EasyPost specifics,
  and current+previous rotation are preserved verbatim for EasyPost and replicated for
  Shippo inside its adapter; the mount-order constraint (before `express.json()`, raw-body
  router) is unchanged.
- F6 redaction is re-stated per provider; the Shippo adapter must drop `address_from/to`,
  `messages[]`, and `tracking_history` free text at ingest.
- No API keys in issues, PRs, logs, or the repo (unchanged rule); provider keys stay in the
  VPS `.env` only.

## Open questions

1. **Shippo HMAC wire header name** — docs show the verification script consuming
   `HTTP_SHIPPO_AUTH_SIGNATURE`; the exact HTTP header casing/name is confirmed only during
   provisioning. The adapter isolates it as a single constant; confirmed value gets recorded
   here before production activation.
2. **HMAC timestamp freshness** — no documented freshness window. Default: none (rely on the
   transition guard, which already absorbs replays); Security may impose a window at review.
3. **Shippo per-number tracking cost** for external (own-carrier) codes is documented as a
   paid feature without published pricing — the activation decision (THI-1244) should confirm
   whether `record_tracking` registers external codes under Shippo or skips registration for
   restricted/unpaid carriers (Poste Italiane own-account requirement; Deutsche Post /
   DHL Paket not trackable at all). Default spec position: register best-effort exactly as
   today, accept the documented restrictions as failures-to-automate (non-fatal).

## Implementation steps (each PR-sized, one purpose, <~300 lines)

1. **PR-1 — interface + registry + EasyPost adapter (default-safe).**
   `src/shipping/provider.ts` (interface, `ProviderError`, `RedactedCarrierEvent`,
   `pickRate`), `src/shipping/easypost-adapter.ts` (delegating), `src/config.ts`
   (`SHIPPING_PROVIDER`, provider-scoped secret reads, `shippingProvider`/`shippingEnabled`,
   boot report), `getShippingProvider()`. No call-site changes. Tests: selection, invalid
   value fail-closed, byte-compat defaults.
2. **PR-2 — Shippo adapter.** `src/shipping/shippo-adapter.ts` (shipments/rates,
   transactions, tracks, tracker-id synthesis) + units. Not wired anywhere yet.
3. **PR-3 — provider-agnostic carrier webhook ingest.** `src/webhooks-carrier.ts` routes
   verify/parse/dedupe through the active provider; resolution, transitions, sweep
   reprocessing untouched; shippo ingest tests (vectors, normalization, dedupe, redaction).
   *Protected-adjacent review: none (no protected path), Security consults on the
   verification seam.*
4. **PR-4 — call-site swap + descriptions + schema comment.** `src/fulfillment.ts` +
   `src/shipping-quotes.ts` + `src/order-flow.ts` go through `getShippingProvider()`
   (provider-prefixed codes); `src/tools.ts` description text generalized (protected path —
   needs Security review + CEO sign-off with this spec attached); `db/schema.sql` line-414
   comment (protected path, same PR); existing test expectations kept byte-identical under
   the default.
5. **PR-5 — activation runbook + test-mode smoke (DevOps).** Env/portal steps, HMAC
   provisioning request, E2E smoke on `shippo_test_`, rollback drill. Executed per THI-1244.
