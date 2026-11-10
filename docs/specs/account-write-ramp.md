# Spec: new-account write ramp — cap account-farming spam

- **Status:** Approved for implementation — Security design review verdict **APPROVE WITH NOTES** (THI-543, 2026-11-10), CEO acceptance **ACCEPTED** (THI-544, 2026-11-10). Both verdicts are quoted in the implementation PR's description per protected-path policy (board THI-36 / repo `AGENTS.md` rule 2).
- **Date:** 2026-11-10 (revised same day after the Security review notes)
- **Origin:** [GitHub issue #212](https://github.com/thingery/thingery/issues/212) (fedealconada), tracked as THI-542
- **Touches:** `src/items.ts` (write caps — protected as *rate limits*), tests, this doc. No `db/schema.sql`, `src/tools.ts`, `src/auth.ts`, or `src/routes.ts` change.

## Problem

Per-account write caps are solid: `MAX_LISTING_CREATES_PER_SELLER_PER_DAY = 100` and
`MAX_ACTIVE_LISTINGS_PER_SELLER = 200` (`src/items.ts:37-38`, docs/security.md §6 H4 fix 1),
per-seller image quotas (`src/images.ts:75-76`), and ownership checks on every mutation. But
creating an account is cheap: `/api/signup` takes only email + password, and the only throttle
is `authAttemptLimiter` — 10 signups+logins per IP per hour (`src/routes.ts:74-75`). Per-account
caps therefore do not bound total write volume: N farmed accounts × 100 listings/day, each
listing costing an embeddings-API call and public search surface. docs/security.md already
flags this class (API6 "Sensitive Business Flows: signup and listing-creation flows have no
abuse controls beyond IP limits → H4"; API2 lists "no email verification" as a gap).

## Context

- **No outbound email subsystem exists.** No SMTP client, no provider integration, no mail
  tests. The repo has never sent an email.
- **ADR 0002 constraints still bind:** self-hosting stays one container (`npx thingery`,
  compose: Postgres + app + Caddy, no new required service), and "free, frictionless listing
  by anyone's agent" is the stated product principle.
- **All account creation funnels through `/api/signup`** (email + password). MCP OAuth
  onboarding (ADR 0002) requires an existing logged-in session at `/oauth/authorize`; ChatGPT
  connect binds to a session too. So email verification would fall on every new account —
  including the human behind a fresh MCP/OAuth user whose agent is ready to list.
- **Cap enforcement point:** `createItem` runs one indexed COUNT over `items` covering both
  caps, deliberately *before* the embeddings call (the cost-DoS ordering, §6 H4). Every
  listing-creating surface goes through `createItem` — `create_listing` and
  `respond_to_wanted` (THI-439 response loop writes a listing on the caller's behalf).
  `update_listing` creates no rows; image uploads have their own per-seller daily quota.
- **Existing caps are deliberately not env-configurable** (`src/items.ts:33-35` comment):
  module constants, one place, Security owns the numbers.

## Options considered (issue #212 proposals)

| Option | Verdict | Rationale |
|---|---|---|
| **3. Lower caps for new accounts** (age-based ramp) | **Chosen for v1** | Zero new infrastructure; pure server-side; identical behavior on hosted and every self-hosted instance (no new config, no SMTP, no third party); directly bounds the farming economics; no schema change (uses existing `sellers.created_at`); no UX change beyond slower start; reversible by revert. |
| 1. Email verification before publishing | **Deferred, not rejected** | Strongest per-account cost signal, but requires building the first outbound-email subsystem in the repo (SMTP/provider config, verify-token lifecycle, resend + expiry, login.html flow) — new operational surface against the ADR 0002 single-container constraint for self-hosters, who would need it default-off. It also puts a human-clicked-link gate in front of *every* new MCP/OAuth agent user's first listing — a direct hit to the frictionless-listing principle — to bound a spam wave the ramp already bounds. **Revisit trigger (measurable, per Security review THI-543):** sustained `new_seller_ramp` limit rejections (the Q3 event field below) across ≥10 distinct sellers for ≥7 consecutive days on the hosted instance, **or** any single spam incident that defeats the ramp via aged accounts. When revisited it ships as opt-in (`SMTP_*` env, default off for self-hosters, hosted-instance enforcement only) plus a disposable-domain blocklist — expand-contract friendly. |
| 2. Signup challenge (Turnstile/hCaptcha) | **Rejected for now** | Adds a third-party dependency + account (site key/secret), is cheap to bypass at abuse scale (solver services), protects only the hosted instance (self-hosters would disable it), and bounds nothing once bypassed — it does not cap writes. The ramp caps writes regardless of how the accounts were created. |
| Tighter `authAttemptLimiter` on signup | Rejected | The limiter is shared with login; tightening it punishes legitimate sign-in and is trivially rotated around via IPs. Non-goal. |

## Proposed design

**A time-based write ramp on new sellers, enforced at the existing cap checkpoint in
`createItem`.**

- `NEW_SELLER_RAMP_DAYS = 7` — sellers whose `sellers.created_at` is younger than 7 days are
  in the ramp.
- While in the ramp: `NEW_SELLER_MAX_LISTING_CREATES_PER_DAY = 10` and
  `NEW_SELLER_MAX_ACTIVE_LISTINGS = 20`. After 7 days the existing caps (100/day, 200 active)
  apply unchanged. Security owns the final numbers — these are the proposal.
- Enforcement: the existing cap COUNT query in `createItem` additionally fetches the seller's
  `created_at` (same single round trip — subselect/join on `sellers`), the effective caps are
  computed in TypeScript, and the comparison proceeds exactly as today. Ordering is preserved:
  ramp check runs **before** `embedText`, so an over-ramp create never reaches the embeddings
  API (cost-DoS ordering, §6 H4).
- Rejection: same typed error as today — `code: "rate_limited"` (the THI-113 documented
  choice; agents already treat it as back-off-and-retry-later) — with a distinct message that
  names the ramp and says full limits unlock automatically after 7 days, e.g.
  `"New-account limit reached (max 10 creates/day, 20 active during your first 7 days). Full limits unlock automatically after 7 days."`
  Implementation shape: parameterize `ListingLimitError` (message + numbers interpolated from
  the constants — never a hardcoded string that can drift from the numbers, per THI-543 Q2);
  `code` stays `rate_limited` either way.
- Observability (THI-543 Q4, exact shape confirmed): add an optional field to the
  `listing_write` member of the security-event union only — do **not** extend
  `SecurityEventReason` (repo precedent: separate unions per event family):
  `limit?: "new_seller_ramp" | "seller_cap"`, mirroring the `wanted_response.count?`
  precedent. The cap checkpoint in `createItem` sets it on **both** rejection classes
  (`new_seller_ramp` = ramp rejection, `seller_cap` = full-cap rejection); it is absent for
  validation rejections — three states, no null-handling ambiguity in monitoring queries.
- Coverage: `create_listing` and `respond_to_wanted` (both go through `createItem`).
  `update_listing`, order tools, and intent tools are unaffected (no listing creation).
  Image-upload quotas are unchanged in v1 (see Open questions).

**State machine (explicit):** seller account has two write-limit regimes, `ramped` and
`full`. Transition `ramped → full` is time-based (`created_at + 7 days < now()`), evaluated
per call, no stored state, no illegal transition, no backfill. There is no `full → ramped`
transition. Time-based means: no column to add, nothing to migrate, nothing that can drift.

## Data model changes

**None.** The ramp is computed from the existing `sellers.created_at`. No
`verified_at` or other column is added (that was the issue's option-1 sketch; option 3 needs
nothing).

## API / MCP tool changes

**None to signatures** (API evolution: signatures and JSONB schemas unchanged). `create_listing`
and `respond_to_wanted` can additionally return the existing typed `rate_limited` error
earlier in an account's life, with ramp-specific message text. Agents key off the error code,
which is unchanged. No new tool, no `PROTECTED_TOOLS` change (all listing-creating tools are
already in the set).

## Migration plan

Code-only. **Grandfathering answered:** the regime is derived from account age at call time —
every account older than 7 days at deploy is automatically `full` (unaffected); accounts
younger than 7 days at deploy enter the ramp (intended: that cohort is the risk cohort).
Expand-contract: the change is additive behavior with no destructive step, no backfill, no
contract phase.

## Test plan

Extend `tests/listing-limits.test.ts` (its DB-backed part skips without Postgres, as today):

1. Ramp enforcement: a seller created now hits `ListingLimitError` at the 10th create/24 h and
   the message names the ramp and the 7-day unlock.
2. Active-cap enforcement during ramp (≤ 20 active).
3. Boundary: seller created 6 d 23 h ago → ramped; 7 d 1 h ago → full caps (can create past
   the ramp numbers).
4. No regression: a >7-day-old seller keeps the 100/200 caps (existing tests already pin this).
5. Error-class contract: `code === "rate_limited"` for the ramp rejection, same as today.

DB fixture note: the ramp tests need a seller row with a controlled `created_at` — insert via
SQL with an explicit timestamp (the suite already creates schema/fixtures directly).

## Rollout + rollback

- Rollout: merge → next normal deploy (no coordinated steps, no config, no operator action for
  self-hosters beyond upgrading). thingery.dev and self-hosted instances get identical
  behavior.
- Rollback: revert the commit and redeploy. No data written by the feature (it reads
  `created_at`, writes nothing), so rollback is clean.
- Blast radius: (a) brand-new sellers — hosted, self-hosted, and via MCP OAuth alike — can
  create at most 10 listings/day and hold 20 active during their first 7 days (intended);
  a legitimate bulk onboarding on a fresh account is slowed for a week — the error message
  says so explicitly; (b) npm package / stdio users: server-side only, no client change;
  (c) existing sessions and keys: unaffected.

## Resolved questions (verdicts from the Security review THI-543, 2026-11-10; CEO conditions from THI-544)

1. **Image-upload ramp — unchanged in v1, follow-up filed.** Search-visible image spam is
   bounded by the item ramp (uploads attach to an owned item, 12/item). Stated residual: a
   day-1 ramped account already has 10 items × 12 slots = 120 ≥ the 100/day quota, so the
   existing per-seller quotas (100 uploads/day, 200 MB/day) remain fully available per farmed
   account — a pre-existing, per-seller + per-IP bounded surface, not made worse by this
   change. Follow-up ticket (filed with PR B): proportional image ramp — 20 uploads/day,
   40 MB/day while `ramped` — triggered by the same hosted telemetry as the option-1 revisit
   trigger, not preemptively.
2. **Numbers — confirmed:** `NEW_SELLER_RAMP_DAYS = 7`,
   `NEW_SELLER_MAX_LISTING_CREATES_PER_DAY = 10`, `NEW_SELLER_MAX_ACTIVE_LISTINGS = 20`.
   Constants stay module-level, deliberately not env-configurable (existing posture,
   `src/items.ts` / `src/images.ts`).
3. **Observability — confirmed**, exact field shape in the design section above
   (`limit?: "new_seller_ramp" | "seller_cap"` on `listing_write` only).

Residual risks recorded for `docs/security.md` §6 H4 (from THI-543): (a) aged-account
patience — a farmer willing to wait 7 days per account gets full caps; the `limit` telemetry
is the detector, progressive ramp / reputation is the follow-up lever, not now; (b)
proxy-rotated farming is only IP-rate-limited — the ramp is what makes each account
expensive; (c) signup 409 email enumeration remains an open API2 item, out of scope here.

## Implementation breakdown (PR-sized)

| PR | Contents | Paths |
|---|---|---|
| **A (this PR)** | This spec document | `docs/specs/` only — no protected path |
| **B** | Ramp constants + cap-query extension + parameterized error + `limit` field on the `listing_write` security event (both rejection classes) + tests; `docs/security.md` §6 H4 note updated with the ramp numbers and residuals | `src/items.ts` (protected: rate limits), `src/security-events.ts`, `tests/listing-limits.test.ts`, `docs/security.md` — ~150 lines |

PR B merges only with the Security review verdict and CEO sign-off stated in its description
(board THI-36; repo AGENTS.md rule 2), after CI is green.
