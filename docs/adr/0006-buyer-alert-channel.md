# ADR 0006 — Buyer-alert channel: in-app/MCP-visible match records (pull)

**Status:** Accepted (2026-10-27) · **Related:** THI-360 (spec rev 2, Security review THI-380 APPROVE WITH RIDERS, CEO-accepted 2026-10-27)

## Context

Buyer alerts v1 needs a delivery channel for "new match for your saved intent". Accounts exist (`sellers`), MCP is the primary buyer surface (the product thesis), and Security's review constraint (THI-380) is that V1 adds **no new PII usage and no new delivery infrastructure**. The channel choice is recorded here because it is the decision later PRs inherit: everything downstream (schema, tool copy, retention) assumes pull, not push.

## Decision

**In-app / MCP-visible match records, pulled by the buyer's agent.** Matches are durable `intent_matches` rows; the buyer's agent reads them via the `my_matches` MCP tool (with `mark_read`) at the start of a session. No email, no push infrastructure in V1.

- No new PII: the account email is used for auth only; alert delivery never touches it.
- No delivery surface: no SMTP provider, no secrets on the VPS, no bounce/complaint handling.
- Durable by construction (DB rows) and testable end-to-end purely over MCP.
- Agents are the buyer surface — "receives a notification" means *the buyer's agent can read it on the next session*, stated honestly in tool copy.

## Alternatives rejected

- **Email push** — reaches the human directly, but it is a new PII usage (alerting changes the consent posture of an email stored for accounts), a new delivery surface (SMTP provider, secrets on the VPS, bounce/complaint handling) and a heavy Security-review footprint — blowing the "V1 deliberately small" budget. Revisit as V2 once intent adoption is visible.
- **Both email and in-app now** — strictly more surface than either option alone; everything email adds is deferred, not removed, by choosing pull first.
- **MCP server-push** — the MCP protocol cannot notify a disconnected client; only live sessions could be pushed to, and buyers are rarely connected at publish time. Does not satisfy the requirement.

## Consequences

- Alert latency = the buyer's next agent session. Accepted: it matches how buyers actually use Thingery today, and tool copy tells buyer agents to check at session start ("anything new for my saved searches?").
- The schema and match state machine are channel-agnostic: email later is an additive fan-out step at insert time, not a redesign.
- No notification-deduplication obligations beyond the per-(intent, item) uniqueness already enforced at insert.
