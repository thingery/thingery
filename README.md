<p align="center">
  <img src="website/assets/logo-mark.svg" width="112" alt="Thingery logo" />
</p>

# Thingery

> **Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.**

Say *"sell this"* to your AI assistant — it identifies the item, writes the listing, prices it,
and publishes it. Say *"find me a used camera under €300"* — it searches every listing and
proposes the best one. Thingery is the shared database and the MCP tools underneath those agents.

[![M8ven Score](https://m8ven.ai/badge/mcp/thingery-thingery-aupktp?v=d2e97eed605c8f7862fd994bb95f2f03)](https://m8ven.ai/mcp/thingery-thingery-aupktp?s=readme)

- **Free** for everyone. No take rate, no platform lock-in.
- **Open source** (Apache-2.0). Self-host the whole thing, or use the flagship instance.
- **Agent-native**: every capability is an MCP tool; any LLM can drive it.
- **Self-hostable**: Postgres + pgvector + Node 20.

Chinese-market name: 物坊 (Wùfāng).

## MCP tools

| Tool | Auth | Purpose |
|---|---|---|
| `describe_category` | public | List categories and their declared attribute fields — the self-describing schema for agents. Declared fields get validated on create; undeclared keys are allowed, searchable, and their real use is surfaced via `undeclared_in_use` |
| `search_items` | public | Hybrid semantic + keyword search with price/category/condition/attribute filters (any attribute key, declared or not) |
| `get_item` | public | Fetch one listing by id. Pending (photoless) listings are returned too — they carry `needs_photo: true` |
| `create_listing` | seller | Publish an item — core fields plus a flexible `attributes` object (declared keys validated, extras pass through and stay searchable). **Listings are hidden from search until they have at least one photo**: a zero-image create succeeds but stays pending (`visible: false` + `next_steps` in the result) until a photo lands |
| `add_item_image` | seller | Attach a photo to a listing (base64 in, stored server-side — no URLs needed; max 5 MB decoded). The first photo publishes a pending listing — the result's `visible` tells you. Images are re-encoded at ingest: metadata (EXIF/GPS/XMP) stripped, downscaled to ≤ 2000 px, animated GIFs stored as stills; large PNGs may be rejected — prefer JPEG |
| `my_listings` | seller | Your listings by status |
| `update_listing` | seller | Mark reserved/sold, adjust price, edit text or attributes |

### Order flow

| Tool | Auth | Purpose |
|---|---|---|
| `get_payout_setup` | seller | Stripe Express onboarding URL + status — optional, enables platform payment |
| `create_order` | account | Order an item — returns a Stripe Checkout URL (stripe mode) or tracks an off-platform order |
| `get_order` | account | One of your orders (buyer or seller side): status, tracking, deadlines |
| `cancel_order` | account | Cancel while cancellable; paid orders refund instead |
| `record_tracking` | seller | Record carrier + tracking code; auto carrier tracker when EasyPost is configured |
| `confirm_payment` | seller | Confirm an off-platform payment (pending → sold) |
| `confirm_receipt` | buyer | Confirm delivery — dispute window opens |
| `open_dispute` | buyer | Dispute a delivered order; seller payout is held |
| `release_funds` | buyer | Waive the dispute window, release the seller's payout now |

Orders close a deal on-platform. **Stripe mode** (buyer protection: platform charges the
buyer, holds funds, pays the seller after delivery + dispute window) runs when the deployment
has Stripe configured *and* the seller finished payout onboarding; otherwise orders run in
**off-platform mode** — Thingery tracks state and deadlines, parties settle payment themselves.
States: `pending → sold → label_issued → in_transit → delivered → payout_pending → paid_out`
with `disputed`/`cancelled`/`refunded` off-ramps; deadlines are enforced by a server-side sweep
(unpaid cancels 24h, dispute window 48h, never-shipped disputes auto-refund 72h — defaults,
env-tunable). Design record: [ADR 0003](docs/adr/0003-order-state-machine.md).

Sellers authenticate with **OAuth** (one-click sign-in from any MCP host — see below) or a
`thg_...` API key (`Authorization: Bearer`); search is anonymous.

### Buyer alerts

| Tool | Auth | Purpose |
|---|---|---|
| `save_intent` | seller | Save a buyer alert — what you're looking for as a free-text query and/or structured filters (category, condition, price range, shipping tier, attributes). Max 25 stored intents, 50 saves/day |
| `my_intents` | seller | Your saved alerts, newest first, each with its unread match count and muted state |
| `update_intent` | seller | Mute or unmute one alert — muted alerts stop collecting new matches |
| `delete_intent` | seller | Delete an alert and its match records |

Saved intents feed buyer alerts: when a new listing matching an intent publishes, the match
shows up in `my_intents`' unread counts (a dedicated `my_matches` view is landing next).

### Photo-required publishing

New listings need **at least one photo** to be visible to buyers — browse, `search_items`, and
category counts all exclude photoless listings (a single derived predicate; design record:
[ADR 0005](docs/adr/0005-photo-gated-visibility.md)). What that means in practice:

- `create_listing` with zero images **succeeds** — the listing is created but **pending**: hidden
  from feeds, its item page shows placeholder art and is `noindex`. The result carries
  `photo_required`, `visible: false`, and `next_steps` pointing at `add_item_image` (or the item
  page, where the owner can snap a photo in two taps).
- **The first photo publishes it** — no second call needed. `add_item_image` returns
  `visible: true`; pending items carry `needs_photo: true` everywhere items are returned
  (`get_item`, `my_listings`, …).
- Deleting the **last** photo returns the listing to pending (hidden again); pre-rollout
  listings are grandfathered and stay live without photos — on thingery.dev that means
  created before 2026-10-27; a self-hosted instance grandfathers whatever exists when it
  first deploys this version.
- Owners manage photos on the item page (upload, delete, reorder) via the session-cookie routes
  documented in [docs/item-images.md](docs/item-images.md).

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

Pick your mode first — hosted and self-hosted expose the **same MCP tools** but **not the same
data**: listings you create on the hosted service are visible to everyone; listings on your
self-hosted instance live only in your database.

| Mode | Endpoint | Data | Best for |
|---|---|---|---|
| **Hosted** | `https://thingery.dev/mcp` | the shared public marketplace | first success in under a minute — nothing to install |
| **Self-hosted** | your own `/mcp`, or stdio | your Postgres, your data | private deployments, full control, hacking on it |

### Mode A — hosted: search in one minute

No install. Add `https://thingery.dev/mcp` as a remote HTTP server in your MCP client
(Claude Desktop, ChatGPT connectors, VS Code, Inspector — see [Connect an MCP client](#connect-an-mcp-client)
below) and sign in with OAuth, or grab an API key at [`/login.html`](https://thingery.dev/login.html)
(free account; the `thg_...` key is shown after signup). Searching needs no account at all —
verify the wire format with curl:

```bash
curl -s https://thingery.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search_items","arguments":{"q":"Air Max"}}}'
```

Responses come back as Server-Sent Events; the JSON-RPC result is on the `data:` line.

### Mode B — self-hosted: the npm package

The [`thingery` npm package](https://www.npmjs.com/package/thingery) runs the whole server
against your own Postgres. No git clone needed:

```bash
mkdir my-thingery && cd my-thingery
npm install thingery

# 1. a Postgres with the pgvector extension (Docker: `docker run -d -p 5432:5432 \
#    -e POSTGRES_PASSWORD=thingery pgvector/pgvector:pg16`; Homebrew: see below)
# 2. apply the shipped schema (idempotent, safe to re-run):
psql "postgres://postgres:thingery@localhost:5432/postgres" \
  -f node_modules/thingery/db/schema.sql

# 3. run it (DATABASE_URL is the only required env var):
DATABASE_URL="postgres://postgres:thingery@localhost:5432/postgres" \
PORT=3000 node node_modules/thingery/dist/index.js
```

The server boots at `http://localhost:3000` — `/mcp`, `/browse`, `/healthz`, and the HTTP
API. Create your account by opening [`/login.html`](http://localhost:3000/login.html) —
your `thg_...` MCP key is shown right after signup. (On the pre-fix 0.1.2 release the
page 404'd — a packaging gap fixed after it; there you can still create the account
through the API — the key is returned exactly once, in the signup response:)

```bash
curl -s -X POST http://localhost:3000/api/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"at-least-8-chars"}'
# → {"seller":{"name":"you","email":"…","api_key":"thg_…"}}
```

Then point any MCP client at `http://localhost:3000/mcp` with
`Authorization: Bearer thg_...` — or spawn it over stdio with the
[`npx` config below](#run-locally-over-stdio-npx).

> Note: the npm package publishes at release cadence and can lag `main` on thingery.dev
> by days — `/healthz` reports the running version. If you need today's features,
> self-host from source instead:

### Self-hosted from source (development)

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

Self-host without any web server — the package is [`thingery` on npm](https://www.npmjs.com/package/thingery)
and runs as a local stdio MCP server against your own Postgres, spawnable by Claude Desktop and
similar clients:

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

`THINGERY_API_KEY` is optional; without it the server runs read-only (search + get). The
stdio server needs the same prerequisites as Mode B: a Postgres with the schema applied
(`psql -f node_modules/thingery/db/schema.sql`) and, for write tools, a key that exists in
*that* database (from that deployment's `/login.html` or `/api/signup`).

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `search_items` returns 0 for a common word like "sneakers" | thingery.dev runs keyword-only search (no embeddings configured): it matches literal words in titles/descriptions — and no live listing contains the word "sneakers" | search brand/product words (`"Air Max"`, `"Samba"`), or filter by `category` instead |
| `create_listing` returns `visible: false` | photo-required publishing: zero-image listings stay pending and hidden | call `add_item_image` — the first photo publishes the listing |
| HTTP 401 `authentication required` | protected tool called without a credential | sign in with OAuth, or send `Authorization: Bearer thg_...` |
| HTTP 406 from `/mcp` | the MCP Streamable HTTP transport requires the SSE Accept header | send `accept: application/json, text/event-stream` |
| `npm run db:migrate` fails inside an installed package | `scripts/` isn't published — the schema ships as `db/schema.sql` | `psql "$DATABASE_URL" -f node_modules/thingery/db/schema.sql` |
| stdio warning: `THINGERY_API_KEY set but not found in the database` | the key belongs to a different deployment's database | get a key from *this* deployment (`/login.html` or `/api/signup`) |
| Self-hosted behaves differently from thingery.dev | the npm release can lag `main` (e.g. photo-gating) | compare `/healthz` versions; self-host from source for today's `main` |

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

### Use an agent framework (LangChain, LlamaIndex, Composio)

Framework toolkits reach the same `/mcp` endpoint over streamable HTTP — copy-paste
quickstarts with verified end-to-end tool calls live in
[examples/integrations/](examples/integrations/).

## Configuration

Copy `.env.example` to `.env`. Key variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `PORT` / `PUBLIC_BASE_URL` | HTTP port and base URL used in item links |
| `EMBED_API_URL` / `EMBED_API_KEY` / `EMBED_MODEL` | Any OpenAI-compatible embeddings endpoint; leave the key empty for keyword-only search |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Order flow payments (Stripe Connect). Empty key = platform payment off (orders run off-platform); key without webhook secret = payments stay pending until the webhook is configured (fail-closed) |
| `EASYPOST_API_KEY` / `EASYPOST_WEBHOOK_SECRET` | Optional automatic carrier tracking; without it, buyers/sellers confirm delivery manually |
| `ADMIN_API_KEY` | Admin dispute-resolution route; disabled unless ≥32 chars |

Order-flow windows and abuse caps (`PAYMENT_DEADLINE_HOURS`, `DISPUTE_WINDOW_HOURS`,
`PICKUP_AUTOCONFIRM_DAYS`, `MAX_PENDING_ORDERS_PER_BUYER`, …) are documented inline in
[`.env.example`](.env.example) with their defaults.

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

Which undeclared keys are *actually* in use is discoverable too: `describe_category` returns `undeclared_in_use` — undeclared attribute keys observed on active listings from multiple sellers, with item and distinct-seller counts. These keys are never validated (they pass through as-is), so treat them as search hints, not contracts — a signal of what buyers can filter on today.

Reading `undeclared_in_use` as an agent:

- It lists at most 20 keys, and only keys carried by ≥2 active listings from ≥2 distinct sellers. The field is omitted entirely when no key qualifies.
- Values are free-form: the same undeclared key can hold different values (even different types) on each listing. Use the key in `search_items` attribute filters — they match any key, declared or not — but never treat one listing's value as the category's contract.
- Writes are shape-capped on `create_listing` and `update_listing`: at most 64 attribute entries, keys up to 128 chars, string values up to 500 chars. Over the cap, the call fails with `invalid_attributes`.

## Roadmap

1. ~~**Order state machine**~~ — **shipped**: orders with Stripe Connect payouts, carrier webhooks, disputes, and deadline sweeps ([ADR 0003](docs/adr/0003-order-state-machine.md)). Next: live-mode Stripe after legal/ToS sign-off.
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
