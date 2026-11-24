<p align="center">
  <img src="public/assets/logo-mark.svg" width="112" alt="Thingery logo" />
</p>

# Thingery

> **Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.**

Say *"sell this"* to your AI assistant — it identifies the item, writes the listing, prices it,
and publishes it. Say *"find me a used camera under €300"* — it searches every listing and
proposes the best one. Thingery is the shared database and the MCP tools underneath those agents.

[![M8ven Score](https://m8ven.ai/badge/mcp/thingery-thingery-aupktp?v=d2e97eed605c8f7862fd994bb95f2f03)](https://m8ven.ai/mcp/thingery-thingery-aupktp?s=readme)

[![Thingery MCP server](https://mcprush.com/badge/thingery-mcp/card.svg)](https://mcprush.com/thingery/thingery-mcp)

- **Free** for everyone. No take rate, no platform lock-in.
- **Open source** (Apache-2.0). Self-host the whole thing, or use the flagship instance.
- **Agent-native**: every capability is an MCP tool; any LLM can drive it.
- **Self-hostable**: Postgres + pgvector + Node 20.

Chinese-market name: 物坊 (Wùfāng).

**Documentation: [docs.thingery.dev](https://docs.thingery.dev)** — connecting clients, guides,
the full MCP tool reference, and self-hosting.

## Quickstart

The hosted MCP server is **`https://thingery.dev/mcp`**. Add it to your client and sign in when
it asks:

```bash
# Claude Code
claude mcp add --transport http thingery https://thingery.dev/mcp
```

Claude, ChatGPT, Cursor, VS Code and other clients: see
[Connect a client](https://docs.thingery.dev/connect). Searching needs no account — try it
with curl:

```bash
curl -s https://thingery.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search_items","arguments":{"q":"Air Max"}}}'
```

To run your own server on your own Postgres (`npm install thingery`, or from source), see
[Self-hosting](https://docs.thingery.dev/self-hosting/install).

## Single-player mode

Thingery is useful with zero buyers. Catalog your stuff today, sell when you're ready —
one photo, one line, no re-entry:

1. **Draft** — hand your assistant a photo or a one-liner ("white Nike Air Max 90, size 43,
   worn twice") and call `draft_listing`. It proposes title, category, condition, brand,
   registry-validated attributes, a fair-market-value range computed from real comparable
   listings, and open questions to confirm with you. Nothing is created and nothing is
   published — you review the draft before anything is saved.
2. **Store** — `create_listing` with `status: "stored"` saves the item to your private
   inventory. Stored items are invisible to search, browse and other agents (`get_item`
   answers `not_found` to everyone but you); you see them via `my_listings`.
3. **Flip** — ready to sell? `update_listing` with `status: "active"` puts the item on the
   market instantly: photos, attributes, price and search indexing are all preserved, and
   buyer alerts fire the moment it goes live.
4. **Export** — `format_listing` turns the item into ready-to-paste copy for Subito,
   Vinted, Wallapop or eBay, in Italian or English. Export only — nothing is posted
   elsewhere; you paste the copy yourself.

Walkthrough: [Selling guide](https://docs.thingery.dev/guides/selling). The
[`sell-item` skill](skills/sell-item/SKILL.md) gives any agent the full pipeline.

**Photo privacy when drafting.** When you use the draft feature, your photo and text are
sent to the LLM provider configured by this Thingery deployment solely to produce a
structured draft (category, attributes, condition, price range). Photos are stripped of
metadata (EXIF/GPS) and downsampled before they leave the server. Inputs are not stored:
nothing is retained from the extraction call — no images, no model conversation. Only the
listing you explicitly confirm and publish is saved. Avoid including identifiable people
in frame; no automated face blurring is applied. If you operate a self-hosted deployment,
point the extraction endpoint at a provider whose terms match your privacy requirements.

### Directory profile

Connector directories whose policies exclude money-transfer tools (e.g. the Claude
Connectors Directory) should use the directory profile instead of the canonical URL:

```text
https://thingery.dev/mcp?profile=directory
```

It registers only the 18 item-discovery, listing-authoring, and wanted-board tools;
ordering and payments complete on thingery.dev. The canonical `/mcp` (no parameter)
keeps the full tool surface for self-hosters, registries, and direct clients.
Authentication is identical on both URLs — included seller tools keep the OAuth
onboarding challenge, public reads stay anonymous. Unknown `profile` values are
rejected with `400` rather than silently falling back to the full tool set.

## Documentation

| Topic | Where |
|---|---|
| First search and first listing | [Quickstart](https://docs.thingery.dev/quickstart) |
| Claude, ChatGPT, Cursor, VS Code, stdio, plain HTTP | [Connect a client](https://docs.thingery.dev/connect) |
| OAuth and API keys | [Authentication](https://docs.thingery.dev/authentication) |
| Selling, buying, orders, alerts, wanted board | [Guides](https://docs.thingery.dev/guides/selling) |
| Draft → private inventory → export walkthrough | [Selling guide](https://docs.thingery.dev/guides/selling#single-player-mode) |
| Every MCP tool and its parameters | [MCP tools](https://docs.thingery.dev/tools/overview) |
| Self-hosting and environment variables | [Self-hosting](https://docs.thingery.dev/self-hosting/install) |
| Prices, conditions, the flexible item schema | [Data conventions](https://docs.thingery.dev/reference/data-conventions) |
| The two-level category registry (departments, aliases, typed sizes) | [Data conventions](https://docs.thingery.dev/reference/data-conventions#category-registry) |
| Common errors | [Troubleshooting](https://docs.thingery.dev/reference/troubleshooting) |

The docs live in [`docs-site/`](docs-site/) and publish with Mintlify. The tool reference is
generated from `src/tools.ts` (`npm run docs:tools`), and a test fails when it falls out of date.

Note for self-hosters: the `categories` table is **managed** — `db/schema.sql` owns its rows,
and running a migration converges the registry to the shipped definitions. See
[Data conventions → Category registry](https://docs.thingery.dev/reference/data-conventions#category-registry).
Design records are in [`docs/adr/`](docs/adr/).

Agent skills: [`skills/sell-item`](skills/sell-item/SKILL.md) (photos → priced listing) and
[`skills/find-item`](skills/find-item/SKILL.md) (intent → one best proposal → saved-search alerts).
Machine discovery: [`llms.txt`](public/llms.txt) · [`agents.json`](public/.well-known/agents.json).

## Roadmap

1. ~~**Order state machine**~~ — **shipped in code; payments not live yet**: orders with Stripe Connect payouts, carrier webhooks, disputes, and deadline sweeps ([ADR 0003](docs/adr/0003-order-state-machine.md)). thingery.dev runs orders off-platform only — no Stripe keys are configured in production — until legal/ToS sign-off flips payments on.
2. **Seller skill upgrade** — **photo capture shipped**: frictionless item-page capture, placeholder art, and photo-gated publishing ([ADR 0005](docs/adr/0005-photo-gated-visibility.md)). Comparable-based pricing is deferred until listings are numerous enough to be real comparables.
3. **Buyer alerts** — **next up**: "new match for your intent" event stream.
4. **Federation protocol** — instance-to-instance sync so anyone can host a node of the Item Graph. **Deferred**.
5. **Agent-to-agent negotiation** — bounded-mandate negotiation between buyer and seller agents. **Deferred**.

We'll revisit federation and negotiation when there's real traction: more than 10 new listings per week for 2 consecutive weeks, or concrete pull from self-host adopters.

## Security

What's verified and what isn't: [docs/security-note.md](docs/security-note.md). To report a vulnerability privately, see [SECURITY.md](SECURITY.md).

## Contributing

Built by an agent team with a human architect — see [`AGENTS.md`](AGENTS.md) for the working
conventions. PRs welcome; CI (typecheck, build, tests) must pass. New here? Start with
[`docs/community.md`](docs/community.md) — good first issues, dev setup in under 10 minutes,
and where to ask questions.

## License

[Apache-2.0](LICENSE)
