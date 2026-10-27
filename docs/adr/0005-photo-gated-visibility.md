# ADR 0005 — Photo-gated listing visibility: derived predicate + grandfather backfill

**Status:** Accepted (2026-10-27) · **Related:** THI-308 (spec rev 2, CEO-accepted 2026-10-27), THI-305 (CEO decision), THI-314 (Security review — APPROVE WITH FINDINGS)

## Context

Listings could be published with zero photos. Photos drive buyer trust and conversion, and the CEO decision (THI-305) is that ≥1 photo becomes effectively required at publish. Constraints that shape the design (THI-308 audit):

- No web listing form exists. Listings are created via MCP `create_listing` (`images[]` accepts only external http(s) URLs), MCP `add_item_image` (base64 upload **that requires an existing item**), or the chat assistant (hardcodes `images: []`).
- `items.status` CHECK has no draft/pending value.
- `searchItems` (`i.status='active'`) is the single feed choke point (browse grid + MCP `search_items`); the only other active-item queries are `listCategories` counts and `undeclaredKeyUsage`.
- `db/schema.sql` is applied as one multi-statement query per `db:migrate` run — a single implicit transaction, so an ALTER + backfill + re-constrain sequence is atomic at runtime and must be idempotent across re-runs.

## Decision

A **derived visibility gate**, never stored per-transition:

```
visible_in_feeds(item) = item.status = 'active'
                     AND (NOT item.photo_required OR cardinality(item.images) > 0)
```

- New column `items.photo_required BOOLEAN NOT NULL DEFAULT true` (expand-only ALTERs; the backfill is NULL-guarded so schema replays are no-ops). Every create after rollout gets `true` → the listing is **pending** (hidden from all feeds) until its first photo lands. `createItem` needs no code change — the column default covers it.
- **Grandfathering:** a one-time backfill sets `photo_required = false` on all pre-deploy rows; existing zero-photo listings stay live. No forced photo backfill.
- The predicate is applied at the three feed surfaces — `searchItems`, `listCategories` counts, and `undeclaredKeyUsage` (THI-314 F2: attributes of pending listings must not surface in `describe_category` hints). `getItem` and `myItems` stay unfiltered: direct item URLs render (with placeholder + noindex, PR 3), and owners see their own pending listings.
- Visibility is a pure function of stored columns: adding the first photo makes the listing live with no flag flip to maintain; deleting the last photo returns it to pending (PR 4). No stored publish flag exists to race.

## Alternatives rejected

- **A stored `draft`/`pending` value in the `items.status` CHECK** — a second state machine that every status-touching query and tool must learn; publication becomes a stored transition that can race concurrent updates. The derived predicate is additive (one column + one WHERE fragment) and cannot drift from reality.
- **Hard create-time API rejection of zero-photo listings** — deadlocks the only agent path to server-stored photos: `add_item_image` requires an *existing* item, so a listing that must be created with a photo could never receive one through that tool. Breaks the documented MCP create-then-photograph flow.
- **Require a server-stored photo in the predicate (Security THI-314 F1 option b)** — counting only `/img/items/...` members would make legitimate external-image MCP listings (`create_listing` with http(s) `images[]`, a documented use case) permanently invisible while adding near-zero anti-spam value: a spammer can base64-upload a 1×1 JPEG just as trivially. Velocity caps remain the actual spam control.

## Consequences

- **F1 accepted residual (THI-314):** the gate counts **any** `images[]` member, including external http(s) URLs. A spam listing can prepend one URL and become visible. Per-seller velocity caps (100 creates/day, 200 active listings; `src/items.ts`) plus upload quotas remain the spam controls. Also recorded in `docs/security.md` §3.1.
- Rollback is a plain revert of the code PRs; the `photo_required` column is harmless residue (drop later if ever). The grandfather backfill is permanent and safe. No destructive migration step exists.
- Feed consumers see a documented semantic change: `search_items`/browse/category counts now exclude pending items. All output shapes are unchanged in this PR (publish-state fields land additively in PR 2).
