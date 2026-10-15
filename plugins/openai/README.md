# OpenAI plugin package — Thingery ([THI-218](https://github.com/thingery/thingery))

Submission package for the ChatGPT connector directory: Thingery's MCP server
`https://thingery.dev/mcp` (parent THI-212). Drafted against repo baseline
`63b499c` (review baseline `6be661e` or newer) — tool surface: 3 public reads
+ 13 OAuth-protected tools.

## Contents

| Path              | What                                                     | State |
| ----------------- | -------------------------------------------------------- | ----- |
| `plugin.json`     | Agent Plugins 1.0.0 root manifest (OpenAI extension: listing, review, publication) | draft — pending inputs marked `PENDING(...)` |
| `mcp.json`        | MCP server declaration (streamable-http)                 | **final** |
| `assets/`         | Icons (composer + logo)                                  | pending THI-217 |
| `docs/test-cases.md` | 5 positive / 3 negative review cases (detailed, grounded in `src/`) | **final** (mirrored in `plugin.json`) |
| `validate.mjs`    | Local validation dry run (schemas + submission rules)    | final |
| `build-zip.sh`    | Builds the submission ZIP (refuses while validation is not clean) | final |
| `schemas/`        | Vendored Agent Plugins 1.0.0 JSON schemas (repo-only, not in the ZIP) | final |

## Authentication (no credentials in the package)

`mcp.json` declares only the server URL. OAuth 2.1 is discovered from
`https://thingery.dev/.well-known/oauth-authorization-server`
(Authorization Server metadata, ADR 0002): authorization, token and
**registration endpoints** are advertised, so the portal's connector flow uses
open **Dynamic Client Registration** (RFC 7591) with PKCE S256 public clients
— exactly the "dcr" registration method in OpenAI's submission docs. Client
secrets are never needed and never belong in the package.

## Validation dry run

```sh
node plugins/openai/validate.mjs
```

- exit `0` — submission-ready
- exit `2` — only blocker-tracked inputs outstanding (expected until THI-216
  and THI-217 resolve)
- exit `1` — hard failures to fix

Checks: vendored Agent Plugins schemas (ajv, draft 2020-12), OpenAI field
limits (displayName ≤ 30, shortDescription ≤ 30, longDescription ≤ 4000, …),
the four MCP-review-required HTTPS URLs, exactly 5 positive / 3 negative test
cases with all required per-case fields, commerce declaration, referenced
icon files (present, PNG, square, ≥ 48 px, ≤ 5 MiB), and rejection of
forbidden package content (`clientSecret`, `test_credentials`,
`reviewer_instructions`, nonempty server headers).

## Build the ZIP

```sh
plugins/openai/build-zip.sh   # → thingery-openai-plugin.zip
```

Stages `plugin.json`, `mcp.json` and every manifest-referenced asset. Refuses
to run while validation is not clean.

## Outstanding inputs before finalization

| Input                     | Owner                | Tracker |
| ------------------------- | -------------------- | ------- |
| Directory copy, tagline, brand color, icons | THI-217 (board approval gate) | `PENDING(THI-217)` in `plugin.json` |
| Privacy policy live at `https://thingery.dev/privacy` | THI-216 (board approval gate) | `PENDING(THI-216)` |
| Terms of service URL — **required for MCP review, no page exists and no issue covers it** | board / CTO | `PENDING(gap)` — escalate |
| Support URL — required for MCP review | board / CTO | `PENDING(gap)` — escalate |
| Demo recording URL — required for MCP review | board (Phase 5) | `PENDING(gap)` |
| Reviewer test account (seller + buyer, no MFA) — entered in the portal, never in the ZIP | board (Phase 5) | noted in `docs/test-cases.md` |
| Category + country availability | board (Phase 5) | `PENDING(board)` |

Portal-side items for the submission phase (not package content): developer
identity verification, domain verification challenge token at
`/.well-known/openai-apps-challenge`, reviewer credentials entry.
