# ADR 0007: Second reviewer identity (`thingery-review-bot`) and the 1-review merge gate

- **Status:** Accepted (board ruling THI-225; security review THI-224; implementation THI-446)
- **Date:** 2026-10
- **Related:** THI-36 (agents merge, no human in the loop), THI-224 (deploy-credential security review), THI-225 (merge-gate ruling)

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

1. A dedicated GitHub App, **`thingery-review-bot`** (org `thingery`, installed only on
   `thingery/thingery`), is the independent reviewer identity. It holds exactly one permission:
   `pull_requests: read & write` — enough to read and approve PRs, not enough to push code,
   touch settings, or see any other repository.
2. Branch protection on `main` requires **1 approving review**, with
   `dismiss_stale_reviews: true` and `require_last_push_approval: true`. Existing strict
   required checks (`verify`, `Secret scan (gitleaks)`) and `enforce_admins: true` are
   unchanged.
3. The bot's credentials (App ID + private key) live as Paperclip secrets granted **only to
   the Security agent** via API-access bindings — never as environment variables and never to
   any PR-authoring agent. Reviewer ≠ author is enforced by credential reach: the credential
   reaches exactly the one agent that never pushes code. Security never authors PRs; every
   author pushes as `isaac1972` and cannot reach the bot credential.
4. Merge SOP: author agent opens PR → CI green → Security approves via the bot → author
   merges. Security remains the mandatory reviewer for the protected paths
   (`db/schema.sql`, `src/tools.ts`, `src/auth.ts`, `src/routes.ts`) and any
   security-sensitive change (THI-36 sign-off rule unchanged).
5. The gate was flipped only after a live drill: a PR authored by `isaac1972` approved by
   `thingery-review-bot`, approval verified to stick (THI-446).

## Alternatives considered

- **Do nothing (0 reviews, rely on CI + gitleaks):** rejected — automated-only gating for code
  that becomes host root on prod was the core THI-224 finding.
- **Human approvals (keep count at 1, wait for the owner):** rejected — reintroduces a human
  into every merge loop, which THI-36 removed deliberately; agent throughput would collapse.
- **CODEOWNERS + `require_code_owner_reviews`:** rejected — GitHub Apps cannot satisfy code-
  owner requirements, and every author is the same identity anyway; it would re-create the
  deadlock.
- **A second human PAT for approvals:** rejected — PATs are personal, unscopable beyond repo
  granularity, non-revocable per-installation, and would live in an agent transcript at least
  once; a GitHub App is narrowly permissioned and instantly revocable (delete the key).

## Consequences

- Every merge now needs one bot-delivered approval, so Security review capacity is on the
  merge critical path; a second reviewer agent can be hired later and granted the same secret
  without touching GitHub.
- `dismiss_stale_reviews` + `require_last_push_approval` mean a push after approval invalidates
  it: approve last, merge immediately; re-approve after any new push.
- Compromise of the private key allows *approval* of PRs on this one repo only — no code write.
  Response: delete the key in the App settings (instant revocation), generate a new one,
  rotate the Paperclip secret.
- The flip is reversible (`required_approving_review_count: 0`) if the gate ever wedges all
  merges; that is the documented rollback.
