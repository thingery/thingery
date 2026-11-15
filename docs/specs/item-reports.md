# Spec: item reports (report button MVP)

Status: implemented (schema, endpoint, and notification seam shipped — see PR
breakdown) · Touches protected paths `db/schema.sql`, `src/routes.ts` — see
AGENTS.md for review requirements on those files.

## Problem

Users have no way to flag a listing. Operators only learn about bad listings
when someone bothers to contact support out-of-band; the live chat assistant
even improvised references to a nonexistent "report/flag option". The MVP:
signed-in users press Report on an item, pick a cause, add a required
motivation — and every report opens a triage task in the operator's external
review system for moderation.

## Context

- Accounts are the `sellers` table; sessions are `sellerFromSession`
  (`src/auth.ts`) — the site's authenticated-user seam for HTTP routes.
- Rate limiting is the in-memory `RateLimiter` (`src/rate-limit.ts`), keyed per
  account (e.g. `imageUploadLimiter`); 429s log `security_events`.
- Schema changes ship additively; `scripts/migrate.ts` re-applies
  `db/schema.sql` idempotently (`IF NOT EXISTS` everywhere). Merging to main
  deploys to prod — the deploy runbook applies the schema.
- Frontend lives in the private `thingery/platform` repo (`apps/web`); the
  core endpoint/table here stay generic and unbranded (repo boundary, see
  AGENTS.md).
- Triage notification targets the operator's external review system via a
  minimal, deployment-configured contract: `POST {REPORT_REVIEW_CREATE_URL}`
  with bearer `REPORT_REVIEW_API_TOKEN`, JSON
  `{ title, description, assigneeAgentId, idempotencyKey }`, reading `id`
  from the 2xx response. The public core stays agnostic of any specific
  tracker (repo boundary: no internal tooling names in this repo); endpoint
  and credential provisioning is a deployment concern (step 3); this spec
  designs the seam, not the credential.

## Proposed design

One authenticated endpoint, one table, one best-effort triage notification.

**Who may report:** any signed-in account, except the item's own seller
(self-reports are a client bug, not a signal — rejected with a friendly 400).
Anonymous users get 401; the frontend hides the action entirely.

**What can be reported:** any existing item by id (404 otherwise — item ids
are public, no oracle concern).

**Cause (canned, stable slugs):** `explicit_images` · `scam_fraud` · `other`.
Labels live in the frontend i18n; slugs are the API contract (API evolution:
additive only, never rename).

**Motivation:** required free text, `char_length BETWEEN 10 AND 1000`,
enforced by CHECK and validated before insert.

**Dedupe:** one report per reporter per item, ever — UNIQUE
`(reporter_account_id, target_item_id)`. Duplicate submits get a friendly
409 "You already reported this item", not an error stack.

**Rate limit:** max 5 reports/hour per reporter via a `RateLimiter` bucket
keyed `reports:acct:<account id>`; 429 + `security_events` row (existing
convention). Scaffold-grade like every existing limiter (single instance).

**Triage notification (step 3, separate PR):** after the INSERT commits, the
server makes one best-effort `POST` to the configured external review
endpoint — title "Board review: item <id> — <reason slug>" (the string the
implementation sends), body: item URL, reason, motivation (truncated),
reporter account id, timestamp. The created task id is stored in
`reports.board_issue_ref`. Failure does NOT fail the user's request and does
NOT lose the report: `board_issue_ref` stays NULL, the failure is logged
(`console.warn`, bounded) and a later backfill can retry NULLs (open
question). At-most-once per report: the UNIQUE dedupe means only a committed
INSERT triggers a create; a failed create is retried only by the explicit
backfill. Config: `REPORT_REVIEW_CREATE_URL`, `REPORT_REVIEW_API_TOKEN`,
`REPORT_REVIEW_ASSIGNEE_ID`, `REPORT_REVIEW_ITEM_URL_TEMPLATE` (public item
URL prefix) — absent URL or token ⇒ notification disabled (rows still land,
ref NULL), never a crash. Timeout 5s; one attempt, no in-process retry.

**State machine (explicit):** `status: open → resolved | dismissed`.
v1 ships only the `open` state (INSERT); `resolved`/`dismissed` are terminal
states set by operator triage later — no transition API in v1. The CHECK
constraint makes illegal values unrepresentable; there is no path that
mutates `status` in v1, so illegal transitions are impossible by
construction. Reopening (resolved → open) is rejected-by-absence: v1 has no
update path at all.

## Data model changes (protected: `db/schema.sql`)

Additive only (expand-contract; no destructive step ever needed):

```sql
CREATE TABLE IF NOT EXISTS reports (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_account_id UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  target_item_id      UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  reason              TEXT NOT NULL CHECK (reason IN ('explicit_images','scam_fraud','other')),
  motivation          TEXT NOT NULL CHECK (char_length(motivation) BETWEEN 10 AND 1000),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  board_issue_ref     TEXT,            -- external triage task ref, NULL until created (step 3)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reporter_account_id, target_item_id)   -- one report per reporter per item
);
CREATE INDEX IF NOT EXISTS reports_target_created_idx
  ON reports (target_item_id, created_at);
```

- `(target_item_id, created_at)` index = the triage read path (all reports
  for an item, newest first).
- `ON DELETE CASCADE` on both FKs: a deleted account/item takes its reports
  with it (privacy posture: reports are operational data, not archives).

## API changes (protected: `src/routes.ts`)

`POST /api/items/:id/report` — JSON `{ reason, motivation }`.

| Outcome | Code | Body |
| --- | --- | --- |
| created | 201 | `{ ok: true, report_id }` |
| not signed in | 401 | `{ error: "Log in to report items." }` |
| invalid reason/motivation | 400 | `{ error: <field-specific message> }` |
| item not found | 404 | `{ error: "Item not found." }` |
| own item | 400 | `{ error: "You can't report your own item." }` |
| already reported | 409 | `{ error: "You already reported this item." }` |
| rate limited | 429 | `{ error: "Too many reports — try again later." }` |

No MCP tool in v1 (reports are a human/moderation flow, not an agent tool;
adding one later is additive). No GET endpoint in v1 (no consumer read path
yet; operators read the table via triage tooling later — open question).

Logic lives in a new `src/reports.ts` (not protected) so `src/routes.ts`
only gains the handler wiring: auth → rate limit → zod validation →
`createItemReport()` → status mapping, mirroring the images route shape.

## Migration plan

Additive `CREATE TABLE IF NOT EXISTS` — zero downtime. Order: merge backend
PR → deploy applies schema (`scripts/migrate.ts` in the runbook) → endpoint
live but unused until the frontend PR ships. No contract step; nothing is
renamed or removed.

## Test plan (`tests/item-reports.test.ts`, DB-backed, skip-guarded)

1. Anonymous → 401.
2. Valid report → 201, row in `reports` with `status='open'`, `board_issue_ref` NULL.
3. Invalid reason slug → 400; motivation 9 chars / 1001 chars → 400.
4. Duplicate (same reporter+item) → 409 friendly message, still exactly one row.
5. Own item → 400; nonexistent item → 404.
6. Rate limit: 6th report within the hour → 429 (fresh account, distinct items).
7. Step 3 (triage notify): token absent ⇒ 201 with ref NULL, no throw;
   mocked review endpoint ⇒ ref stored; notify failure ⇒ 201, ref NULL,
   `security_events` row.

## Rollout + rollback

Rollout: merge → auto-deploy → smoke on thingery.dev (anonymous 401,
signed-in 201, duplicate 409). Rollback: revert the PR; the additive
table can stay (harmless, no reader) or be dropped later — no destructive
step is required to roll back behavior.

## Open questions

1. Notify backfill for NULL `board_issue_ref` (step-3 failures): v1
   keeps a manual psql check; a small sweep is YAGNI until volume says
   otherwise.
2. Triage UI (resolve/dismiss) — deliberately out of scope v1; the state
   machine reserves the states.
3. Report-user-from-profile: only if trivially cheap later.

## PR breakdown (PR-sized steps)

1. `fix(chat)` prompt PR — #275 (independent, not protected).
2. `feat(reports)` schema + `src/reports.ts` + route + tests — this spec
   (protected paths; review requirements per AGENTS.md).
3. `feat(reports)` triage notification seam + config + tests (no protected
   path touched).
4. Frontend modal — private `thingery/platform` repo.
5. Prompt line swap (report button now real) — tiny follow-up to #275.
