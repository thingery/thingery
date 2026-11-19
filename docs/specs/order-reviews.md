# Spec: order reviews (reviews after a completed order)

Status: proposed · Touches protected paths `db/schema.sql`, `src/tools.ts`,
`src/routes.ts` — see AGENTS.md for the review requirements those files carry.
Implementation is gated on that review of this spec; nothing here ships first.

## Problem

A buyer finishes an order and has no way to tell the next buyer how it went.
Sellers have no visible track record, so a careful seller is
indistinguishable from a careless one at the moment of choice. The MVP: once
an order reaches a successful end, the buyer reviews the seller — 1–5 stars
plus optional text — and those reviews show on the seller's public profile
and, as an average + count, on the item page's seller card.

## Context

- The approved design boards (seller profile, item seller card, review form)
  fix the product rules restated under "Rules" below; the web UI lives in the
  private `thingery/platform` repo (`apps/web`). Board colours are hex; any
  code must use the colour roles from `apps/web/src/tokens`, never the hex.
  This spec covers the core: data, API, moderation. It is colour-free.
- Orders are the `orders` table with an explicit state machine
  (`src/orders.ts`): `pending → sold → label_issued → in_transit → delivered
  → payout_pending → paid_out` (stripe mode), with `disputed/refunding/
  refunded` and `cancelled` money-out arms, and `completed` as the
  off_platform terminal (§11.2). `TERMINAL_STATUSES` = `refunded`,
  `paid_out`, `cancelled`, `completed`. No transition leaves a terminal
  state — the CHECK-constrained machine makes that unrepresentable.
- Accounts are the `sellers` table (buyers and sellers alike); sessions are
  `sellerFromSession` (`src/auth.ts`). Public item payloads already expose
  `seller_id` and the seller `display_name`.
- Reports + moderation: signed-in users report items into the `reports`
  table (spec `docs/specs/item-reports.md`), triaged in the operator's
  external review system; operator takedowns use the ADMIN_API_KEY route
  pattern (`POST /api/admin/items/:id/takedown`).
- Rate limiting is the in-memory `RateLimiter` (`src/rate-limit.ts`), keyed
  per account; 429s log `security_events`.
- Public buyer-authored text (wanted listings) goes through contact-info
  screening (`src/contact-scrub.ts`) — reject, never rewrite.
- Schema changes ship additively; `scripts/migrate.ts` re-applies
  `db/schema.sql` idempotently (`IF NOT EXISTS` everywhere). Merging to main
  deploys to prod; the deploy runbook applies the schema.

## Rules (fixed by the approved design — not open for reinterpretation)

- Only the buyer of a completed order can review the seller, **once per
  order**: 1–5 stars + optional text up to 500 characters ("About the order,
  not the person" is form guidance, not an API rule).
- The buyer can **edit** the review for **30 days from posting**.
- Public display shows the buyer's **first name**, the item, and the month —
  e.g. "Luca · Nov 2026 · Film camera".
- The order page asks "How did it go with `<seller>`?" once the order has
  completed, with **Post review** / **Not now**; after posting it shows the
  review with an **Edit** action.
- The seller profile shows the review list ("Only buyers who completed an
  order can review it, once."); the item page seller card shows the summary
  — average (one decimal) + count — or "None yet".

## Proposed design

### Eligibility: which orders can be reviewed

**Eligible: `completed` and `paid_out` — exactly the terminal states where
the deal ended with the seller paid and the buyer keeping the item.**
`completed` is the off_platform terminal; `paid_out` is the stripe terminal
(§11.2 twins). Both match the board's "All done. The pen arrived and Marta
has been paid."

**Not eligible, explicitly:** `refunded` and `cancelled` (the buyer got
their money back — no deal to vouch for), every non-terminal state
(`pending` through `payout_pending`, `disputed`, `refunding`), and any order
that never existed. A dispute or refund that happens *before* the terminal
state routes the order to `refunded`/`cancelled`/`disputed` — none eligible.

**Can an order leave eligibility after a review is posted? No — by
construction.** Eligible states are terminal, and the transition table has
no edge out of a terminal state (a chargeback, §2.3 #22, can only fire from
non-terminal states). So "refund after a good review" is unrepresentable,
and no keep/hide/delete-when-ineligible machinery is needed. Reviews are
posted on states the order can never leave. This is the alignment with the
order state machine the design asked for: eligibility is defined by *state
reachability*, not by the word "completed".

**Who may review:** the order's `buyer_id`, session-authenticated, once per
order. Self-review is structurally absent: the order flow rejects
`self_order` at creation (`src/order-flow.ts`), so `buyer_id ≠ seller_id`
on every order row.

### State machine (explicit)

```
absent ──post (buyer, order in completed|paid_out)──▶ published
published ──edit (buyer, ≤30d from created_at)──▶ published   (same row, edited_at set)
published ──hide (operator, report triage)──▶ hidden
hidden ──unhide──▶ published        # reserved: no v1 path (operator SQL only)
```

Illegal transitions are rejected, never coerced: posting twice → 409;
editing past the window → 403; editing a hidden review → 403; posting on an
ineligible order → 400. The DB CHECK (`status IN ('published','hidden')`)
makes illegal values unrepresentable; `UNIQUE (order_id)` makes a second row
per order unrepresentable. No delete in v1 (not in the approved design; see
open questions).

### Display data and privacy

The public review object is exactly:

```json
{ "id": "c35d0e52-…-uuid…", "rating": 4, "text": "Well packed and as described.",
  "first_name": "Luca", "item_title": "Film camera", "created_at": "2026-11-17T…" }
```

- `id` is the review's own UUID. The report route needs it, and the only
  valid reporter — a third party — learns it from the public list; without
  it in the public object the report route would be unreachable. It is
  unguessable and correlates to nothing: no buyer id, email, or order id is
  derivable from it.
- `first_name` and `item_title` are **snapshots taken at post time** —
  derived from the buyer's `display_name` (trim, then the first
  whitespace-separated token, capped at 40 chars) and the item's `title`,
  written by the server from DB rows, never accepted from the client.
  **Fallback:** a `display_name` that is empty after trimming yields the
  literal `"Buyer"` — a whitespace-only name must not turn the INSERT into
  a 500, and with the fallback the NOT NULL + 1–40 length CHECK always
  holds. Display stays stable across later
  name edits and item edits, and survives item soft-deletion.
- **F1 mask on the first-name snapshot (THI-979, finding SR-5 on PR #319):**
  signup defaults `display_name` to the email local-part when the name
  field is skipped, so an unmasked snapshot can publish an email-derived
  handle. At insert the snapshot is masked with the shared F1 exact-match
  rule (`maskEmailDerivedHandle` in `src/display-names.ts` — the same rule
  as the seller-surface guard, with the buyer-shaped constant
  `MASKED_BUYER_FIRST_NAME`, "A Thingery buyer"), decided on the first
  word before the 40-char cap so an over-long local-part masks instead of
  truncating to a handle prefix. The public read re-masks stored rows with
  the same rule, so reviews already stored unmasked before the fix never
  publish a handle either — read-time masking was chosen over a data
  migration because it needs no schema/data rewrite, covers rows written
  between deploy steps, and re-checks on every render. Case-sensitive
  exact match only: chosen names that merely contain or case-differ from
  the local-part pass through; chosen names exactly equal to it are masked
  too (accepted over-blocking, same decision as the seller surface).
  The buyer's email is fetched in both paths as mask input only and is
  never serialized.
- The month label ("Nov 2026") is client-side formatting of `created_at`
  (frontend i18n); the API returns the timestamp.
- **Public responses never carry** the buyer's account id, email, or full
  display name, and never the order id — the review's own `id` (above) is
  the only identifier exposed. The buyer's own view (GET on their
  order) returns their own review in full — it is their data.
- Review text is stored raw and JSON-encoded in responses; rendering escapes
  it (the existing web-pages pattern). No HTML is ever interpreted.

## Data model changes (protected: `db/schema.sql`)

Additive only (expand-contract; no contract step ever needed). Follows the
`reports` table precedent:

```sql
CREATE TABLE IF NOT EXISTS order_reviews (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seller_id        UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,  -- snapshot of orders.seller_id
  buyer_id         UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,  -- author; snapshot of orders.buyer_id
  item_id          UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,    -- for the meta line
  rating           SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text             TEXT CHECK (text IS NULL OR char_length(text) <= 500),
  status           TEXT NOT NULL DEFAULT 'published'
                   CHECK (status IN ('published','hidden')),
  buyer_first_name TEXT NOT NULL CHECK (char_length(buyer_first_name) BETWEEN 1 AND 40),
  item_title       TEXT NOT NULL CHECK (char_length(item_title) BETWEEN 3 AND 200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 30-day edit-window anchor; never moved
  edited_at        TIMESTAMPTZ,
  UNIQUE (order_id)                                     -- one review per order, ever
);
CREATE INDEX IF NOT EXISTS order_reviews_seller_idx
  ON order_reviews (seller_id, created_at DESC) WHERE status = 'published';
```

- `UNIQUE (order_id)` is the dedupe barrier: a concurrent double-submit
  races the constraint and the loser (23505) is mapped to the same friendly
  409 as the pre-check — mirrors `reports`.
- Denormalized `seller_id`/`buyer_id`/`item_id` come from the order row in
  the same INSERT (`INSERT … SELECT … FROM orders JOIN items`), so the
  server never trusts the client for identity, and the profile aggregate is
  a single partial index scan. The partial `WHERE status = 'published'`
  index serves the profile list, the count, and the average — hidden rows
  are invisible to all three.
- `ON DELETE CASCADE` on every FK (privacy posture: reviews are attached
  data, not archives). An order row gone takes its review; an account gone
  takes its reviews. Item *soft* deletion (`status='deleted'`) keeps the
  review — the snapshot `item_title` still renders.

### Reports widening (protected: `db/schema.sql`, mirrors item-reports)

Review reporting goes **through the existing reports flow** — same table,
same reason slugs, same triage notification, same moderation operators —
not through a parallel mechanism. Additive widening:

```sql
ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_review_id
  UUID REFERENCES order_reviews(id) ON DELETE CASCADE;
ALTER TABLE reports ALTER COLUMN target_item_id DROP NOT NULL;   -- idempotent
-- exactly one target per report (DO-block guard, orders_status_check pattern):
-- CHECK ((target_item_id IS NULL) <> (target_review_id IS NULL))
CREATE UNIQUE INDEX IF NOT EXISTS reports_reporter_review_idx
  ON reports (reporter_account_id, target_review_id) WHERE target_review_id IS NOT NULL;
```

Existing rows are untouched (all have `target_item_id` set; the CHECK
holds). Item-report semantics are unchanged — same slugs, same endpoint,
same `UNIQUE (reporter_account_id, target_item_id)`.

## API changes (protected: `src/routes.ts`, `src/tools.ts`)

Logic lives in a new `src/reviews.ts` (not protected), mirroring
`src/reports.ts`: typed module errors, all SQL parameterized, snapshot
writes server-side. `src/routes.ts` only wires handlers; `src/tools.ts`
only registers the read tool.

### Writing — session-authed HTTP (the web order page)

No MCP write tool in v1 (rationale below). Three routes, all
`Cache-Control: no-store`:

**`POST /api/orders/:id/review`** — JSON `{ rating, text? }`.

| Outcome | Code | Body |
| --- | --- | --- |
| created | 201 | `{ ok: true, review: { rating, text, created_at, editable_until } }` |
| not signed in | 401 | `{ error: "Log in to review your orders." }` |
| invalid rating / text >500 / contact-info hit | 400 | `{ error: <field-specific, generic for contact info> }` |
| unknown order **or** caller is not the buyer | 404 | `{ error: "Order not found." }` |
| order not in `completed`/`paid_out` | 400 | `{ error: "You can review once the order is complete." }` |
| already reviewed | 409 | `{ error: "You already reviewed this order. You can edit it for 30 days." }` |
| rate limited | 429 | `{ error: "Too many review writes — try again later." }` |

404 for "not your order" (not 403): the buyer's own order page is the only
caller, and an unknown/not-owned id must not become an order-existence
oracle — same posture as the web order-status page.

**`PATCH /api/orders/:id/review`** — JSON `{ rating, text? }`; form
semantics — replaces both (text omitted ⇒ cleared to NULL). Same auth,
validation, 404, and 429 rows, plus:

| Outcome | Code | Body |
| --- | --- | --- |
| updated | 200 | `{ ok: true, review: { … } }` |
| none yet | 404 | `{ error: "No review yet for this order." }` |
| past the 30-day window | 403 | `{ error: "Reviews can be edited for 30 days." }` |
| hidden by moderation | 403 | `{ error: "This review is under moderation and can't be edited." }` |

**`GET /api/orders/:id/review`** — the order page's posted-state + Edit
view. 200 `{ review: null }` when the order is the caller's but unreviewed;
404 when unknown/not the buyer. Returns the caller's own review with
`editable: true|false`.

### Reading — public HTTP (profile list + item card summary)

**`GET /api/sellers/:id/reviews`** — public, unauthenticated. Query:
`limit` (0–50, default 10; **0 = summary only**, for the item-page seller
card) and `before` (opaque pagination cursor — exactly the value a previous
response returned as `next_before`). 404 for an unknown seller id; 400 for
a malformed `before`. Response, newest first, published only:

```json
{ "seller_id": "…",
  "summary": { "average": 4.8, "count": 12 },
  "reviews": [ { "id": "…", "rating": 5, "text": "…", "first_name": "Luca",
                 "item_title": "Film camera", "created_at": "…" } ],
  "next_before": "… | null" }
```

**Ordering and cursor.** Rows are ordered `(created_at DESC, id DESC)` and
the `before` cursor encodes that pair — `"<created_at ISO 8601>|<review
id>"` — so the page predicate is the row-value comparison
`(created_at, id) < (cursor.created_at, cursor.id)`. Same-timestamp rows
are never skipped and never repeated across pages. (A bare exclusive ISO
timestamp cursor was considered and rejected: with same-second inserts it
silently skips rows; the tie-break costs one expression and removes the
ambiguity.) `next_before` is the cursor of the last row of the page,
`null` at the end.

**Summary is capped per pair (K).** `average` (one decimal) and `count`
are computed over the per-pair capped set: among the seller's published
reviews, take at most the **K = 3 newest** per distinct buyer (same
ordering as above) — `ROW_NUMBER() OVER (PARTITION BY buyer_id ORDER BY
created_at DESC, id DESC) <= K`. `count` is the size of that capped set.
The **list is not capped** — every published review appears. K is the
named constant `REVIEW_AGGREGATE_PAIR_CAP = 3` in `src/reviews.ts` (v1
value); see "Off-platform farming defenses" for why.

No review list pagination beyond `before`; a profile page that outgrows it
can grow a search-style cursor later (YAGNI now).

### Reading — MCP tool (`src/tools.ts`)

**`get_seller_reviews`** — read-only, anonymous-readable (public data, same
class as `get_item`), full profile only in v1 (directory-profile inclusion
is an open question).

- Input: `seller_id` (uuid, required), `limit` (1–50, default 10), `before`
  (opaque cursor — the `next_before` value from a previous call, optional).
- Output: the HTTP read shape above plus `content_provenance:
  "user_generated"` stamped at the tool layer — parity with `get_item` and
  the wanted board: buyer-authored text reaches agents, so the same
  provenance marker travels with it. One shared function in `src/reviews.ts`
  builds the response; the tool adds exactly that one field and hides
  nothing (capped summary, ordering, and cursor are identical to HTTP).
- Rationale: agent clients evaluating a seller ("is this seller any good?")
  is a real browse-path use case — it is the trust answer the item summary
  compresses. Reading is safe to expose; writing is not (below).

**Why no MCP write tool in v1:** the boards deliberately put the review on
the web order page behind a human "Post review / Not now" choice — a review
is the buyer's personal voice about a person, and the prompt explicitly
says "About the order, not the person". Agent-posted reviews would widen
the abuse surface (one account, scripted reviews across every terminal
order) for no approved-design backing. HTTP-session writing only; an MCP
write tool, if ever wanted, is additive later.

**Docs:** `npm run docs:tools` regenerates `docs-site/tools/` — run in the
tool PR (repo map rule).

### Off-platform farming defenses

The vector: two colluding accounts can reach terminal `completed` with zero
platform money — the `self_order` guard stops one account, not a pair — and
unbounded, each farmed order mints a permanent published 5★ into the
aggregate trust signal shown on the item card. Two defenses, both fixed
here:

**(a) Per-pair aggregate cap (K = 3).** The summary — average and count, on
the profile and the item card — counts at most the K newest published
reviews per distinct buyer→seller pair (definition in the read section
above). A pair's aggregate influence is bounded at K no matter how many
terminal orders it stacks. Rationale: distinct relationships are the trust
signal; an honest repeat buyer loses nothing — all their reviews stay in
the public list, only the aggregate compresses them.

**(b) Pair anomaly signal (N = 10).** When a buyer→seller pair reaches
≥ N = 10 terminal *review-eligible* orders (`completed` or `paid_out`),
emit one `security_events` line — the stdout JSON convention of
`src/security-events.ts` (a new compile-time-literal union member, ids and
count only, no payload): `{ type: "review_pair_anomaly", buyer_id,
seller_id, terminal_orders }`. Hook: after a successful transition into
`completed`/`paid_out` (the `applyTransition` commit path), count the
pair's review-eligible orders and emit exactly when the count **crosses**
N (`= N` at the check) — one line per pair crossing, never per order.
Idempotent by monotonicity: no transition leaves a terminal state, so a
pair's count only grows and the crossing fires once. (Edge: an order row
deleted by CASCADE can drop a pair below N; a later terminal order
re-crosses and re-fires — correct, still bounded.) N is the named constant
`REVIEW_PAIR_ANOMALY_THRESHOLD = 10` in `src/reviews.ts` (v1 value). This
is an operator signal, not user-facing: it surfaces nothing publicly and
takes no action on its own.

**Residual risk, stated:** farming below the cap (a pair still moves the
aggregate by up to K) and sybil farming across many distinct fake accounts
(the cap is per pair — distinct buyers each count) remain. Bounds: the
anomaly signal at pair granularity, the report → triage → hide path,
contact-info screening, and the account-creation posture. The aggregate is
a trust signal, not a guarantee.

### Reporting a review (abuse)

**`POST /api/reviews/:id/report`** — JSON `{ reason, motivation }`, same
canned slugs and 10–1000 motivation rule as item reports. The `:id` is the
public review object's `id` — a third-party reporter has it from the public
list (that is why the public object carries it). Signed-in only
(401); 404 unknown review; **400 if the caller authored the review**
(self-report is a client bug, same stance as item self-reports); 409
duplicate; 429 rate limited. Creates a `reports` row with
`target_review_id` and the same external triage notification
("Board review: review `<id>` — `<reason>`", review URL, reason,
motivation, reporter id) — one flow, one operator inbox.

### Moderation (operator)

**`POST /api/admin/reviews/:id/hide`** — the item-takedown pattern exactly:
ADMIN_API_KEY bearer + `adminRouteEnabled` 404-mask + per-IP limiter +
required `reason` (1–500 chars). `UPDATE … WHERE status = 'published'` →
hidden; 404 if absent or already hidden. Hiding removes the review from the
list, the count, and the average in the same statement class the partial
index serves. The author is notified through the existing notification
planner (`dedupeKey: review-hidden:<id>`), same as takedown notifies the
seller. **Unhide is reserved, not routed** (operator SQL in v1) — one-way
operator actions mirror takedown; see open questions.

## Abuse rules (summary)

- **Rate limit:** one `RateLimiter` bucket for review *writes* (POST +
  PATCH), `reviews:acct:<account id>`, 20/hour — bounded well above honest
  use (a post per order + a handful of edits) and far below scripted
  sweeping. 429 + `security_events` row, the existing convention. Reads of
  the buyer's own review (`GET /api/orders/:id/review`) are **unthrottled
  by design**: the payload is the caller's own data, unknown/not-owned ids
  404 (no oracle for others' orders), and the query is a cheap indexed
  lookup — the same posture as the order-status page it serves. The public
  list is unthrottled public data (same class as item pages).
- **One review per order:** `UNIQUE (order_id)`, DB-enforced; races map to
  the friendly 409.
- **Per-pair aggregate cap (K = 3) + pair anomaly signal (N = 10):** the
  off-platform farming defenses, spec'd in "Off-platform farming defenses"
  above — the aggregate counts at most K published reviews per distinct
  buyer→seller pair, and a pair reaching ≥ N terminal review-eligible
  orders emits exactly one operator `security_events` line.
- **Contact screening:** review text goes through the same reject-never-
  rewrite screening as wanted listings (`src/contact-scrub.ts`), on POST
  and PATCH alike — public buyer-authored text is the same
  off-platform-extraction vector, and an edit is as much a publish as the
  original post. The screened-field union gains `review` additively; the
  generic message never names which rule tripped.
- **No reviews on cancelled or disputed orders:** follows from eligibility
  — only `completed`/`paid_out` are reviewable, and neither is reachable
  from a disputed/cancelled arm. Made explicit by the 400 above.
- **Moderation:** report → existing triage → operator hide. Hidden reviews
  stop counting everywhere (partial index), and become read-only.

## Seller reply — not in v1

The approved boards show no seller reply, and v1 should keep it that way.
**Recommendation: no seller reply in v1.** Trade-offs:

- *For:* sellers could correct the record on an unfair review; marketplaces
  with one-sided reviews can feel rigged against sellers.
- *Against:* it is not in the approved design (adding UI surface means a
  design round, not a spec rider); it doubles the moderation surface (reply
  text needs its own abuse rules, edit window, and hide path); the reply
  channel is the classic harassment vector (a public comment box aimed at a
  named-by-first-name buyer); and the seller's remedy already exists —
  report the review, operator hides it.
- *If ratified later:* one reply per review, ≤500 chars, no edit window,
  same screening, same report/hide path, buyer never re-replies. All
  additive (a nullable reply column + one render slot); nothing in this
  spec forecloses it.

The CEO ratifies this at spec sign-off.

## Migration plan

Two additive schema steps (`order_reviews`, then the reports widening —
they can land in the same PR or adjacent ones; both are
`IF NOT EXISTS`/idempotent and replay-safe). Zero downtime: tables appear
empty, no reader exists until the routes ship. Order: merge backend PRs →
deploy applies schema (runbook) → routes live but unused until the platform
frontend PR ships. `DROP NOT NULL` on `reports.target_item_id` is an
expand (widening); existing rows and the item-report endpoint are
unaffected; no contract step.

## Test plan (DB-backed, `describe.skipIf` without a database)

`tests/order-reviews.test.ts` (writes) and `tests/seller-reviews.test.ts`
(public reads + tool):

1. Anonymous POST → 401; GET public list stays open.
2. Buyer posts on `completed` (off_platform) and `paid_out` (stripe)
   orders → 201, row `published`, snapshots written server-side
   (`buyer_first_name` = display-name first token, `item_title` from items).
3. `cancelled`, `refunded`, `disputed`, `delivered` orders → 400 friendly;
   unknown order → 404; non-buyer session → 404 (no oracle).
4. Duplicate POST → 409, still one row (including a forced concurrent
   insert hitting the UNIQUE).
5. rating 0 / 6 / non-integer → 400; text 501 chars → 400; whitespace text
   → stored NULL.
6. Contact screening on POST: text containing an email/URL → 400 with the
   generic message; clean text passes.
6b. Contact screening on **edit** (PATCH): the same payloads through PATCH
    → 400 generic; a clean edit passes — written to drive the PATCH path
    so it fails against code that screens POST only.
7. Edit within window → 200, `created_at` unchanged, `edited_at` set,
   `editable_until` stable; past 30 days (injected clock) → 403; hidden
   review edit → 403; rating omitted → 400.
8. Rate limit: 21st write in the hour → 429 + `security_events` row.
9. GET own review: `{ review: null }` pre-post, full row post; `editable`
   flips false past the window; non-buyer → 404.
10. Public list: newest-first published only; `limit=0` → summary only;
    summary average rounded to one decimal, count excludes hidden; unknown
    seller → 404; malformed `before` → 400; payload contains no buyer ids,
    emails, or order ids (asserted by key absence) — each review's own `id`
    **is** present: unguessable, no correlation value, and the value the
    report route accepts (closes the reporting loop).
11. `get_seller_reviews` (anonymous server): same shape and rules as the
    HTTP read, plus `content_provenance: "user_generated"` on the tool
    response.
12. Review report: 201 → `reports` row with `target_review_id` and NULL
    `target_item_id`; duplicate → 409; own review → 400; item report
    endpoint unchanged (regression row).
13. Admin hide: no/ wrong key → 401; disabled admin routes → 404; success →
    hidden, gone from list + summary, author notified; second hide → 404.
14. `tests/schema.test.ts`: migration replays idempotently with both
    steps (existing pattern).
15. Aggregate cap (K): a pair with 5 published reviews → `count` = 3 and
    `average` over the 3 newest only, while the list still returns all 5;
    two distinct buyers × 3 published reviews each → `count` = 6.
16. Pair anomaly (N): a pair's 10th terminal review-eligible order →
    exactly one `review_pair_anomaly` line; 11th and 12th terminal orders
    → no further lines; a 10-order pair whose extras are `cancelled` → no
    line (not review-eligible).
17. Cursor tie-break: two reviews sharing `created_at` (injected clock) →
    ordering is `(created_at, id)`; walking pages via `next_before`
    returns both — no skip, no duplicate.

## Rollout + rollback

Rollout: merge → auto-deploy → schema applied → routes dark until the
platform frontend ships (form on the order page, list on the profile, card
summary on the item page — private repo). Smoke on thingery.dev: anonymous
list readable, buyer 201 → profile shows, duplicate 409.

Rollback: revert the PRs; the additive tables/indexes can stay (harmless,
no reader) or be dropped later — no destructive step required to roll back
behavior. Hidden moderation state survives a frontend revert untouched.

## Open questions

1. **Directory MCP profile**: include `get_seller_reviews` in
   `?profile=directory` (it is discovery/trust data) — v1 registers full
   profile only; the include set is additive either way.
2. **Seller notification on a new review** ("You got a 5-star review") —
   the notification planner makes this cheap; deliberately out of v1 to
   keep the first PR set minimal.
3. **Buyer review deletion** — not in the approved design (edit for 30
   days is the correction path); revisit only with a design round.
4. **Unhide path** — v1 reserves the state; if operator appeals appear, add
   the symmetric admin route (additive).
5. **"Verified order" badge on reviews** — every review is by construction
   from a real paid order, so a badge adds nothing; noted here only to
   close the question.

## PR breakdown (PR-sized steps)

1. `feat(reviews)` — `order_reviews` schema + `src/reviews.ts` module +
   POST/PATCH/GET `/api/orders/:id/review` + terminal-pair anomaly hook
   (`review_pair_anomaly`, N) on the transition commit path + tests.
   Protected: `db/schema.sql`, `src/routes.ts`.
2. `feat(reviews)` — `GET /api/sellers/:id/reviews` (per-pair capped
   summary K, tie-break cursor) + `get_seller_reviews` MCP tool + `npm run
   docs:tools` regen + tests. Protected: `src/routes.ts`, `src/tools.ts`.
3. `feat(reviews)` — reports widening + `POST /api/reviews/:id/report` +
   `POST /api/admin/reviews/:id/hide` + tests. Protected: `db/schema.sql`,
   `src/routes.ts`.
4. Frontend — order-page form, profile list, item-card summary (private
   `thingery/platform` repo; consumes only the routes above).

Each backend PR states the protected-path review sign-off in its
description (AGENTS.md rule 2); none starts before this spec is signed off.
