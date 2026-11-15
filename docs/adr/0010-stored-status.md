# ADR 0010: `stored` inventory status and an explicit item transition table

- **Status:** Accepted (2026-11-15: Security pre-review PASS with riders, verdict `8a21d92d`; CEO sign-off APPROVED, decision `1ec6fc52`; both bound to spec-p1-1 rev `7766d9c3` and this ADR rev `b3efbfe3`. Rider carried into implementation: the legacy-status transition table stays deferred — one behavior change per PR.)
- **Date:** 2026-11-15
- **Implements:** unblocks THI-815 (P1-3 backend); consumed by THI-816 (P1-4), THI-817 (P1-5)

## Context

The 90-day plan's single-player promise is " Thingery is worth using with zero buyers": catalog your stuff now (photo + one line → draft → **save as stored**), flip items to for-sale later. Today the items status domain is `active/reserved/sold/deleted` — there is no state that means *"in my inventory, not currently for sale."* `deleted` is the only "not selling" state, and it is the wrong one: it is excluded from the owner's default listing list, it is an order-machine outcome (carrier failure), and re-entry means recreating the row.

Who writes item status today (grounding from the code):

1. `createItem` — inserts `active` (feed visibility is separately gated on the first photo, ADR 0005; "pending" is derived, not a status).
2. `updateItem` (owner via `update_listing`) — free-form: the owner may set any of the four statuses at any time. **There is no item transition table**; the only guarded item writes are the order machine's conditional updates.
3. `create_order` (#1) — conditional `active → reserved` (`WHERE status = 'active'`; 0 rows = buyer lost the race).
4. Order-machine transitions — set `reserved/sold/active/deleted` per the `itemStatus` column of `TRANSITIONS` (src/orders.ts).

Two non-order readers already scan `status <> 'deleted'` and would wrongly include a new not-for-sale status: buyer-intent matching (`evaluateListingForIntents` + the matches view, src/intents.ts) and wanted-response counts (src/wanted.ts). Those are part of this decision's blast radius, not an afterthought.

Constraints: MCP API evolution (existing agents know four statuses — a fifth must be additive and mostly invisible to them); protected paths `db/schema.sql` + `src/tools.ts` (+ `src/items.ts` semantics); zero-re-entry is a hard requirement from the plan ("toggling preserves all data and indexing").

## Decision

1. **Add `stored` to the items status domain** via an idempotent CHECK-widening block (drop/re-add `items_status_check` with the five-value list — the exact pattern `orders_status_check` already uses in `db/schema.sql`) plus the inline CHECK updated for fresh databases. `STATUSES` (src/db.ts) gains `"stored"`; every `z.enum(STATUSES)` site (`my_listings`, `update_listing`) picks it up automatically.

2. **`stored` means owner-private inventory.** Excluded from: `search_items` (already automatic — public search filters `status = 'active'`), category counts and `describe_category` listing counts (automatic), `get_item` for non-owners (change: today it filters only `deleted`; stored → `not_found` unless the caller is the authenticated owner), buyer-intent matching and the matches view (change: `<> 'deleted'` → `= 'active'`), wanted-response counts (same change), `respond_to_wanted` (change: linking a stored item is rejected — a response to a wanted post is an offer to sell). Visible only to the owner: `my_listings` (default list already returns `<> 'deleted'`, so stored shows up; `status: "stored"` filter works via the enum) and owner-scoped `get_item`. `stats.ts` keeps `<> 'deleted'` deliberately and is documented as counting *tracked items*, not live listings.

3. **Explicit transition rules for `stored`, enforced in `updateItem` — illegal transitions are typed errors, never inferred:**

   | From → To | allowed? | guard |
   |---|---|---|
   | `active → stored` | yes | rejected (`item_in_order`) while a live order exists on the item (order status in the `one_live_order_per_item` set) |
   | `stored → active` | yes | always (a stored item has no live order by construction) |
   | `stored → deleted` | yes | owner removing inventory entirely |
   | `stored → reserved`, `stored → sold` | **no** | order-machine-owned states |
   | `reserved/sold/deleted → stored` | **no** | only `active` may enter `stored` |
   | all legacy moves among `active/reserved/sold/deleted` | unchanged | deliberately not re-restricted in this PR (see Open Questions) |

   Rationale: a live order can never exist on a stored item — `create_order`'s conditional update requires `active`, and order transitions never produce `stored` — so the `item_in_order` guard is a thin belt-and-braces check on the one race (owner toggling while an order is being created).

4. **`create_listing` gains an optional `status` input: `"active"` (default) | `"stored"`.** No other values — `reserved`/`sold` are order-machine-owned, `deleted` has its own path. Default absent = `active`, byte-identical to today: existing agents are unaffected (API evolution: extend, don't mutate). This is the "save as stored" leg of the P1-5 UI and the natural landing for confirmed drafts.

5. **Zero re-entry by construction:** stored preserves images, attributes, embedding, price — the toggle is one `UPDATE items SET status …` and the row re-enters search immediately (embedding and GIN indexes untouched; the photo gate still applies on its own terms: a photo-less item stays feed-invisible regardless of status). **Buyer-intent fan-out fires on entry into `active`**: `evaluateListingForIntents` is skipped for `stored` creation and triggered on the `stored → active` transition — flipping inventory to for-sale is exactly the moment a buyer alert should fire.

6. **No new columns, no new tables, no sweep.** The toggle needs no timestamp (`updated_at` moves); nothing keys on item-status history.

## Alternatives rejected

- **Boolean `for_sale` flag beside status:** two sources of truth for visibility; every reader grows a compound predicate; rejected — one status domain.
- **Separate `item_inventory` table:** joins on every read, duplicates listing data, forces a migration path for items that move between tables; rejected.
- **Reusing `deleted` for storage:** overloaded semantics (order-machine outcome, excluded from owner default lists); rejected.
- **Renaming `active` → `for_sale`:** breaks every deployed agent — the plan's "stored ⇄ for_sale" is the UI toggle label, not a schema value; `active` remains the for-sale value.
- **`sold → stored` shortcut:** sold items are order-history records; the legal path is `sold → active → stored` (two explicit calls), keeping the audit story simple.
- **A full transition table for the legacy statuses in this PR:** would change behavior for existing agents (e.g. `sold → active` relist is legal today and used); one behavior change per PR — recorded as an open question instead.
- **Widening via a new CHECK constraint name alongside the old:** two constraints on one column diverge across replays; the drop/re-add widening block is the established idempotent pattern in this schema.

## Consequences

- Buyer agents can only observe `stored` through owner-scoped reads; all public surfaces never return it (documented in `llms.txt` + `agents.json` with the P1-6 docs pass).
- `get_item` returning `not_found` for non-owners of stored items is a visible tightening — public item pages (platform repo) must respect the 404; caches of public pages must not serve stored items. Named blast radius for DevOps/P1-5.
- Intent matching and wanted-response counts become active-only: fixes a latent over-notify bug for `reserved` items at the same time (a reserved item firing buyer alerts wasted buyer attention) — called out in the PR description, not slipped in.
- The items status CHECK re-enters the protected-path regime: any future status change re-runs spec-first + Security + CEO gates.
- The widening migration is expand-only and replay-safe; rollback is a code rollback (the extra CHECK value is inert for old code — it only *rejects* fewer rows, and old code never writes `stored`).

