# Spec: order read markers and party display names

Status: proposed · Touches protected paths `db/schema.sql`, `src/tools.ts`
(read-only extensions in `src/order-messages.ts`, `src/order-flow.ts`) — see
AGENTS.md for the review requirements those files carry. Implementation is
gated on that review of this spec; nothing here ships first.

## Problem

The order-messages surface ships with two gaps, both traced to missing server
capability:

1. **No read marker.** Nothing records which messages a party has already
   seen, so no client can show a new-message count. The phone order page's
   messages row shows none, and a party who misses a counterparty message
   finds out late — on off-platform orders that directly delays arranging
   payment, which happens in the messages thread.
2. **Role words instead of names.** The surfaces say "Messages with the
   seller" / per-message meta "Seller · 11:05" because order reads expose no
   party display names. The approved design reads "Messages with Marta" and
   "Marta · 11:05" — real names, roles only as fallback.

## Context

- `order_messages` is live: party-scoped, `sender_role` denormalized from the
  locked order row at insert, keyset-paginated newest-first, readable in every
  order status (history stays readable after the order finishes). Bounded:
  ≤ 30 messages per party per order, bodies 1–2000 chars.
- Accounts are the `sellers` table. `display_name` is the account's public
  name (1–80 chars at signup): public item payloads already expose the
  seller's; order reviews already show the buyer's first name publicly. Emails
  and handles are never in any item/order payload.
- `list_order_messages` and `get_order` are party-only; a missing order and
  another party's order are the same `not_found` — no oracle.
- The web order page is one server render for desktop and phone (responsive
  CSS): the desktop inline conversation and the phone row both load the
  thread. A marker advanced by *any* list would clear the phone count the
  moment the order page opens — before the user taps into the thread. So
  marking must be caller-controllable, and on the web tied to the
  conversation actually being seen.
- Read receipts were an explicit non-goal of messaging v1. A read **marker**
  (private per-account position) is not a read **receipt** (counterparty-visible
  "seen" signal): this spec adds the marker and no receipt.
- The web UI lives in the private `thingery/platform` repo (`apps/web`); its
  client calls the MCP tools over the session connection, and its zod schemas
  strip unknown keys — new output fields degrade to today's behavior until
  the client opts in.

## Rules (fixed by the approved design — not open for reinterpretation)

- The phone order page's messages row shows the count of NEW counterparty
  messages and reads "Messages with <counterparty display name>".
- The messages screen and the desktop inline conversation show each message
  sender's display name in the meta line ("You · 10:42", "Marta · 11:05").
- **Names only.** Display names sourced from account profiles. Never emails
  or handles — nothing here may enable off-platform contact.
- The count clears when the conversation is actually seen: on phones by
  opening the messages screen; on desktop by the inline conversation being
  visible. Merely opening the phone order page must not clear it.
- Read positions are private to the reader's account. The counterparty can
  never learn them.

## Proposed design

### Read marker

Additive `order_reads` table — one row per (order, reader) recording the
reader's position: the newest message the reader has listed. Explicit state
machine:

- `absent` — the reader never listed the thread's messages; every
  counterparty message counts as unread.
- `set` — read up to and including `last_read_message_id`.
- Transition: `absent → set` (first cursor-less list with ≥ 1 message) and
  `set → set'` only when the new candidate is **strictly newer** than the
  stored one. No other transitions exist: the marker never regresses, is
  never deleted except by row cascades, and no status of the order changes
  its semantics (reads stay open in terminal orders).

Writing: `listOrderMessages` performs the upsert **after its existing party
check**, in the same request, parameterized:

```sql
INSERT INTO order_reads (order_id, reader_account_id, last_read_message_id, last_read_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (order_id, reader_account_id) DO UPDATE
  SET last_read_message_id = EXCLUDED.last_read_message_id,
      last_read_at = now()
  WHERE (SELECT n.created_at FROM order_messages n
         WHERE n.id = EXCLUDED.last_read_message_id)
      > (SELECT o.created_at FROM order_messages o
         WHERE o.id = order_reads.last_read_message_id)
```

- Candidate = the newest message of the fetched page; only cursor-less
  (first-page) reads mark — page 1 always carries the thread's newest
  message, while paging back through history is not new-message reading.
- Strictly-newer guard ⇒ idempotent and replay-safe: re-listing with nothing
  new is a no-op; late/duplicated calls cannot move the marker backwards.
- Empty thread ⇒ no row (the FK below requires a real message; there is
  nothing to mark).
- The upsert runs in the list's own failure domain: if it fails, the read
  fails — `last_read` in the response must never lie about stored state.

Reading/derivation: **unread = counterparty messages strictly newer than the
marker's message** (all counterparty messages if `absent`). The server does
not compute or return counts; web and future clients derive them client-side
from `last_read` plus the fetched page. Comparison rule: a message is unread
iff its `created_at` is strictly greater than the marker message's
`created_at` (ISO-8601 UTC strings compare lexicographically). A message sent
in the same millisecond as the marker message can be miscounted by one —
accepted, bounded, self-correcting on the next read. Counts are naturally
capped by the fetched page (display "50+" style caps client-side).

Privacy: `order_reads` is written only after the party check and read back
only for the viewer. No tool or route exposes another account's marker — no
read receipts (v1 non-goal stands).

### Display names

- `get_order` output gains `buyer_display_name` and `seller_display_name`
  (`sellers.display_name`, joined server-side in `getOrderView`).
- Message objects in `list_order_messages` and `send_order_message` outputs
  gain `sender_display_name` (join the sender account; the admin dispute
  pages already join `sellers.display_name` this way).
- Party-only visibility rides the existing party checks; nothing becomes
  readable by outsiders. The buyer's display name becomes visible to the
  order's seller and vice versa — **names only**: emails and handles are not
  in any order payload (structurally: the source column is `display_name`).

## Data model changes (protected: `db/schema.sql`)

Additive only — expand-contract with no destructive step ever needed (the
table is dark without code, inert without readers):

```sql
-- Per-party read position for one order's message thread: the newest
-- message the reader has listed (spec docs/specs/order-reads-and-party-names.md).
-- PK (order_id, reader_account_id): one position per reader per order;
-- written only by a party-scoped list, read back only for the viewer —
-- never exposed to the counterparty (no read receipts).
CREATE TABLE IF NOT EXISTS order_reads (
  order_id             UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reader_account_id    UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  last_read_message_id UUID NOT NULL REFERENCES order_messages(id) ON DELETE CASCADE,
  last_read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when the marker last advanced
  PRIMARY KEY (order_id, reader_account_id)
);
```

- `last_read_message_id` NOT NULL with FK: a marker exists only once
  something was read. If a boundary message is ever deleted (abuse takedown,
  retention), the marker cascades away — worst case the badge recounts older
  messages until the next read. Named alternative, nullable +
  `ON DELETE SET NULL`: rejected — two marker states for no user-visible gain.
- No index beyond the PK: every access is the exact
  `(order_id, reader_account_id)` pair.

## API / MCP tool changes (protected: `src/tools.ts`)

All additive — existing signatures and outputs are unchanged for callers that
do not opt in (API evolution lens: extend, never mutate meaning).

1. **`list_order_messages`**
   - New optional input `mark_read` (boolean, default `true`). `true` — the
     approved default: a party listing the thread's first page marks it read
     for that account (an agent consuming the thread has seen it). `false` —
     report-only read for surfaces that must not clear a count (the web order
     page's shared desktop/phone render).
   - New output field `last_read`: `{ message_id, read_at } | null` — the
     caller's marker **as stored after this call** (read back after any
     upsert; `null` = never read). Present with `mark_read: false` too: it is
     the counting basis for client-side unread derivation.
   - Description updated: reading the first page marks the thread read for
     the caller's account unless `mark_read: false`; `last_read` carries the
     caller's read position.
   - `readOnlyHint` stays true: the tool never modifies order or thread
     content; it records only the caller's own reading position — a
     bookkeeping row keyed to the authenticated account, same authorization
     surface as before.
2. **Message objects** (both message tools): gain `sender_display_name`
   (string).
3. **`get_order`**: gains `buyer_display_name` and `seller_display_name`
   (strings) in the order payload allowlist (`orderToPublic`). Description
   updated: party display names are included — names only, never contact
   details.
4. **`my_orders`**: unchanged (no names, no markers in v1 — non-goal).

Named rejected alternative: a separate `mark_order_messages_read` write tool.
Rejected — it cannot solve the phone case (any default-marking list already
cleared the count before the user taps), adds a second endpoint for the web
to race, and duplicates the upsert. The opt-out input is the smaller surface.
Also rejected: default `mark_read: false` — contradicts the approved
"listing marks read" semantics and makes agent-consumed threads read as
perpetually unread.

## Web (private `thingery/platform` repo — separate PRs, after the above)

- `apps/web` tool-client zod schemas extend additively (`mark_read` input;
  `last_read`, `sender_display_name`, `buyer_display_name`,
  `seller_display_name` outputs). Role words stay the fallback whenever the
  fields are absent (older backend): degrade, never break.
- Order page: loads the thread with `mark_read: false`; derives the unread
  count from `last_read` + counterparty messages; phone row shows
  "Messages with {name}" and the count badge; desktop conversation meta shows
  sender names.
- Messages screen (phone): loads with the default (`mark_read: true`) — the
  count clears on open.
- Desktop inline conversation: a small client component fires one marking
  read (server action → `list_order_messages` with `mark_read: true`,
  `limit: 1`) when the conversation is actually visible — the shared server
  render cannot know the viewport. Rejected alternative: let desktop reads
  never clear the phone badge — stale-count incoherence.
- e2e: badge counts new counterparty messages; opening the screen clears it;
  names on row, heading and meta; hostile-name escaping proof.

## Migration plan

Expand-only. The `CREATE TABLE IF NOT EXISTS` block lands in `db/schema.sql`;
`scripts/migrate.ts` re-applies the file idempotently; the deploy runbook
applies the schema on deploy. Dark until the code PRs ship; no backfill (the
`absent` state is meaningful: everything pre-launch counts as unread once,
then settles on first read). Rollback: revert the code PRs — the table is
inert without them. No contract step exists or is needed.

## Test plan (public repo; DB-backed suites run in CI)

- Marker: set on first cursor-less read (`last_read` echo flips null → row);
  replay no-op; strictly-newer guard (an equal or older candidate never
  regresses the row); cursor reads never advance; `mark_read: false` never
  advances but still returns `last_read`; outsider list → `not_found` and no
  row; marker works in terminal statuses; empty thread → no row, `last_read`
  null.
- Names: `sender_display_name` on list and send outputs;
  `get_order` `buyer_display_name`/`seller_display_name`; key-absence
  assertions: no email or handle field anywhere in order/message payloads.
- Tools: response shapes are additive supersets (existing fields unchanged);
  `mark_read` is an optional boolean (invalid type rejected by zod);
  regenerated tool docs (`npm run docs:tools`) match the new descriptions.
- Web (platform repo): vitest for count derivation (marker vs messages,
  same-millisecond edge, >50 cap label); e2e per the web section.

## Rollout + rollback

PR order: (1) schema (dark), (2) read marker (service + tool + tests +
docs regen), (3) display names (service + tool + tests + docs regen),
(4) platform web. Each is independently revertible; (4) requires (2)+(3)
fields but degrades gracefully (zod strips unknown keys) — a partial rollout
shows today's role-word UX, never an error. Prod deploy of each merge is the
existing agent-authority runbook path.

## Open questions

- OQ1 — advance the marker on send? No: a sender's own messages are never
  unread for the sender; nothing to do. (Resolved; listed for the record.)
- OQ2 — unread counts on `my_orders` or a digest? Non-goal (YAGNI): any
  future count surface derives from the same marker with no schema change.
- OQ3 — refresh `last_read_at` on re-reads with nothing new? No: it means
  "when the marker last advanced". A "last seen" analytics column would be a
  future additive change, not this one.

## PR breakdown (each PR-sized; protected-path PRs state their sign-offs per AGENTS.md rule 2)

1. `db/schema.sql`: `order_reads` (dark, commented). ~30 lines.
2. Read marker: `src/order-messages.ts` (upsert + `last_read` read-back),
   `src/tools.ts` (`mark_read` input, `last_read` output, descriptions),
   DB + tool tests, docs-site regen. Protected.
3. Display names: `src/order-flow.ts` (`getOrderView` party join),
   `src/order-messages.ts` (sender join), `src/tools.ts` (`orderToPublic` +
   message shape + descriptions), tests, docs-site regen. Protected.
4. platform `apps/web`: client schemas, phone-row badge + "Messages with
   {name}", desktop names + seen-beacon, i18n, e2e. Private repo, same
   engineering rules.
5. Docs: reference-sync of guides beyond the generated tool docs — Docs
   looped in at PR 2/3 time or a follow-up docs PR.
