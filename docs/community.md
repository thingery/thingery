# Contributing to Thingery

> Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.

We're a young project and we welcome contributors — human and AI-agent alike (this repo is
built by a team of agents with a human architect; see [`AGENTS.md`](../AGENTS.md)).

## Where to start

- **Good first issues:** we label bite-sized, well-described work
  [`good first issue`](https://github.com/thingery/thingery/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) —
  grab one and say you're on it in a comment.
- **Read first:** the [`README`](../README.md) for the architecture in five minutes
  (especially *Flexible schema*), and [`AGENTS.md`](../AGENTS.md) for working conventions.
- **Bigger ideas:** the [Roadmap](../README.md#roadmap) in the README lists what's coming —
  order state machine, buyer alerts, federation, agent-to-agent negotiation. Open an issue
  before you build something big so we can align first.

## Dev environment — target: under 10 minutes

You need Node 20+ and Docker (for Postgres), or any Postgres with the `vector` extension.

```bash
git clone https://github.com/thingery/thingery
cd thingery
npm install
docker compose up -d db          # Postgres 16 + pgvector
cp .env.example .env
npm run db:migrate
npm run db:seed                  # demo seller + 3 listings; prints an API key
npm run dev                      # http://localhost:3000
```

That's the whole stack: MCP server at `/mcp`, landing page, `/browse`, and `/chat.html`.
Point any MCP client at `http://localhost:3000/mcp` with the seeded API key to try the
seller tools. **If your setup takes longer than 10 minutes, open an issue and tell us
where it stalled — that's our bug, not yours.**

Notes:

- **No embeddings endpoint?** Leave `EMBED_API_KEY` empty — search falls back to
  keyword-only mode and everything else works.
- **No Docker?** Point `DATABASE_URL` at any Postgres with the `vector` extension.
- **Want to deploy a public instance?** See [`docs/deploy-vps.md`](deploy-vps.md)
  (~15 minutes on a fresh Ubuntu/Debian VPS).

## Before you open a PR

```bash
npm run typecheck
npm test
```

Both run without a database (CI runs the same on every PR, plus `npm run build`).
Every new code path in `src/` ships with a test in `tests/` where testable without a
live database; DB-dependent behavior is exercised by the seed script plus smoke-test
notes in the PR description.

One hard rule for route handlers (from the THI-52 security review): **async route
handlers must be wrapped in `asyncHandler` (or fully internally try/caught) —
Express 4 does not route rejected promises to error middleware, and an unhandled
rejection terminates the process.** The canonical pattern is `asyncHandler` in
[`src/oauth.ts`](../src/oauth.ts), with the behavior pinned by
[`tests/oauth-error-handling.test.ts`](../tests/oauth-error-handling.test.ts).

## How changes flow

1. **Feature branch → pull request → CI green → human merge.** Nobody pushes to `main`.
2. **Small, verifiable PRs.** One PR = one purpose; if a change needs > ~300 lines,
   split it and say so in the issue.
3. **Some paths are protected:** `db/schema.sql`, the MCP tool signatures in
   `src/tools.ts`, auth, rate limits, payments, and CI need explicit human approval
   in the PR description. Everything else (docs, website, tests, internal refactors)
   is mergeable once CI is green.

Full engineering standards (TypeScript strict mode, parameterized SQL only, ESM,
conventional commits) live in [`AGENTS.md`](../AGENTS.md).

## Where to ask questions

- **Anything:** [open an issue](https://github.com/thingery/thingery/issues/new/choose) —
  we use the `question` label for Q&A and we'd rather answer ten questions than have you
  guess once.
- **Bugs:** open an issue with the smallest reproduction you can manage.
- **Feature ideas:** open an issue and frame it as a use case ("as a seller agent, I
  want to …") — the flexible-schema design means many ideas are attributes, not migrations.
