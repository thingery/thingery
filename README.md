# Thingery

> **Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.**

Say *"sell this"* to your AI assistant — it identifies the item, writes the listing, prices it,
and publishes it. Say *"find me a used camera under €300"* — it searches every listing and
proposes the best one. Thingery is the shared database and the MCP tools underneath those agents.

- **Free** for everyone. No take rate, no platform lock-in.
- **Open source** (Apache-2.0). Self-host the whole thing, or use the flagship instance.
- **Agent-native**: every capability is an MCP tool; any LLM can drive it.
- **Self-hostable**: Postgres + pgvector + Node 20.

Chinese-market name: 物坊 (Wùfāng).

## MCP tools

| Tool | Auth | Purpose |
|---|---|---|
| `describe_category` | public | List categories and their expected attribute fields — the self-describing schema for agents |
| `search_items` | public | Hybrid semantic + keyword search with price/category/condition/attribute filters |
| `get_item` | public | Fetch one listing by id |
| `create_listing` | seller | Publish an item — core fields plus a flexible `attributes` object |
| `add_item_image` | seller | Attach a photo to a listing (base64 in, stored server-side — no URLs needed) |
| `my_listings` | seller | Your listings by status |
| `update_listing` | seller | Mark reserved/sold, adjust price, edit text or attributes |

Sellers authenticate with **OAuth** (one-click sign-in from any MCP host — see below) or a
`thg_...` API key (`Authorization: Bearer`); search is anonymous.

## Two ways to use it

- **Zero-config (everyone):** open **`/chat.html`** on any deployment and talk to the Thingery
  assistant — describe an item to sell or to find. Searching needs no account; publishing needs a
  free one (`/login.html`, email + password; your MCP API key is shown after signup).
  The chat uses an LLM configured on the server (`LLM_*` env vars) — you bring the key, any
  OpenAI-compatible endpoint works; without it, chat is disabled while MCP and signup still work.
- **Bring your own agent (power users):** point any MCP client at `/mcp` and **sign in with
  OAuth** — Claude Desktop, ChatGPT connectors, VS Code and Inspector discover the sign-in
  flow automatically (RFC 9728 resource metadata + RFC 7591 dynamic client registration);
  you approve once on a consent screen and the host gets a rotating `thgo_` token, with
  revoke-anytime at [`/apps`](https://thingery.dev/apps). Prefer a key? The manual `thg_...`
  API key still works, and self-hosting is below (`npx thingery` over stdio).

## Quickstart

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

### No Docker? Local Postgres

`npm run db:migrate` needs a Postgres with the `vector` extension — the schema creates it
unconditionally, even in keyword-only search mode. On macOS, Homebrew's `pgvector` bottle
supports PostgreSQL 17 and 18 (not 16, the version the Docker setup uses — any of them works
for Thingery):

```bash
brew install postgresql@18 pgvector
brew services start postgresql@18
psql postgres -c "CREATE ROLE thingery LOGIN PASSWORD 'thingery';" \
              -c "CREATE DATABASE thingery OWNER thingery;"
psql -d thingery -c "CREATE EXTENSION vector;"   # run as the Postgres superuser
```

The default `DATABASE_URL` in `.env.example` already matches this setup. On any other
Postgres, run the same two SQL statements as the superuser and point `DATABASE_URL` at it.

### Connect an MCP client

Most hosts (Claude Desktop, ChatGPT connectors, VS Code, Inspector) can sign in with **OAuth**:
just add `https://thingery.dev/mcp` (or your self-hosted URL) as a remote HTTP server — the host
discovers the sign-in flow, you approve once, and tokens rotate automatically. On thingery.dev
you can review and revoke connected applications at `/apps`.

Hosts without OAuth support use a `thg_...` API key (from `/login.html`) as a static bearer
token instead:

```json
{
  "mcpServers": {
    "thingery": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer thg_YOUR_KEY" }
    }
  }
}
```

Omit the `Authorization` header for buyer-only (public search) usage — anonymous access to the
public read tools is always available. Design note: the decision record for the OAuth flow is
[docs/adr/0002-mcp-oauth-onboarding.md](docs/adr/0002-mcp-oauth-onboarding.md); set
`OAUTH_DISABLED=1` to turn OAuth routes off entirely (hosts then fall back to keys).

### Run locally over stdio (`npx`)

Self-host without any web server — the package runs as a local stdio MCP server against your
own Postgres, spawnable by Claude Desktop and similar clients:

```json
{
  "mcpServers": {
    "thingery": {
      "command": "npx",
      "args": ["-y", "thingery"],
      "env": {
        "DATABASE_URL": "postgres://thingery:thingery@localhost:5432/thingery",
        "THINGERY_API_KEY": "thg_YOUR_KEY"
      }
    }
  }
}
```

`THINGERY_API_KEY` is optional; without it the server runs read-only (search + get).

### Try it with curl

```bash
# List tools (the Accept header is required by the MCP Streamable HTTP transport)
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Search (finds the seeded Nike Air Max: €85 is within the €100 filter)
curl -s http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"search_items","arguments":{"q":"air max","max_price_cents":10000}}}'
```

Responses come back as Server-Sent Events; the JSON-RPC result is on the `data:` line.

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `PORT` / `PUBLIC_BASE_URL` | HTTP port and base URL used in item links |
| `EMBED_API_URL` / `EMBED_API_KEY` / `EMBED_MODEL` | Any OpenAI-compatible embeddings endpoint; leave the key empty for keyword-only search |

## Agent skills

- [`skills/sell-item`](skills/sell-item/SKILL.md) — the seller pipeline: photos → identified item → priced listing
- [`skills/find-item`](skills/find-item/SKILL.md) — the buyer pipeline: intent → scored matches → one best proposal

## Data conventions

- Prices are **integer cents**: `12500` = EUR 125.00
- Conditions: `new`, `like_new`, `good`, `fair`, `poor`
- Shipping tiers: `locker` (shoebox-sized), `parcel` (≤30kg), `bulky` (furniture), `local` (pickup)
- Machine discovery: [`llms.txt`](website/llms.txt) · [`agents.json`](website/.well-known/agents.json)

### Flexible schema

No fixed column set can cover sneakers, cameras and sofas at once, so the Item Graph is a hybrid:

- **Rigid core columns** for what every item shares: identity, price, condition, status, category, shipping estimation, embedding. These drive indexing and business logic.
- **`attributes JSONB`** for category-specific fields (`size_eu`, `colorway`, `shutter_count`, `ISBN`...), GIN-indexed for containment filters (`{"size_eu": 43}`) and flattened into the semantic embedding so they're meaning-searchable too.
- **A `categories` registry** that declares expected attribute definitions per category. `create_listing` validates declared keys (types, required, enums) but **unknown keys pass through** — flexible by design, and federation-friendly since instances can diverge on attributes without breaking sync. Agents self-serve the schema via `describe_category`.
- **`sellers.profile JSONB`** for user-side flexibility (locale, currency, notification prefs, negotiation mandates) — reserved for upcoming features.

Growth path: when an attribute becomes a hot filter, promote it to a Postgres generated column + index — no API change needed.

## Roadmap

1. **Order state machine** — `sold → label issued → in transit → delivered → payout released`, driven by carrier + payment webhooks (Stripe Connect / shipping aggregator).
2. **Seller skill upgrade** — photo capture flow, comparable-based pricing from live data.
3. **Buyer alerts** — event stream: "new match for your intent".
4. **Federation protocol** — instance-to-instance sync so anyone can host a node of the Item Graph.
5. **Agent-to-agent negotiation** — bounded-mandate negotiation between buyer and seller agents.

## Contributing

Built by an agent team with a human architect — see [`AGENTS.md`](AGENTS.md) for the working
conventions. PRs welcome; CI (typecheck, build, tests) must pass. New here? Start with
[`docs/community.md`](docs/community.md) — good first issues, dev setup in under 10 minutes,
and where to ask questions.

## License

[Apache-2.0](LICENSE)
