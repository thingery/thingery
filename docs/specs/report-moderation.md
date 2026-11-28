# Spec: report moderation (description in report email, suspend/delete powers, owner notification)

Status: draft for review · Touches protected paths `db/schema.sql`, `src/routes.ts`,
`src/tools.ts`, `src/web-pages.ts`, `src/chat.ts` — see AGENTS.md for the sign-off those
changes require. Amends the
item-reports spec (`docs/specs/item-reports.md`) — read that first for the report
data model and delivery machinery; this spec only changes what it names.

## Problem

Three gaps in the report→moderation loop:

1. **The report email omits the problem description.** The report→alias mirror
   (`ops.item_reported.v1`, notify/operator.ts) deliberately carries only report id,
   item id, reason slug, timestamp. When a reporter picks "other" and writes a
   free-text problem description, the alias mailbox receives the metadata but not the
   description — the one field the reporter wrote *for* the moderation reader. The
   moderator must open the reports table (or the triage task) to read it.
2. **Moderators have no reversible action.** The only admin listing action is
   `POST /admin/items/:id/takedown` → status `deleted` (terminal). There is no
   suspend: a borderline listing must be either left visible or permanently removed.
3. **Moderators have no queue.** Open reports are visible only via the reports table
   and the external triage task; the admin UI lists disputes only. A moderator cannot
   see the open reports with their motivations and act on them.

Owner notification on deletion already exists (takedown plans
`seller.item_taken_down`, dedupe `takedown:{item_id}`); suspension needs its twin.

## Context

- The admin surface authenticates with a shared deployment-configured admin key
  (`ADMIN_API_KEY`, ≥32 chars, boot-gated fail-closed): Bearer for the JSON routes,
  one-time key at `POST /admin/login` for the HTML session (HMAC cookie + CSRF).
  Moderator identities are a deployment concern (which humans hold the key is
  provisioning, not product); the core stays generic.
- Items: `status` CHECK `('active','stored','reserved','sold','deleted')`; feeds
  filter `status = 'active'`; `get_item` treats `deleted` as not_found and `stored`
  as owner-private (ADR 0010). Seller-side transitions are free-form among
  active/reserved/sold/deleted (`assertItemTransition`) — a new moderator-only status
  must be fenced in that table or sellers could reverse moderation themselves.
- Orders are guarded by a conditional `UPDATE … WHERE status = 'active'` reservation,
  so any non-`active` status is already unbuyable — no order-path change needed.
- Reports: `status open → resolved | dismissed`, CHECK-constrained, no mutator exists
  yet (the item-reports spec reserved the states for operator triage "later" — this
  is that later).
- Owner emails ride `planAccountNotification` (notifications + email_outbox rows,
  `ON CONFLICT (dedupe_key) DO NOTHING`, orders-class: seller prefs + verified-account
  gate apply at send time). Alias/operator emails ride the account-less `ops.*`
  outbox path, which deliberately bypasses the account gate (internal mailbox).
- Email delivery is the outbox sweep; nothing here sends synchronously.

## Proposed design

### 1. Report email carries the description (all categories)

Reverse the "PII-minimal payload" decision for the motivation field only. The
motivation is authored content intended for the moderation reader; it is length-capped
(10–1000 chars) at insert time and the rendering path HTML-escapes every line.
`planItemReportEmail` adds `motivation` to the `ops.item_reported.v1` payload; the
template renders one `Description:` line after the reason. Everything else about the
mirror is unchanged: same dedupe key `report:{id}` (at-most-once per report), same
ride-the-insert-transaction write, same account-less delivery, same dark default when
`REPORT_ALERT_EMAIL` is unset. Self-hosted deployments that enable the alias now
receive the description too — that is the feature working as intended on their own
data, not a leak.

The motivation was never a secret from the operator: it is already in the reports
table, the triage task body, and the admin queue this spec adds. The email body is
sent by the operator's own deployment to the operator's own alias.

### 2. `suspended` item status (reversible moderation)

Widen the `items.status` CHECK with `'suspended'` (additive expand migration —
expand-contract; no destructive step). Semantics:

- **suspend** = hidden from every public surface, listing and attributes preserved,
  restorable. For borderline reports: suspected spam pending review, policy check in
  progress, seller contacted.
- **delete (takedown)** = terminal removal from all surfaces (existing behavior).
- Eligibility (mirror takedown): only `active` and `stored` items may be suspended;
  `reserved`/`sold` have live orders (use the dispute flow), `deleted`/`suspended`
  are out of band.
- **Reader inventory (every `getItem` path, spec-review RC-1/RC-2 + security-verdict F1):**
  adding a status value means sweeping **all** read surfaces, not just the MCP tool:
  `get_item` (MCP, `src/tools.ts`) → not_found; public item page (`src/web-pages.ts`)
  → 404 like `deleted`; **chat `get_item` op (`src/chat.ts`) → `not found` for
  everyone — the chat surface is a full API twin of the MCP surface and must be in
  every read-path enumeration**; **chat `create_order` confirm-card gate
  (`orderWriteGate`) → `"Item not found."` so the card never renders moderated
  content** before the reservation's `WHERE status='active'` fails closed
  (reserved/sold keep their card-then-`item_unavailable` flow); feeds/search/seller
  profiles/intents already filter `status='active'`; `my_listings` (`status <>
  'deleted'`) keeps showing it to the seller with the status that explains why it
  vanished. This sweep checklist is recorded for `docs/security.md` (follow-up).
- `get_item` (MCP tool) treats `suspended` like `deleted` — not_found for everyone.
  Feeds already exclude it (`status = 'active'` filter); the seller's own
  `my_listings` (`status <> 'deleted'`) keeps showing it with its status, so the
  seller can see why their listing vanished.
- Buy path: unchanged — the reservation guard only reserves `active` items, so a
  suspended item cannot enter an order.

**Explicit state machine (admin routes only):**

```
active|stored --suspend-->  suspended
suspended     --reinstate--> active
active|stored|suspended --takedown--> deleted
```

- Nothing else may enter or leave `suspended`.
- **Seller-side fence (`assertItemTransition`):** any seller-requested transition
  involving `suspended` — in either direction — throws `invalid_item_transition`.
  Only the admin routes above can write it. Same-status writes stay no-ops. The
  suspended checks run **before** the `from !== "stored" && to !== "stored"`
  early-return (spec-review note N-3), so a seller cannot delete their own suspended
  listing either — intended: the moderator keeps recoverability.
- Suspension does not block the seller from editing other fields of a suspended
  listing (price/description edits are inert while hidden); only the status moves are
  fenced. Keeping the fence narrow keeps the diff small; widening it later is
  additive.

### 3. Admin moderation routes (JSON, Bearer key — existing pattern)

New routes follow the takedown pattern exactly: boot gate (short/unset key ⇒ 404),
per-IP attempt limiter, timing-safe key compare, zod body validation, `no-store`.

| Route | Body | Effect |
| --- | --- | --- |
| `POST /admin/items/:id/suspend` | `{ reason: 1..500 }` | `active|stored → suspended`; owner email `seller.item_suspended` (dedupe `suspended:{id}`); open reports on the item → `resolved` |
| `POST /admin/items/:id/reinstate` | `{}` | `suspended → active`; no email in v1 (open question 2) |
| `POST /admin/items/:id/takedown` | unchanged | eligibility widened to include `suspended` (escalation); now also resolves open reports on the item |
| `GET /admin/reports` | — | open reports, newest first, with motivation, item link, reporter id, timestamps; capped page |
| `POST /admin/reports/:id/dismiss` | `{ note: 0..500 }` | report `open → dismissed` (reviewed, no action); note stored in the report row |

All are additive; no existing route changes meaning (takedown gains eligibility
states and the report-resolution side effect — both named above). **Limiter buckets
(spec-review note N-2):** queue reads (`GET /admin/reports` JSON and the HTML page) use the
page-class bucket (~300/h, `adminPageLimiter`-style) so routine polling cannot eat
the auth-attempt budget; all POSTs (suspend/reinstate/takedown/dismiss) stay on the
strict `adminAttemptLimiter`.

**Report state machine (now with mutators):**

```
open --moderation action (suspend|takedown on target item)--> resolved
open --dismiss--> dismissed
resolved, dismissed: terminal (no transition route; re-reporting is the reporter's dedupe-bounded remedy)
```

- Resolution is a side effect of the action, in the same transaction as the item
  status change: the report cannot end up open while its target is gone.
- `resolved` reports keep `resolution` metadata (which action, when) as additive
  columns (below) so the queue/history shows what happened without a join.
- Dismiss requires no reason but accepts an optional note (audit trail, PII-free
  discipline: notes are moderation content, stored, never emailed).

### 4. Owner notification on suspend

`seller.item_suspended.v1` — new template beside `seller.item_taken_down.v1`, same
layout and discipline: what happened, which listing, the moderator's reason, item
link, "contact the operators if you believe this is a mistake". Planned via
`planAccountNotification` with dedupe `suspended:{item_id}` — **at most once per
item lifetime: the key has no epoch, so a re-suspension after a reinstate does not
re-notify** (security-verdict F3); prefs + verified-account gate apply at send time.
Reinstatement does not
email in v1; takedown keeps its existing email and dedupe.

### 5. Admin UI: reports queue

One HTML page beside the disputes queue (`GET /admin/reports` HTML via the session
router, CSRF-protected action forms: suspend / delete / dismiss). Same boot gate,
session gate, page limiter, no-store, unlinked + noindex discipline as the disputes
pages. The JSON routes above stay the script path; the page is the human path.

### 6. Moderator access

No new auth surface. Moderators are admin-key holders: the JSON routes take the
Bearer key, the HTML queue takes the key at `/admin/login` (8h session). Provisioning
the key to specific humans is deployment configuration (env + secret channel), out of
scope for the core repo. Actions are attributable in aggregate only (shared key) —
per-moderator identity is a future enhancement, deliberately not built now
(Simplicity: the smallest design that satisfies the need; a two-person team sharing a
rotatable key is the existing accepted posture of the admin surface).

## Data model changes (protected: `db/schema.sql`)

Additive, replay-safe — shipped as the idempotent guarded DO block the schema
already uses (spec-review note N-1: the sketch below is illustrative; the **shipped**
migration is a DO block that inspects the live `items_status_check`, drops and
re-adds it widened only when `suspended` is absent, and the inline `CREATE TABLE
items` CHECK is widened in the same PR so fresh installs and replayed installs
diverge never):

```sql
-- Widen items.status CHECK with 'suspended' (report-moderation spec: reversible
-- moderation state; only admin routes may write it — see the transition fence
-- in src/items.ts). Same pattern as the stored widening: inspect the live
-- constraint, drop, re-add widened; idempotent on every replay.
ALTER TABLE items DROP CONSTRAINT items_status_check;
ALTER TABLE items ADD CONSTRAINT items_status_check
  CHECK (status IN ('active','stored','reserved','sold','deleted','suspended'));
```

`reports` gains additive, nullable columns (no backfill needed — existing rows are
history):

```sql
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolution_action TEXT;   -- 'suspended' | 'deleted' | NULL
ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;  -- set when leaving 'open'
```

`dismissed` rows keep `resolution_action` NULL (the dismiss note is stored in a new
`dismiss_note TEXT` column, capped 500 by the route validation). Status CHECK is
unchanged (`open`,`resolved`,`dismissed` already cover the new transitions).

## API / MCP tool changes

- MCP tool signatures: **unchanged**. `get_item`'s response set gains no fields; a
  suspended item simply returns not_found like a deleted one (API evolution: callers
  already handle not_found). `search_items`/feeds never returned non-`active` items.
- Admin JSON API: additive routes listed above. Admin UI: one additive page.
- Public item/report API: unchanged. The report email payload gains one key
  (`motivation`) — additive, rendering ignores unknown keys.

## Migration plan

1. Merge code + schema together (deploy runbook applies `db/schema.sql` replay
   before/with the app rollout; the widening is safe against the old code — old code
   never writes `'suspended'`).
2. New routes are dark until a moderator calls them; the reports page is unlinked.
3. No data migration: existing reports stay `open` and remain resolvable via the new
   routes; existing `deleted` items are untouched.

## Test plan

Pure unit (no DB): template rendering for `ops.item_reported` with motivation
(escaped HTML, text + html bodies), `seller.item_suspended` rendering,
`assertItemTransition` fence cases (suspended in either direction rejected; active →
stored unchanged; same-status no-ops).

DB-backed (skip-guarded, existing suites extended):

- Report email: payload contains the motivation verbatim; delivered body (sweep +
  recording mailer) contains the motivation text; review reports still mirror
  nothing; dedupe still one row per report.
- Suspend route: boot gate 404, bad key 401, missing reason 400, active → 200
  suspended + one owner outbox row + open reports now `resolved` with
  `resolution_action='suspended'`; second suspend → 404 (status guard); suspended →
  reinstate → 200 active; reserved item → 404 not eligible.
- Takedown: suspended item escalates to deleted; open reports resolved with
  `resolution_action='deleted'`; dedupe `takedown:{id}` unchanged.
- Seller fence: `updateItem` status suspended → invalid_item_transition;
  suspended → active (seller) rejected; other transitions unchanged.
- get_item: suspended → not_found.
- **Reader sweep (spec-review RC-1/RC-2 + security-verdict F1 — these regression tests must
  fail against code without the guard):** public item page `/item/:id` → 404;
  chat `executeTool("get_item", { id }, viewer)` → `not found` for anonymous,
  other, and owner (no carve-out); chat `orderWriteGate("create_order", …)` on a
  suspended item → `{ outcome: "error", error: "Item not found." }` (and
  `deleted` stays `Item not found.` too; `reserved` keeps its gate flow).
- Reports queue JSON: boot gate, key, open-only list carries motivation; dismiss →
  dismissed, second dismiss → 404; queue reads on the page-class bucket, POSTs on
  `adminAttemptLimiter` (spec-review note N-2).

## Rollout + rollback

Rollout: PR-1 (email fix, non-protected) merges independently and is immediately
live; PR-2 (status + routes + visibility) deploys with the schema replay; PR-3
(reports queue JSON + resolution wiring); PR-4 (admin UI page). Each step is usable
alone: a moderator can act via JSON from PR-2 before the page exists.

Rollback: revert the PRs; the widened CHECK and new columns are inert for old code
(no writer) and can stay. The email payload key is additive — old renderers ignore
it. No destructive step is required at any point.

## Blast radius

- Registry/npm installs: no MCP signature change; not_found-for-suspended matches
  existing deleted-item behavior. Self-hosters get the new admin routes dark unless
  they set an admin key; the email change only matters if they set
  `REPORT_ALERT_EMAIL`.
- Live sessions: none touched (no session/auth changes; admin surface keeps its
  shared-key posture).
- Owner emails: one more orders-class template; the delivery sweep is unchanged.

## Accepted residuals (recorded for `docs/security.md`, follow-up ticket)

- Suspended items' uploaded images remain fetchable at their `/img/…` URLs
  (identical to `deleted` items today; rows and objects are never removed).
- `/stats.json` public item total counts suspended rows (`status <> 'deleted'`,
  `src/stats.ts`) — aggregate number only, no enumeration path; excluding them is
  a separate product call.
- Shared `ADMIN_API_KEY` gives aggregate-only attribution (standing
  follow-up: per-operator tokens).
- **Process control:** adding a status value requires a documented sweep of all
  read paths (MCP, web, chat, feeds, stats) — the chat twin was missed in the
  first PR-2 push because the enumeration list omitted it (security-verdict F1 root
  cause); the checklist goes into `docs/security.md`.

## Open questions

1. **Should suspension expire?** (auto-reinstate after N days) — not in v1; the
   queue shows suspension age, so nothing is silently forgotten. Revisit if volume
   demands.
2. **Reinstate notification email?** Skipped in v1 (the seller sees the listing
   live again in their own listings view). Cheap to add later as another template.
3. **Per-moderator identities/audit?** Shared key stays for v1 (two operators);
   per-moderator sessions are a larger auth-surface change needing its own spec.

## PR-sized breakdown

1. **PR-1 (non-protected):** this spec + the report email motivation
   (`notify/operator.ts` payload + `notify/templates.ts` rendering + tests).
2. **PR-2 (protected: `db/schema.sql`, `src/items.ts`, `src/routes.ts`,
   `src/tools.ts`, `src/web-pages.ts`, `src/chat.ts`):** `suspended` CHECK widening
   + transition fence + suspend / reinstate routes + takedown eligibility widening
   + `get_item` suspended → not_found + item page 404 + chat `get_item`/
   `create_order` gates + `seller.item_suspended` template + tests.
3. **PR-3 (protected: `db/schema.sql`, `src/routes.ts`):** report resolution
   columns + auto-resolve on suspend/takedown + `GET /admin/reports` JSON + dismiss
   route + tests.
4. **PR-4 (protected: `src/routes.ts`):** admin UI reports queue page + tests.

PR-2 must land before PR-3/PR-4 (they act on the states it introduces). PR-1 has no
dependency and can merge immediately.
