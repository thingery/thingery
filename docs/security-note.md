# Security & architecture note

Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.

This note says what is **verified** about Thingery's security today and — just as important — what is **not**. We would rather over-disclose limitations than let a reader assume a guarantee we have not made. It accompanies [`SECURITY.md`](../SECURITY.md) (how to report issues) and [`docs/security.md`](security.md) (the threat model and hardening backlog).

_Last reviewed: 2026-10-27, against the then-current `main` and the production deployment at [thingery.dev](https://thingery.dev)._

## Architecture in brief

A single Express application serves the web app, the REST API under `/api`, and the Model Context Protocol endpoint at [`/mcp`](https://thingery.dev/mcp) (Streamable HTTP). State lives in PostgreSQL with pgvector for embedding search. Caddy terminates TLS 1.2+ in front. The same code ships as the [`thingery`](https://www.npmjs.com/package/thingery) npm package for self-hosting (stdio MCP + optional HTTP). No third-party services sit in the request path.

## What we have verified

These were checked directly against the code on `main` and the live service — not assumed from configuration.

**Authentication.** Two credential types, both authenticated before any write: OAuth 2.0 clients (authorization-code flow with PKCE S256, public clients, no client secrets) and personal API keys (`thg_…`). API keys are stored only as SHA-256 hashes — the plaintext is shown once at creation and never again. Passwords use scrypt. Web sessions are HMAC-signed cookies with server-side expiry and per-account revocation. Anonymous MCP access is read-only public data; every write tool requires a seller identity (401 otherwise).

**Data separation.** Listing content is public by design. Order shipping addresses and counterparty identifiers are stripped from any public or counterparty-facing payload. API keys never appear in `/api/me` or logs.

**Abuse controls.** Per-surface rate limits: 120 req/min per authenticated seller and 30 req/min per anonymous IP on `/mcp`; 10 signups+logins/hour per IP; upload endpoints gated pre-authentication; per-account caps on listing velocity and stored buyer intents. Rate-limit trips are logged as security events.

**Operational integrity.** Nightly backups are encrypted client-side with the [`age`](https://age-encryption.org) tool (public key pinned in the deployment doc) and verified by atomic-rename and size-floor checks. The restore procedure is documented end-to-end and drilled on a monthly cadence — most recently 2026-10-14 (history in [`docs/deploy-vps.md`](deploy-vps.md) §4). Secret scanning (gitleaks) and `npm audit` run in CI on every pull request.

**Supply chain & inspectability.** The npm package ships no dev files or secrets in the tarball; production audits report **0 known vulnerabilities**. Independent tool scanners can inspect the full MCP surface without credentials: `tools/list` responds anonymously, and both OAuth discovery endpoints (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`) publish accurate metadata. Security headers (CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`) are set on all responses.

## What we have NOT verified — known limitations

Read this list before trusting Thingery with anything sensitive.

- **No third-party audit.** Everything above is internal review by our security role. No external pentest or audit has been performed.
- **No email verification.** Accounts require only a password; throwaway identities are possible today. Velocity caps bound the abuse, not the identity.
- **Backups live on the host.** Nightly backups are encrypted, but currently stored on the same VPS as the service. An offsite copy is scheduled, not yet deployed.
- **In-memory rate limiting.** Limits are per-process (single instance today); a multi-instance deployment would need shared state.
- **External image URLs.** Listings may reference third-party image URLs; viewing them can disclose your IP to that host. We recommend image hosts you trust.
- **CSP allows inline styles** (`style-src 'unsafe-inline'`) — cosmetic risk, but not strict CSP.
- **npm/hosted feature drift.** The npm package (0.1.2, 16 tools) lags the hosted endpoint (20 tools incl. buyer intents); [releases](https://github.com/thingery/thingery/releases) track the delta.

## Reporting security issues

Please report privately — see [`SECURITY.md`](../SECURITY.md). GitHub **private vulnerability reporting** is enabled on the repository; we acknowledge within 72 hours and triage within 7 days. Do not open public issues for unpatched vulnerabilities.

## Self-hosting

Self-hosters inherit everything above that is code, and everything in [`docs/security.md`](security.md) §4 that is configuration: set `SESSION_SECRET`, keep the admin route disabled unless needed, run behind TLS, and follow the backup procedure in [`docs/deploy-vps.md`](deploy-vps.md) §4.
