# Integrating with Thingery over MCP

> **Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.**

One page, four steps: **connect → authenticate → first workflow → troubleshooting**.
The fastest way in is the zero-dependency [quickstart script](../examples/quickstart/)
(`node quickstart.mjs`) — this guide covers the same ground client by client.

The hosted MCP server is **`https://thingery.dev/mcp`** — Streamable HTTP, JSON-RPC 2.0,
POST-only and stateless (every request stands alone, no session). Self-hosted instances
expose the same endpoint at your own URL.

## 1. Connect

### OAuth-capable hosts (Claude Desktop, ChatGPT connectors, VS Code, Inspector)

Add the URL as a **remote HTTP server**; the host discovers the OAuth 2.1 sign-in flow
automatically (RFC 9728 resource metadata + dynamic client registration), you approve
once in the browser, and tokens rotate on their own. No token handling in your code.

**Claude Desktop** → Settings → Connectors → Add custom connector → `https://thingery.dev/mcp`

**VS Code / Copilot** — `.vscode/mcp.json`:

```json
{
  "servers": {
    "thingery": { "type": "http", "url": "https://thingery.dev/mcp" }
  }
}
```

**MCP Inspector**:

```bash
npx @modelcontextprotocol/inspector
# transport: Streamable HTTP → url: https://thingery.dev/mcp → Connect (sign-in offered)
```

### Static-key hosts (Cursor, scripts, CI)

Hosts without OAuth use an API key as a static bearer token:

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "thingery": {
      "url": "https://thingery.dev/mcp",
      "headers": { "Authorization": "Bearer thg_YOUR_KEY" }
    }
  }
}
```

**Any client config** (generic form):

```json
{
  "mcpServers": {
    "thingery": {
      "type": "http",
      "url": "https://thingery.dev/mcp",
      "headers": { "Authorization": "Bearer thg_YOUR_KEY" }
    }
  }
}
```

### Self-hosted over stdio (`npx`)

The npm package runs as a local stdio MCP server against your own Postgres:

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

`THINGERY_API_KEY` is optional; without it the server is read-only (search + get).

## 2. Authenticate

| Credential | How | Grants |
|---|---|---|
| none | just don't send a header | public reads: `describe_category`, `search_items`, `get_item` |
| `thg_...` API key | create a free account at [thingery.dev/login.html](https://thingery.dev/login.html); the key is shown once (signup or rotation) | everything, incl. listing writes and orders |
| OAuth (`thgo_`/`thgr_` tokens) | hosts handle it; approve once in the browser; review/revoke at [thingery.dev/apps](https://thingery.dev/apps) | same as the API key |

Headless — CI, scripts, agents — no browser needed: signup is a plain API call and the
response carries the key:

```bash
curl -s -X POST https://thingery.dev/api/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"choose-8-plus-chars"}' \
  | jq -r '.seller.api_key'
```

Send the key as `Authorization: Bearer thg_YOUR_KEY` on every MCP POST that needs it.
A presented-but-invalid credential is rejected with **HTTP 401** — it never silently
downgrades to anonymous. Anonymous calls to write tools get a 401 that OAuth hosts
can act on (the challenge points at the sign-in flow).

**Never commit keys.** Use an env var (`THINGERY_API_KEY`) — placeholder names only in
files, as in every snippet here.

## 3. First workflow

Raw JSON-RPC (what the [quickstart script](../examples/quickstart/) sends — POST to
`/mcp` with `Content-Type: application/json` and `Accept: application/json, text/event-stream`;
responses come back as SSE with the result on the `data:` line):

```bash
# Search — public, no key
curl -s https://thingery.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search_items","arguments":{"q":"sneakers"}}}'
```

The two canonical agent workflows:

- **Buyer:** `search_items` (filters: category, condition, price range, exact-match
  `attributes` on any key; page with `offset`, up to 450) → `get_item` → propose. Ready to buy? `create_order`
  (see the README's [Order flow](../README.md#order-flow) section).
- **Seller:** `describe_category` → `create_listing` (category-specific fields go in
  `attributes`) → `add_item_image` — **the first photo publishes the listing**; a
  photoless create stays pending (`visible: false`, hidden from search). →
  `my_listings` / `update_listing` to manage it.

Framework quickstarts (LangChain, LlamaIndex, Composio) with verified end-to-end tool
calls: [examples/integrations/](../examples/integrations/).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `HTTP 405` on GET | `/mcp` is POST-only — POST JSON-RPC bodies |
| `HTTP 406` | Add `Accept: application/json, text/event-stream` (required by the transport) |
| `HTTP 401` on public tools | You sent an Authorization header with an invalid/expired key. Fix or drop the header — invalid never falls back to anonymous |
| `HTTP 401` on `create_listing` etc. | Missing/invalid `thg_...` key — get one at [login.html](https://thingery.dev/login.html) |
| `HTTP 413` | `/mcp` caps bodies at 8 MiB (base64 photos of ≤5 MB decoded fit) |
| `HTTP 429` | Rate limits: 10 signups/logins per IP per hour; per-seller listing velocity caps; per-hour image-upload caps. Back off and retry |
| Listing is `visible: false` | Photo gate: listings need ≥1 photo to appear in search/browse. `add_item_image` publishes it; the result's `visible` says so |
| Response is `event: message` / `data: {...}` | That's SSE — parse the `data:` line for the JSON-RPC result |
| `connection refused` on self-host | The Express server or Postgres isn't up — check `docker compose up -d db`, `npm run db:migrate`, then `/healthz` |

Still stuck? [Open an issue](https://github.com/thingery/thingery/issues) — or ask in
the community channels listed in [docs/community.md](community.md).

## Machine discovery

- [`llms.txt`](https://thingery.dev/llms.txt) — full endpoint + tool reference
- [`/.well-known/agents.json`](https://thingery.dev/.well-known/agents.json) — agent capabilities manifest
- `describe_category` — self-describing item schema, at runtime
