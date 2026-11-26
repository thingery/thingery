# Spec: bind webhook-secret verification to event classes

Status: proposed (Architecture). Touches protected path `src/webhooks-stripe.ts` —
implementation requires the merge-gate: Security review and CEO sign-off stated on
the PR before merge.

## Problem

The Stripe webhook handler accepts an event when **any** configured signing secret
verifies it: platform current, Connect current, then the two `_PREVIOUS` rotation
twins, in a fixed order (shipped in the Connect-onboarding change, PR #402). There
is no coupling between *which* secret verified an event and *which class* of event
it is. Consequence: the Connect endpoint secret alone can verify a forged
`checkout.session.completed` or `payment_intent.succeeded` payload, and the handler
would act on it (mark an order sold, set a payment intent). The two secrets protect
different surfaces — the Connect secret is exposed through a second webhook endpoint
with a wider operational blast radius (rotated on its own schedule, visible to more
runbook steps) — so compromise of the lower-value secret must not escalate into
payment forgery. Security flagged this as residual risk (LOW) in the PR #402 review;
this spec removes the class of risk rather than accepting it.

## Context

- Deployment registers **two** Stripe webhook endpoints (deploy runbook §5.3):
  - platform-account endpoint → `checkout.session.completed`, `payment_intent.succeeded`,
    `charge.refunded`, `transfer.*`, `charge.dispute.*`, `account.updated`;
  - Connected-accounts endpoint → `account.updated` (the only writer of
    `sellers.stripe_onboarded_at`).
- Stripe marks connected-account events with a top-level `account` field (the
  connected `acct_…` id); platform-account events carry none. The payload itself
  therefore names its class — usable **after** signature verification, which is the
  only moment the handler can trust it.
- Handler protocol is verify → store → process → mark (webhook idempotency lens);
  bad verification returns 400 and **never writes** (F12). Rotation twins (F13)
  must keep working zero-downtime.

## Proposed design

Bind each secret **family** to one event class; a mismatch is treated exactly like
a signature failure (400, nothing written, distinct log line):

| Secret family | May verify |
|---|---|
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET_PREVIOUS` | platform-class events: `event.account` unset |
| `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET_PREVIOUS` | connect-class events: `event.account` set to a non-empty `acct_…` string |

- In the candidate loop (webhooks-stripe.ts, "try each configured secret"), after
  `constructEvent` succeeds, derive `connectScoped = typeof event.account ===
  "string" && event.account.startsWith("acct_")` and
  `connectFamily = name.startsWith("STRIPE_CONNECT_")`. On mismatch: do **not**
  accept the candidate, log `[webhooks:stripe] class violation: <secret-name>
  verified a <connect|platform>-scoped event <event.type>` and abort with 400
  (no store, no `onEventId`), matching F12. Continue-the-loop is wrong here: HMAC
  verification under one key cannot also verify under another, so a first success
  plus mismatch means the event is policy-invalid, not "awaiting its real secret".
- Rotation keeps working: twins inherit their family's binding; the accept order is
  unchanged.
- Misrouting fails loud: if Connect-scoped deliveries were pointed at the platform
  endpoint, signatures still verify (same secret family? no — different endpoint,
  different secret) — actually a misroute fails signature verification as today;
  the new rejection only fires for **forged** payloads, which is the point.
- Redacted ingest payload (F6) gains one additive field `account_scope:
  "connect" | "platform"` for observability of what was accepted.
- Unchanged: livemode gate, dedupe by `external_id`, transition machinery, 503
  fail-closed stub, single-secret deployments (unset Connect secret ⇒ platform
  family only).

## Data model changes

None. (`webhook_events` rows gain one more redacted payload key; schema untouched.)

## API / MCP tool changes

None. External contract with Stripe is unchanged: same endpoints, same 2xx/4xx
semantics. Rejection of forged events is not an API change — those events were
never legitimate.

## Migration plan

None (expand-contract n/a: no schema or config change; deploy = code only).

## Test plan (tests/stripe-webhook.test.ts)

1. **Regression:** platform-class event (e.g. `checkout.session.completed`) signed
   with platform secret → processed as today.
2. **Regression:** connect-class `account.updated` (payload `account` set) signed
   with Connect secret → flips `stripe_onboarded_at` as today.
3. **The fix:** platform-class event signed with Connect secret → 400, no
   `webhook_events` row, no order change, log line present.
4. **The fix, mirrored:** connect-class event signed with platform secret → 400,
   nothing written.
5. **Rotation:** platform-class signed with `…_PREVIOUS` twin → accepted (warning
   logged); connect-class signed with connect `_PREVIOUS` → accepted; platform-class
   signed with connect `_PREVIOUS` → 400.
6. **Single-secret deployment:** Connect secret unset → platform behavior identical
   to pre-#402.
7. **Redaction:** accepted connect event stores `account_scope: "connect"` and no
   PII beyond the existing F6 keys.

## Rollout + rollback

- Rollout: normal feature branch + PR + green CI; deploy with the standard build.
  The change only **rejects** events, so it cannot widen acceptance mid-rollout;
  the only operational risk is over-rejection, covered by tests 1–2 and the
  rehearsal step below.
- Rehearsal (docs/stripe-live-rehearsal.md): add one step — complete a test-mode
  Connect onboarding and assert `stripe_onboarded_at` flips **with the binding
  live**; assert a tampered payload (flip `account` off a connect event) 400s.
- Rollback: revert the commit; no data or config residue.

## Open questions

1. Should a class violation ALSO invalidate the event id against future deliveries
   (attacker could replay a forged id that matches a future real event)? Current
   dedupe keys on `(source, external_id)`; forged events are never stored, so they
   cannot pre-burn ids. No action needed; noted for the reviewer.
2. Accept `acct_` prefix check or bare non-empty `account`? Bare non-empty is more
   permissive across SDK versions; prefix check is stricter. Proposed: bare
   non-empty (Stripe owns the field), prefix as the log detail only. Security to
   pick.

## PR-sized implementation steps

Single PR, well under the size bar:
1. Binding check + log line inside the candidate loop (webhooks-stripe.ts, ~15 lines).
2. `account_scope` key in the redacted payload (webhooks-stripe.ts, ~2 lines).
3. Test cases 1–7 (tests/stripe-webhook.test.ts).
4. Runbook + rehearsal step updates (docs/deploy-vps.md §5.3 note,
   docs/stripe-live-rehearsal.md step).
