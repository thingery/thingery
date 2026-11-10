# Spec: new-account write ramp — cap account-farming spam

- **Status:** Draft — pending Security design review + CEO acceptance (protected-path policy, repo `AGENTS.md` rule 2 / board THI-36)
- **Date:** 2026-11-10
- **Origin:** [GitHub issue #212](https://github.com/thingery/thingery/issues/212) (fedealconada), tracked as THI-542
- **Touches:** `src/items.ts` (write caps — protected as *rate limits*), tests, this doc. No `db/schema.sql`, `src/tools.ts`, `src/auth.ts`, or `src/routes.ts` change.

## Problem

Per-seller write caps are solid: `MAX_LISTING_CREATES_PER_SELLER_PER_DAY = 100` and
`MAX_ACTIVE_LISTINGS_PER_SELLER = 200` (`src/items.ts:36-37`, docs/security.md §6 H4 fix 1),
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
| 1. Email verification before publishing | **Deferred, not rejected** | Strongest per-account cost signal, but requires building the first outbound-email subsystem in the repo (SMTP/provider config, verify-token lifecycle, resend + expiry, login.html flow) — new operational surface against the ADR 0002 single-container constraint for self-hosters, who would need it default-off. It also puts a human-clicked-link gate in front of *every* new MCP/OAuth agent user's first listing — a direct hit to the frictionless-listing principle — to bound a spam wave the ramp already bounds. Revisit trigger: hosted-instance spam volume measured after the ramp ships; if it lands, ship as opt-in (`SMTP_*` env), expand-contract friendly. |
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
  Implementation shape: parameterize `ListingLimitError` (message + numbers) or add a
  subclass; either way `code` stays `rate_limited`.
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

## Open questions

1. **Image-upload ramp?** During the ramp window a seller can still upload up to the existing
   100 images/day / 200 MB/day. Proposal: leave as-is in v1 (images attach to items the ramp
   already limits to 10 creates/day; the storage quota is per-seller and bounded). Security to
   confirm or ask for a proportional ramp in a follow-up.
2. **Numbers.** 7 d / 10 per day / 20 active — Security owns tuning; the constants live
   next to the existing ones with the same "not env-configurable" posture.
3. **Metrics.** Do we want a `security_event` subtype to distinguish ramp rejections from
   full-cap rejections for abuse monitoring? Proposal: yes, one extra field on the existing
   `listing_write` rejected event (cheap, consistent with THI-112/THI-113 logging); Security
   to confirm.

## Implementation breakdown (PR-sized)

| PR | Contents | Paths |
|---|---|---|
| **A (this PR)** | This spec document | `docs/specs/` only — no protected path |
| **B** | Ramp constants + cap-query extension + parameterized error + security-event distinction + tests; `docs/security.md` §6 H4 note updated with the ramp numbers | `src/items.ts` (protected: rate limits), `src/security-events.ts`, `tests/listing-limits.test.ts`, `docs/security.md` — ~150 lines |

PR B merges only with the Security review verdict and CEO sign-off stated in its description
(board THI-36; repo AGENTS.md rule 2), after CI is green.
