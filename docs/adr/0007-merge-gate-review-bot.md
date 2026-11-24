# ADR 0007: Second reviewer identity (`thingery-review-bot`) and the 1-review merge gate

- **Status:** Accepted, amended 2026-10-31 (board ruling THI-225; security review THI-224; implementation THI-446). Reviewer identity amended from GitHub App to machine user after live drill evidence — see Decision. Amended 2026-11-17 (THI-957): Decision 3 credential-delivery wording aligned with the implemented runtime-scoped env mechanism; approve-last rule added to Consequences (review-attachment race observed on PR #316). Amended 2026-11-19 (THI-1074; CEO decision from the THI-1054 sweep review THI-1057): Decision 6 adds a **named second reviewer for Security-authored PRs**, and Decision 3's "Security never authors PRs" assumption is corrected — see the exception record for PR #339. Amended 2026-11-21 (THI-836): a Security-owned scheduled sweep re-queues mechanical re-approval for approvals dismissed by a push. Amended 2026-11-24 (THI-1375; security review THI-1377): Decision 6 gains the **proven-pure update-merge carve-out** — a named second review survives a pure update-merge of `origin/main` when the executor sha256-proves the PR patch byte-identical in the PR thread; approve-last and void-on-any-other-push are unchanged (motivating case: PR #375).
- **Date:** 2026-10
- **Related:** THI-36 (agents merge, no human in the loop), THI-224 (deploy-credential security review), THI-225 (merge-gate ruling), THI-449 (drill: bot approval submitted, not counted), THI-957 (approve-last rule; Decision 3 delivery wording), THI-1054 (PR sweep), THI-1057 (post-hoc review that surfaced the SoD exception), THI-1074 (named second reviewer for Security-authored PRs), THI-836 (merge-gate heal sweep), THI-1363 / PR #375 (motivating case for the update-merge carve-out), THI-1372 + THI-1374 (the observed void cycle), THI-1375 (update-merge carve-out amendment; this amendment), THI-1377 (security review of the carve-out: APPROVE, F1–F3 applied)

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

   *Amendment (2026-11-24, THI-1375): proven-pure update-merge carve-out.* Under strict
   "branches must be up to date" protection, every unrelated merge to `main` forces an
   update-merge push on an open PR, and the settings above void the named review each time —
   even though no byte of the PR patch changed (observed twice in one day on PR #375:
   THI-1372 void → THI-1374 re-review, stale on arrival). Rule: a push replacing the
   approved head `H1` with head `H2` does **not** void the named review if and only if the
   executor posts the following evidence in the PR thread and the named reviewer
   **recomputes** all four checks from git before re-attaching the verdict (posted evidence
   is a claim; the reviewer's independent recomputation is the control):

   1. sha256 of `git diff origin/main...HEAD` is identical at `H1` and `H2` — the PR patch
      is byte-identical although its base moved (three-dot diff, so the base shift itself is
      excluded from the digest);
   2. `git diff H1..H2 -- <PR files>` is empty, scoped to the files of the three-dot diff
      (the unscoped two-dot diff between the heads necessarily contains `main`'s own changes
      and is never empty);
   3. `H2` is a merge commit whose parents are exactly [`H1`, `M`], where `M` is the
      then-current `origin/main` tip (verify: `git merge-base --is-ancestor M origin/main`),
      and `git rev-list H2 ^H1 ^M` = {`H2`} — no commit enters `H2` except through `H1` or
      `M`;
   4. required CI checks green and the bot approval present at `H2` (re-queued by the
      THI-836 sweep if the push dismissed it).

   Check 3 deliberately excludes commits reachable from `M`: when `main` advanced via a
   merge commit, the naive `H1..H2` form also lists the commits that merge brought in (they
   are unreachable from `H1`) and would false-reject a genuine pure merge — the explicit
   `--is-ancestor` check additionally blocks a fabricated off-`main` second parent
   (security review THI-1377, attack scenario B).

   On proof, the named reviewer re-attaches the verdict at `H2` — a fresh approval or
   comment naming `H2`, postdating the push, citing the proof evidence — **without
   re-reviewing content**. GitHub's mechanical dismissal still fires on the push; the
   carve-out defines when the verdict transfers without content re-review, not GitHub's
   state. If any check fails, or the push is anything other than a merge of `origin/main`
   (new author commit, amend, squash), the review is void as today and a full re-review is
   required. An update-merge that needed conflict resolution is pure only if checks 1–2
   still hold on the resolved result; a resolution that changed any byte of the PR patch is
   not pure. If `main` advances again before merge, the last re-attached verdict becomes the
   new `H1` and the procedure repeats — the proof digests are invariant to further `main`
   advances as long as `origin/main` does not contain the PR's commits (if histories
   entangle, the merge base shifts, the digests diverge, and the carve-out fails closed to a
   full re-review); merging stays approve-last at the final head. Either
   the reviewer or the author may execute the update-merge (first used on PR #375, where the
   reviewer executed it): executing a proven-pure merge involves no content decision, and
   reviewer-executed sequencing closes the THI-957 attachment race outright because the
   reviewer controls push-then-approve. The executor's push is made with the standard
   writable identity exactly like any author push; the reviewer credential itself
   (`pull_requests`-only, Decision 1) structurally cannot push, so Decision 3's
   reviewer-only credential reach is unchanged. Proof obligations are identical for either executor;
   any push failing proof is a merge-gate violation (incident, reported to the THI-1065
   detection control).

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
  it: approve last, merge immediately; re-approve after any new push — except a proven-pure
  update-merge (Decision 6 carve-out, THI-1375), which re-attaches the existing verdict without
  content re-review.
- **Dismissed-approval heal sweep (2026-11-21, THI-836):** the settings above dismiss the bot
  approval on any push to an approved PR, but nothing re-created the review task, so an approved PR
  could strand at `REVIEW_REQUIRED` until someone noticed (PR #279 stranded ~3 h on 2026-11-15;
  THI-834/835). A **Security-owned scheduled sweep (approximately hourly)** now detects open PRs
  stranded at `REVIEW_REQUIRED` with a dismissed bot review and re-queues the mechanical
  re-approval **only when the PR patch is byte-identical to the dismissed verdict's head** (the
  THI-835 equivalence procedure). Any change to the diff requires full re-review — the sweep never
  mechanically approves a changed diff. The sweep is read-only on GitHub: it never approves and
  never merges. Approval still happens only through the reviewer-role task flow (Decision 3), and
  merging stays with the author. The sweep's equivalence predicate is authorship-agnostic: it
  checks patch byte-identity only, never who executed an update-merge (THI-1375), so it already
  covers reviewer-executed proven-pure update-merges without modification.
- **Update-merge churn (2026-11-24, THI-1375):** strict up-to-date protection plus
  dismiss-on-push means every unrelated `main` advance voids open named reviews even on
  byte-identical patches (twice in one day on PR #375). The Decision-6 carve-out keeps the
  gate's strength — content can never change under a surviving verdict, because checks 1–2 bind
  every byte of the patch — while removing the full re-review loop. GitHub settings are
  unchanged: dismissals still fire mechanically; the carve-out governs the re-attachment SOP,
  not GitHub's state machine.
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

## Amendment evidence (appended 2026-11-24, THI-1375)

Motivating case, recomputed from git on 2026-11-24: PR thingery/thingery#375 (THI-1363,
Security-authored, merged as `c519e7f`). Sequence: the named second review was voided at its
head (THI-1372) → re-review issued at `6c18b68` (THI-1374), already stale on arrival after
unrelated docs-only merges landed on `main` → the reviewer executed the update-merge itself,
producing head `9ba70f5` with parents exactly [`6c18b68`, `4d039e8` (then-`main` tip)],
`git rev-list 6c18b68..9ba70f5` = {`9ba70f5`, `4d039e8`}, sha256 of
`git diff origin/main...HEAD` identical at both heads
(`712b4189b432d30c9cd351fd71381a2b55c897d4870402d90e5ff04618b433f7`), and
`git diff 6c18b68 9ba70f5 -- .dockerignore .gitignore docs/security.md` empty. The literal
`H1..H2` rev-list form sufficed on that day only because both `main` advances were
squash-style single-parent commits — exactly why the rule text uses the shape-agnostic
`H2 ^H1 ^M` form (THI-1377, scenario B). The reviewer approved at `9ba70f5` — the
named-review APPROVE comment of 2026-11-24T14:41:03Z naming `9ba70f5` is the verifiable
approve-last record — and the PR merged through the gate. sha256 of what actually landed on
`main` (`git diff 4d039e8..c519e7f`) equals the proven digest: what landed is byte-for-byte
what was approved. Evidence-hygiene note (THI-1377): the bot approval's API record shows
`submitted_at` 13:52:23Z while attached to `9ba70f5`, a commit created 14:37:23Z — internally
inconsistent GitHub-side bookkeeping, consistent with a dismiss/re-approve path; the merge
passed live `require_last_push_approval` enforcement and the THI-1065 gate-integrity detector
raised no alert, so the named-review comment remains the authoritative approve-last evidence.
Without the carve-out this cycle repeats on every `main` advance; with it, the second
void would have been a mechanical re-attachment.

Open questions from THI-1375, decided here: (1) the THI-836 sweep needs no change — its
re-queue predicate is content-based (the THI-835 byte-identity procedure) and covers
reviewer-executed update-merges unchanged; distinguishing executor identity was rejected
(zero security gain, extra state). (2) Proof automation deferred, not adopted: a CI check can
only attest digests it computes at push time — equality still needs the executor-supplied
pre-push baseline, so automation adds convenience, not trust; the binding control is the
named reviewer's independent recomputation. Revisit when proven-pure update-merges sustain
≥5 per rolling week, or after any disputed or fabricated-evidence incident.

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

## Detection control (appended 2026-11, THI-1065)

The baseline above is enforced by GitHub settings, but owners can flip it off and back on,
so a scheduled detector also watches it: `.github/workflows/gate-integrity.yml` (every
30 minutes and on pushes to `main`) runs `scripts/check-merge-gate.mjs`, which flags merges
to `main` with zero approvals valid at merge time and any drift from the Decision-2 baseline
onto a dedicated `Merge-gate integrity alerts` issue. The incremental window starts at the
last successful workflow run (24h fallback): a `--dry-run` over the default window still
completes successfully, so it advances that watermark without writing findings — anything
found in it will not be re-reported. Use `--from/--to` for previews and backfills; those
windows are non-persisting by definition.
