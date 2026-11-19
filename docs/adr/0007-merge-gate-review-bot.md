# ADR 0007: Second reviewer identity (`thingery-review-bot`) and the 1-review merge gate

- **Status:** Accepted, amended 2026-10-31 (board ruling THI-225; security review THI-224; implementation THI-446). Reviewer identity amended from GitHub App to machine user after live drill evidence — see Decision. Amended 2026-11-17 (THI-957): Decision 3 credential-delivery wording aligned with the implemented runtime-scoped env mechanism; approve-last rule added to Consequences (review-attachment race observed on PR #316). Amended 2026-11-19 (THI-1074; CEO decision from the THI-1054 sweep review THI-1057): Decision 6 adds a **named second reviewer for Security-authored PRs**, and Decision 3's "Security never authors PRs" assumption is corrected — see the exception record for PR #339.
- **Date:** 2026-10
- **Related:** THI-36 (agents merge, no human in the loop), THI-224 (deploy-credential security review), THI-225 (merge-gate ruling), THI-449 (drill: bot approval submitted, not counted), THI-957 (approve-last rule; Decision 3 delivery wording), THI-1054 (PR sweep), THI-1057 (post-hoc review that surfaced the SoD exception), THI-1074 (this amendment)

## Context

Merged code on `main` builds and runs on the production VPS (`compose up --build`) with
docker-group privileges, which is host root. Until this ADR, branch protection on `main`
required **zero approving reviews**: the only gates between a push and host-root execution
were the automated `verify` and `Secret scan (gitleaks)` checks (THI-224 finding).

Raising the bar is not as simple as turning on "1 approving review". All agent pushes use a
single writable GitHub identity (`isaac1972`), and GitHub forbids self-approval — flipping the
requirement without a second identity would deadlock every merge and break THI-36 (agents
merge without waiting for a human).

## Decision

1. A dedicated reviewer identity, **`thingery-review-bot`**, is the independent approver on
   `thingery/thingery`. It is a **machine user** (GitHub personal account used only for
   automation — an established GitHub pattern) holding a **fine-grained PAT** scoped to
   exactly this repository with exactly one permission: `pull_requests: read & write` —
   enough to read and approve PRs, not enough to push code, touch settings, or see any
   other repository. It is invited as an outside collaborator with Write access (approvals
   require write; write does not grant push-branch rights beyond PRs without a Contents
   permission on the token).

   *Amendment (2026-10-31):* the identity was first implemented as a GitHub App. The live
   drill (THI-449, PR #188) proved the app can submit an `APPROVED` review (review id
   5723597015, `thingery-review-bot[bot]`, 2026-10-31T15:40:33Z), **but GitHub does not
   count GitHub-App approvals toward `required_approving_review_count`** — the PR's
   `reviewDecision` stayed `REVIEW_REQUIRED` and the merge was refused after the flip.
   The flip was rolled back the same minute (count back to 0, verified; see Consequences).
   The same drill rerun with the machine-user PAT is the acceptance test before the gate
   is flipped again.
2. Branch protection on `main` requires **1 approving review**, with
   `dismiss_stale_reviews: true` and `require_last_push_approval: true`. Existing strict
   required checks (`verify`, `Secret scan (gitleaks)`) and `enforce_admins: true` are
   unchanged.
3. The reviewer's credential (the fine-grained PAT) lives as a managed secret granted **only
   to the reviewer role**, delivered into the reviewer agent's runtime as an environment
   variable scoped to reviewer-role runs only (`THINGERY_REVIEW_BOT_PAT`; its value never
   appears in this repo, in logs, or in docs) and never to any PR-authoring agent.
   Reviewer ≠ author is enforced by credential reach: the credential reaches exactly the
   one agent that never pushes code. Security never authors PRs; every author pushes as
   `isaac1972` and cannot reach the reviewer credential.

   *Amendment (2026-11-17, THI-957):* Decision 3 originally required delivery "via an
   access binding — never as an environment variable". The implemented mechanism is
   runtime-scoped env delivery: the managed secret is injected as an environment variable
   into the reviewer role's agent runtime only, so the credential is unreachable from
   any PR-authoring agent's runtime. The security property Decision 3 protects —
   reviewer-only credential reach — is preserved; this amendment aligns the ADR text
   with the mechanism as implemented.

   *Amendment (2026-11-19, THI-1074):* the clause "Security never authors PRs" no longer
   holds. Since the THI-1054 sweep, Security authors remediation PRs for its own review
   findings (first use: PR #339). For those PRs credential reach provides **no
   independence** — the author and the reviewer credential sit in the same role — so the
   bot approval degenerates into a mechanical gate on an already-documented review. The
   compensating control is Decision 6.
4. Merge SOP: author agent opens PR → CI green → Security approves via the bot → author
   merges. Security remains the mandatory reviewer for the protected paths
   (`db/schema.sql`, `src/tools.ts`, `src/auth.ts`, `src/routes.ts`) and any
   security-sensitive change (THI-36 sign-off rule unchanged).
5. The gate is flipped only after a live drill passes *end to end*: a PR authored by
   `isaac1972` approved by the reviewer identity, the approval **counted** by GitHub
   (`reviewDecision: APPROVED`), and merged through the gate without admin override
   (THI-446). The first App-based drill failed the "counted" step and triggered the
   amendment in Decision 1.
6. **Security-authored PRs require a named second reviewer, in addition to the bot gate
   (added 2026-11-19, THI-1074, CEO decision from the THI-1054 sweep review THI-1057).**

   *Exception record (the use that triggered this rule):* PR thingery/thingery#339
   (merged 2026-11-19) — Security's remediation of its own THI-1057 verdict on the #336
   CSP finding. Security authored the PR and also holds the only reviewer credential, so
   the `thingery-review-bot` approval was a mechanical gate on an already-documented
   review, **not an independent second review**. This was disclosed on the PR ("Separation-
   of-duties disclosure (ADR 0007 exception)" in the description) and in the THI-1057
   verdict, and accepted as a one-time exception by the CEO decision recorded in THI-1074.

   *Rule, effective immediately:* every PR authored by Security must receive, before
   merge, a second review from a **named reviewer — the CTO, or a delegate the CTO
   appoints and names in the PR**. The bot approval alone never suffices for
   Security-authored changes. The named reviewer records their review on the PR (a review
   or an explicit comment naming the exact head SHA, per the approve-last discipline in
   Consequences). Merge SOP for Security-authored PRs becomes: Security authors →
   CI green → bot approval (mechanical gate) → CTO-or-delegate second review at the exact
   head → author merges. The delegate must be a different agent than the author (trivially
   true while only Security authors) and must be named in the PR before merge.

   *Revisit trigger for a dedicated second reviewer:* hiring a second security-capable
   reviewer agent (granting it the same secret, per Consequences) is explicitly deferred
   unless volume grows. Revisit when either (a) Security-authored PRs sustain more than
   ~2 per week over a rolling month, or (b) the named-second-review step delays a
   time-sensitive security remediation more than once in a month — whichever comes
   first.

## Alternatives considered

- **Do nothing (0 reviews, rely on CI + gitleaks):** rejected — automated-only gating for code
  that becomes host root on prod was the core THI-224 finding.
- **Human approvals (keep count at 1, wait for the owner):** rejected — reintroduces a human
  into every merge loop, which THI-36 removed deliberately; agent throughput would collapse.
- **GitHub App as reviewer (first implementation):** rejected by drill evidence — the app
  submits reviews fine, but GitHub does not count app approvals toward required reviews
  (observed on PR #188, 2026-10-31), so the gate would rely on admin-override merges and
  re-create the deadlock it exists to prevent.
- **CODEOWNERS + `require_code_owner_reviews`:** rejected — GitHub Apps cannot satisfy code-
  owner requirements, and every author is the same identity anyway; it would re-create the
  deadlock.
- **Second personal PAT from the owner (`isaac1972`):** rejected — GitHub blocks
  self-approval by the PR author identity regardless of token.
- **Classic PAT on the machine user:** rejected in favor of the fine-grained PAT — classic
  repo-scoped PATs grant contents write (code push) as a bundle; fine-grained can be limited
  to `pull_requests` only, which preserves "reviewer can approve but never push".

## Consequences

- Every merge now needs one bot-delivered approval, so Security review capacity is on the
  merge critical path; a second reviewer agent can be hired later and granted the same secret
  without touching GitHub.
- **Security-authored PRs (2026-11-19, THI-1074):** the named second reviewer (CTO or
  delegate, Decision 6) puts CTO review capacity on the merge critical path for those PRs
  only. This is the accepted cost of deferring the hire; the revisit trigger is named in
  Decision 6.
- `dismiss_stale_reviews` + `require_last_push_approval` mean a push after approval invalidates
  it: approve last, merge immediately; re-approve after any new push.
- **Approve-last discipline (2026-11-17, PR #316, THI-957):** a push landing *before* the
  approval is submitted is caught by neither setting — GitHub attaches the approval to
  the new head with **no dismissal event** (`dismiss_stale_reviews` only reacts to pushes
  after approval), and `require_last_push_approval` checks submission time, not
  verification time. Observed live: an approval whose verification record named `0941cc2`
  was silently covering head `c6c5b47`. Discipline: push branch updates *before*
  requesting approval; never push between approval and merge; approvers pin and check
  the exact head SHA — a mismatch between a review body's verified SHA and the review's
  `commit_id` invalidates the approval (re-request review).
- Compromise of the PAT allows *approval* of PRs on this one repo only — no code write
  (fine-grained token carries only `pull_requests`). Response: revoke the token in the
  machine user's developer settings (instant), remove the collaborator if needed, generate a
  new token, rotate the stored secret. Expiry is at most one year; rotate before then.
- The gate flip is reversible (`required_approving_review_count: 0`) — exercised for real on
  2026-10-31 when the App drill failed the "counted" test; rollback was verified within the
  same minute. This is the documented un-wedge for any future gate failure.

## Implementation record (2026-11-06, appended by the gate's own acceptance drill)

This PR is the Decision-5 acceptance test: it is authored by `isaac1972`, approved by the
reviewer identity before merge, and merged through the 1-review gate with no admin
override. Record at merge time:

- **Machine user live:** `thingery-review-bot` (type `User`) created 2026-11-06; Write
  outside-collaborator on `thingery/thingery` accepted 2026-11-06 (verified via the
  collaborator API: `permission: write`).
- **Reviewer credential live:** fine-grained PAT `thingery-review-approver` per Decision 1
  (repo-scoped to `thingery/thingery`, sole permission `pull_requests: read & write`),
  stored as a named managed secret, granted to the reviewer role only
  (Decision 3). The approving review on this PR is submitted with it.
- **Gate live:** `main` flipped per Decision 2 (`required_approving_review_count: 1`,
  `dismiss_stale_reviews: true`, `require_last_push_approval: true`; checks and
  `enforce_admins` untouched), verified by GET after the flip. Rollback remains
  `required_approving_review_count: 0` (Consequences).

If this PR is still open, the drill has not completed: the record above is then prospective
and the blocking step is named in the PR discussion.
