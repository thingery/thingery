# ADR 0002: MCP OAuth one-click onboarding

- **Status:** Accepted (spec THI-11 revision 2; security review THI-13 verdict `approve-with-notes`, findings F1–F10 incorporated)
- **Date:** 2026-10
- **Related:** spec THI-11 (revision 2), security review THI-13; implementation PRs #14, #17, #21–#23, #27, #28

## Context

Thingery's MCP server authenticated sellers exclusively with `thg_...` API keys pasted into
client config JSON. That works for power users but is a dead end for the mainstream path:
Claude Desktop, ChatGPT connectors, VS Code and Inspector all support OAuth sign-in against
remote MCP servers (RFC 9728 `resource_metadata` → authorization server discovery), and users
expect "add server → sign in → done". The product principle is free, frictionless listing by
anyone's agent; the manual key copy was the largest friction in that flow.

Constraints that shaped the decision:

- **Self-hosting must stay one container.** Apache-2.0, `npx thingery`, docker compose with
  Postgres + app + Caddy. No new service may be required.
- **Anonymous public reads are a product principle** (`search_items`, `get_item`,
  `describe_category`). Whatever we build must not put auth in front of the whole endpoint.
- **Accounts already exist** (`sellers` with email/password, session cookies). A second
  identity system would be pure cost.
- MCP hosts are **public clients**: no client secrets, arbitrary redirect ports
  (RFC 8252 loopback), dynamic client registration is how they onboard (RFC 7591).
- Blast radius: the npm stdio package, registry-listed installs, and existing `thg_` users
  must keep working unchanged.

## Decision

A **first-party, same-origin OAuth 2.1 authorization server** inside the app (`src/oauth.ts`,
no new dependencies):

- Authorization code + **PKCE S256 only**, single `mcp` scope, 60-second single-use codes
  (rowcount-checked conditional consume — concurrency-safe).
- **Open dynamic client registration**, rate-limited per IP; users' consent screen is the
  human gate for unknown clients.
- **Opaque tokens in the DB, SHA-256 hashed** (`thgo_` access / `thgr_` refresh): 30-minute
  access, 30-day rotating refresh, **family revocation on any replay or theft signature**
  (replayed code, rotated-refresh reuse, wrong-client refresh), RFC 7009 revocation
  (no-oracle always-200).
- **One live grant per (seller, client)**; any revocation ends the whole connection.
- **Method-aware 401 gate on `/mcp`**: no credential → tools decide (anonymous public reads
  work); present-but-invalid credential → `401` with `WWW-Authenticate` challenge +
  `resource_metadata` (never silent downgrade). Anonymous bodies capped at 256 kB before
  parsing; authenticated at 8 MB, parsed once and passed to the SDK's `handleRequest` via
  its `parsedBody` parameter.
- **`thg_` API keys retained indefinitely** as the legacy/manual path and the stdio-package
  credential; `PROTECTED_TOOLS` is enforced identically for both credential kinds, with a CI
  anti-drift test.
- **`OAUTH_DISABLED` kill switch**: OAuth routes unmount (404), `thgo_` becomes an
  unrecognized format (401), hosts fall back to keys.
- Retention sweeps (codes 1 h, access 24 h, refresh 30 d, never-authorized clients 7 d,
  revoked grants 90 d, orphaned clients 180 d) keep the four new tables bounded.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| External IdP (Keycloak, Auth0, …) | +1 service for self-hosters; user accounts live outside the marketplace DB; the AS must mint tokens mapping to `sellers` rows anyway |
| Separate AS microservice | Distribution of a protocol boundary without a need; violates single-container story |
| SDK/framework-based AS | Vendoring a framework for ~6 well-specified endpoints |
| JWT access tokens + JWKS | No revocation win at single-instance scale; key management for nothing; DB lookup already needed for revocation |
| Client secrets / confidential clients | MCP hosts are public clients; PKCE is the designed defense |
| Device authorization grant | No headless-input UX need — hosts have browsers |
| Granular scopes (read/write) | Hosts render nothing per-scope; dead schema at zero benefit |
| Require-auth on all of `/mcp` | Breaks free anonymous public reads — a product principle |
| Sunset `thg_` keys | Churn for npm/stdio users with no security win |
| DCR registration allowlist | Kills one-click for the long tail of hosts; consent is the gate |

## Consequences

- Four new tables (`oauth_clients`, `oauth_codes`, `oauth_grants`, `oauth_tokens`) + hourly
  sweeps; additive migration only (expand-contract respected).
- `/mcp` behavior change (OQ5): a **present-but-invalid** credential now returns `401`
  instead of silently degrading to anonymous. Valid-key users unaffected.
- Future write tools (orders, THI-10) **must register in `PROTECTED_TOOLS`**; the CI
  anti-drift test fails the build when they don't.
- Per-IP rate limits require `trust proxy 1` behind the reverse proxy (F1); self-hosters
  exposing the app directly are unaffected.
- The gate hands pre-parsed bodies to the SDK (`parsedBody`, verified in SDK 1.12) — an SDK
  upgrade that removes that parameter would surface as a type error, not a runtime bypass.
- Multi-instance horizontal scale, if ever needed, can add JWT access tokens additively
  (refresh stays DB-backed); nothing in this decision precludes it.
- Open DCR accepts spam registrations; the 7-day never-authorized sweep and the consent
  screen bound the cost (residual risk documented in spec §5). The THI-214 N1 follow-up
  (THI-220) added a reserved-brand name blocklist at registration (normalized substring
  match: case/whitespace/zero-width/homoglyph fold) and renders the stored `client_uri`
  on the consent page as provenance — escaped text, never a link. Generic lookalike
  brand names remain a documented residual risk: the consent screen is the gate.
