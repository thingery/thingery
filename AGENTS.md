# Agent Team Conventions

This repo is built by a team of AI agents (orchestrated via Paperclip or equivalent).
Merging and deploying are agent-owned: **there is no human approval step anywhere in the
merge-to-deploy path** (board rules THI-36 and THI-705). Every agent working here follows
these rules.

## Golden rules

1. **Agents merge and deploy with no human intervention (THI-36, THI-705).** Never push
   directly to `main`. Work happens on feature branches → pull request → CI green → required
   review → the author agent merges. The independent approver is `thingery-review-bot`,
   operated by Security (ADR 0007). Deploys and their documented runbook steps (migrations,
   rollbacks, rebuilds) also run on agent authority; destructive production actions outside
   a documented runbook still require explicit human approval, and Security keeps its release
   veto.
2. **Load-bearing changes need agent sign-off stated in the PR description** — Security
   review plus CEO sign-off (THI-36): anything touching `db/schema.sql`, the MCP tool
   signatures in `src/tools.ts`, auth, rate limits, payments, or CI itself. Everything else
   (docs, website, tests, internal refactors) is mergeable once CI is green and reviewed.
3. **Credentials never enter the repo.** No tokens, no `.env` files, no secrets in code,
   logs, or PR descriptions. Use `.env.example` placeholders only.
4. **Small, verifiable tasks.** One PR = one purpose. If a task needs > ~300 changed lines,
   split it and say so in the issue.

## Engineering standards

- TypeScript strict mode; no `any` without a comment justifying it.
- Every new code path in `src/` ships with a test in `tests/` where testable without a live
  database (DB-dependent behavior is exercised by the seed script + manual smoke test notes
  in the PR).
- `npm run typecheck` and `npm run test` must pass locally before you open a PR.
- Match the existing style: ESM, `node:` builtins, double quotes, named exports.
- SQL always goes through parameterized queries in `src/items.ts` / `src/db.ts`.
  Never string-concatenate user input into SQL.
- Async Express route handlers must be wrapped in `asyncHandler` (or fully internally
  try/caught) — Express 4 does not route rejected promises to error middleware, and an
  unhandled rejection terminates the process (THI-52 review). Canonical pattern:
  `asyncHandler` in `src/oauth.ts`; tests in `tests/oauth-error-handling.test.ts`.

## Repo map

| Path | What lives here |
|---|---|
| `db/schema.sql` | The Item Graph schema — **protected**, see rule 2 |
| `src/tools.ts` | MCP tool surface — **protected**, see rule 2 |
| `src/items.ts` | Query + hybrid search logic |
| `src/auth.ts`, `src/rate-limit.ts`, `src/routes.ts` | Security-adjacent — **protected** |
| `src/chat.ts` | Server-side chat agent (LLM tool-loop) behind `/api/chat` |
| `scripts/` | Migrations and seeding |
| `skills/` | Agent skills (SKILL.md) for sellers and buyers |
| `public/` | Account page (login.html) + its scripts, item-page scripts, and machine discovery files (llms.txt, agents.json) |
| `docs-site/` | Public docs site (Mintlify). `tools/*.mdx` is generated from `src/tools.ts`: run `npm run docs:tools` after changing a tool |
| `tests/` | Vitest suites |

## Canonical language

External-facing text (README, llms.txt, website, skill files) uses this sentence verbatim
when describing the project:

> Thingery is the open item database and MCP server for AI agents to list, find, and trade
> second-hand goods.

Do not paraphrase it in machine-readable files — consistency is what makes LLMs retrieve us
correctly.

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`), present tense, one line. Sign
nothing; the PR is the unit of review.
