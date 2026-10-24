# ADR-0004: Upgrade zod to v4 and pin body-parser patch releases (2026-10 advisories)

Status: Proposed — awaiting Security review + CEO sign-off (protected-path change: `src/tools.ts`).

## Context

On 2026-10-23/24 two advisories landed that make `npm audit --omit=dev --audit-level=high`
(the CI gate) fail on current `main` and every open PR:

- **GHSA-mrhx-c7xc-m3w5** (high, published 2026-10-01, updated 2026-10-23): zod can
  exhaust memory validating oversized constrained collections. Affected: all versions
  `< 4.6.6`. There is **no v3 patch and none planned** — the only fix is upgrading to
  zod ≥ 4.6.6. zod is our tool-argument and route validation layer
  (`src/tools.ts`, `src/routes.ts` — both protected paths).
- **GHSA-27r3-jxmh-p828** (high, published 2026-10-23): body-parser DoS via trailing
  bytes after a compressed request body. Fixed in 1.20.9 (v1 line) and 2.4.0 (v2 line).
  We carry two copies: express 4 (root, 1.20.8) and express 5 under
  `@modelcontextprotocol/sdk` (2.3.0).

## Decision

1. **zod `^3.24.1` → `^4.6.7`.** The MCP SDK in our lockfile (1.32.x) declares
   `zod: '^3.25 || ^4.0'`, so v4 is a supported configuration upstream. The only source
   change required is the three `z.record(valueSchema)` call sites in `src/tools.ts`,
   which zod 4 requires as `z.record(z.string(), valueSchema)` — JSON object keys are
   always strings, so this is behavior-identical (verified: rendered MCP JSON Schema
   unchanged: `{"type":"object","additionalProperties":{"type":["string","number","boolean"]}}`).
2. **body-parser:** add direct dependency `body-parser@^1.20.9` (dedupes under express 4,
   no override needed) and let the SDK's express 5 resolve `body-parser@2.4.0` within its
   existing `^2.3.0` range via lockfile refresh.
3. No other API or schema changes ride along. Moderates (fast-uri, ip-address) cleared
   incidentally with the lock refresh; no overrides are introduced.

## Alternatives rejected

- **Wait for a v3 backport of the zod fix** — none exists; the advisory's only fixed
  range is ≥ 4.6.6. Waiting leaves CI red and blocks every PR, including docs-only ones.
- **Override/pin zod to a "safe" v3** — no such version exists.
- **Suppress the advisories via `npm audit` exceptions** — hides a validation-layer DoS
  in an internet-facing server; rejected outright.
- **Keeping zod 3 and dropping the audit gate** — the gate is a standing security
  control (docs/security.md); weakening it to ship docs is backwards.

## Consequences

- Validation-layer dependency is a major version newer; we accept the small risk that
  future zod 4.x minors change JSON-Schema rendering. Mitigated by the tool-schema smoke
  check recorded below and the existing MCP test suite in CI.
- `z.record` calls must keep the two-argument form in future tools.
- Rollback is a single revert of this PR (lockfile + 3 lines); zod 3 remains compatible
  with the SDK in the interim.

## Verification (2026-10-24, branch `fix/prod-advisory-deps`)

- `npm audit --omit=dev --audit-level=high` → **0 vulnerabilities** (was 2 high, 2 moderate).
- `npm run typecheck` clean; `npm run build` clean.
- Full vitest suite locally: **identical pass/fail set to clean `main` in the same
  sandbox** (3 pre-existing environment-only failures: local PG user lacks CREATEDB;
  187 passed). CI's service Postgres is the authoritative gate.
- Runtime smoke vs local server: 16 tools listed; `attributes` input schema renders
  unchanged; server boots with all config warnings normal.
