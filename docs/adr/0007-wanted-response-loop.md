# ADR 0007 — Wanted-listing responses: real listings behind the photo gate, surfaced via pull records

**Status:** Accepted (2026-10-31) · **Related:** THI-439 (spec rev 1), THI-440 (B1+B4 backend), ADR 0006 (buyer-alert pull channel), THI-305/THI-308 (photo-gated publishing), THI-380 (Security review pattern)

## Context

A wanted listing publishes structured, public buyer demand (THI-437 Phase 1). Sellers browse `/wanted` and respond. The response loop needs a shape for "seller X says they have what buyer Y wants" that respects two existing invariants: **responses happen through listings** (no off-platform contact vector) and **a listing is not visible until it has a photo** (THI-305/THI-308, no exceptions — the task explicitly says "no exceptions").

## Decision

**A response is an ordinary listing plus a link row.** `respond_to_wanted` creates a real listing via the existing `createItem` rails (caps, embeddings, photo gate) and inserts a `wanted_responses (wanted_item_id, seller_id, item_id)` row with `UNIQUE (wanted_item_id, item_id)` as the replay barrier. The listing is photo-gated like any other: invisible until its first photo. When a response listing first becomes feed-visible (create-with-photo, or the first `add_item_image`), the publish hook stamps `wanted_responses.published_at` once, idempotently, and can never fail the publish. The buyer sees responses as unread counts in `my_wanted` — the ADR 0006 pull channel; no push, no DMs.

- Wanted items carry **no contact fields and no buyer identity** (schema has none; `wantedToPublic` returns none) — by construction, not by policy filters.
- Response currency is unconstrained (explicit link, not a match): the buyer sees the listing as-is. Generic intent matching keeps its strict currency equality on its own rail (`evaluateListingForIntents` fires at the same publish transitions — two rails, one channel pattern).
- Title/notes are screened at create/edit by `src/contact-scrub.ts` (reject, never rewrite) so the public board cannot become a contact-info billboard.

## Alternatives rejected

- **Open DM thread between buyer and seller** — an unmoderated off-platform-fraud surface, plus new realtime infrastructure; defeats the no-contact-fields rule the moment the first message says "just email me".
- **Contact-info fields on wanted items** ("call me at…") — directly reintroduces the off-platform vector the marketplace deliberately excludes; also unmoderatable at 9 listings.
- **Lightweight "offer" row without a listing** — duplicates the listing rails (photo gate, caps, orders, disputes) for a worse artifact: an offer that cannot be bought, shipped, or disputed.

## Consequences

- The photo gate is load-bearing in the loop: a response is invisible until photographed, and the buyer is notified at that publish moment — never before (§3.5's `next_steps` copy leads with it).
- `published_at` is the buyer-facing "this response is live" bit; unread counts only count published responses.
- The publish hook touches `createItem`/`addItemImage` exactly where THI-360 PR 3 already hooked — additive, wrapped, idempotent.
- Step-ordering failure (listing created, response-row insert lost to a UNIQUE race) degrades gracefully: the buyer still gets the listing through any matching intent; logged as a rejected `wanted_response` event; the listing is never rolled back.
