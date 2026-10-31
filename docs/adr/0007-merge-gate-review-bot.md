# ADR 0007: Second reviewer identity (`thingery-review-bot`) and the 1-review merge gate

- **Status:** Accepted, amended 2026-10-31 (board ruling THI-225; security review THI-224; implementation THI-446). Reviewer identity amended from GitHub App to machine user after live drill evidence — see Decision.
- **Date:** 2026-10
- **Related:** THI-36 (agents merge, no human in the loop), THI-224 (deploy-credential security review), THI-225 (merge-gate ruling), THI-449 (drill: bot approval submitted, not counted)

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
3. The reviewer's credential (the fine-grained PAT) lives as a Paperclip secret granted **only
   to the Security agent** via an API-access binding — never as an environment variable and
   never to any PR-authoring agent. Reviewer ≠ author is enforced by credential reach: the
   credential reaches exactly the one agent that never pushes code. Security never authors
   PRs; every author pushes as `isaac1972` and cannot reach the reviewer credential.
4. Merge SOP: author agent opens PR → CI green → Security approves via the bot → author
   merges. Security remains the mandatory reviewer for the protected paths
   (`db/schema.sql`, `src/tools.ts`, `src/auth.ts`, `src/routes.ts`) and any
   security-sensitive change (THI-36 sign-off rule unchanged).
5. The gate is flipped only after a live drill passes *end to end*: a PR authored by
   `isaac1972` approved by the reviewer identity, the approval **counted** by GitHub
   (`reviewDecision: APPROVED`), and merged through the gate without admin override
   (THI-446). The first App-based drill failed the "counted" step and triggered the
   amendment in Decision 1.

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
- `dismiss_stale_reviews` + `require_last_push_approval` mean a push after approval invalidates
  it: approve last, merge immediately; re-approve after any new push.
- Compromise of the PAT allows *approval* of PRs on this one repo only — no code write
  (fine-grained token carries only `pull_requests`). Response: revoke the token in the
  machine user's developer settings (instant), remove the collaborator if needed, generate a
  new token, rotate the Paperclip secret. Expiry is at most one year; rotate before then.
- The gate flip is reversible (`required_approving_review_count: 0`) — exercised for real on
  2026-10-31 when the App drill failed the "counted" test; rollback was verified within the
  same minute. This is the documented un-wedge for any future gate failure.
