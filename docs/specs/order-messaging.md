# Spec: buyer↔seller order messaging (THI-562 work item 1)

Status: proposed (2026-11-10) · Owner: Architect · Review: Security (auth/PII surface), CEO sign-off required — touches protected paths `db/schema.sql`, `src/tools.ts`.

## Problem

Order parties cannot talk to each other. The completion flow stalls on exactly
the conversations it needs: address questions, shipping delays, pickup
coordination, and dispute evidence. Today parties have no channel —
`src/chat.ts` is the website assistant, not person-to-person messaging.

## Context

- Orders and the state machine are live (`src/orders.ts`, ADR 0003). Parties
  are authenticated accounts (`sellers` table is the accounts table).
- `get_order` already releases the shipping address to the seller while
  shipping is due (`shippingAddressForSeller`). Messaging is the remaining
  seller-side gap; `my_orders(role=…)` and tracking already shipped
  (2026-11-09, PRs #199/#202 — the competitive analysis predates them).
- No messaging surface exists anywhere in the schema today.

## Proposed design

Party-to-party text messages scoped to one order. No notifications, no read
receipts, no attachments in v1 (YAGNI; see Open questions).

**Who may send:** the order's buyer or seller (verified by account id), while
the order is **non-terminal** (`status NOT IN refunded, paid_out, cancelled,
completed`). Terminal orders are read-only history — the sale is over.

**Who may read:** the order's parties, any status (history stays readable
after completion); the admin dispute UI (work item 3) reads messages for
dispute adjudication.

**Content policy:** text only, 1–2000 chars. Parties legitimately exchange
shipping details here — contact-scrub (listings) does **not** apply. Abuse is
bounded by rate limits and the terminal cutoff, not content filtering.

**Rate limits (two layers):**
1. Per order per sender: max 30 messages. Enforced by count on insert
   (`SELECT count(*) … FOR UPDATE` inside the insert transaction).
2. Per account: 20 messages/hour via the existing `rate-limit.ts` bucket
   (`ordermsg:acct:<id>`).

Both return a clear error; neither blocks reads.

## Data model changes (protected: `db/schema.sql`)

Additive only (expand-contract; no destructive step needed):

```sql
CREATE TABLE IF NOT EXISTS order_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id),
  sender_id   UUID NOT NULL REFERENCES sellers(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('buyer','seller')),
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_messages_order_created_idx
  ON order_messages (order_id, created_at);
CREATE INDEX IF NOT EXISTS order_messages_sender_created_idx
  ON order_messages (sender_id, created_at);
```

- Keyset pagination on `(order_id, created_at)`.
- `sender_role` is denormalized for cheap rendering; it is derived from the
  order row at insert time inside the same transaction (never client-supplied).
- Messages are NOT written to `order_events` — that table is the transition
  audit log; message rows are their own record. Volume discipline keeps
  order_events readable.

## API / MCP tool changes (protected: `src/tools.ts`)

Two new tools, additive — no existing signature changes (API evolution lens):

1. **`send_order_message`** — `order_id: uuid`, `body: string(1..2000)`.
   Party-only; non-terminal statuses only. Errors: `not_found` (non-party or
   bad id — same message, no oracle), `forbidden` (terminal order),
   `rate_limited`, `validation`.
2. **`list_order_messages`** — `order_id: uuid`, `limit: int 1..50 (default 20)`,
   `cursor: uuid optional`. Newest first, keyset paginated, `next_cursor`
   null on last page. Party-only, all statuses. Returns
   `{sender_role, sender_id, body, created_at, id}[]` + `next_cursor`.

Tool count in the registry goes 7 → 9; `docs/integrations.md`, README, and the
docs site must be updated in the same PR (Docs sync).

## Migration plan

Single additive migration in `db/schema.sql` (the repo's established
`CREATE TABLE IF NOT EXISTS` + index pattern, replay-safe). No backfill. No
contract phase.

## Test plan

- Unit: party check (buyer/seller/non-party 404s uniformly), terminal cutoff
  (each terminal status rejects), per-order cap 30, body validation (0, 2001,
  whitespace-only → reject), role derivation.
- Pagination: keyset across >50 messages, cursor stability, empty pages.
- Integration: send → list round-trip; rate-limit bucket trips at 21/hour;
  concurrent sends stay under the cap (count + insert in one transaction).
- Contract: existing tool outputs unchanged.

## Rollout + rollback

Feature ships dark (tools return data only when parties use them). Rollback =
remove the two tool registrations; table is harmless dormant state. No flags
needed — the rate limits bound the blast radius on day one.

## Open questions

1. Email/agent notification on new message — defer until there's a channel
   design (would go through the existing account email, never agent LLM
   inference).
2. Should `get_order` grow an `unread_message_count`? Defer — no read state
   in v1.
3. Message retention/PII policy after order completion — Security input
   wanted during spec review.

## Implementation steps (PR-sized)

1. **PR-A (protected):** `db/schema.sql` migration + `src/order-messages.ts`
   service (send/list, party checks, caps, rate-limit hook) + unit tests.
2. **PR-B (protected):** `send_order_message` + `list_order_messages` MCP
   tools wired to the service + docs (`docs/integrations.md`, README) + tool
   contract tests.
