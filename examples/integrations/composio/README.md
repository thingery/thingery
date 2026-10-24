# Thingery + Composio

Composio has no public directory for third-party MCP servers (checked
2026-10-24). The supported path is **Custom MCP**: register a public MCP server
URL in *your own* Composio project, and its tools appear as a `CUSTOM_*`
toolkit next to Composio's built-ins. Custom MCP is **experimental** and
API-only as of 2026-10; its contracts may change — treat this page as a
starting point and check
[Composio's Custom MCP docs](https://docs.composio.dev/docs/extending-sessions/custom-mcp)
for the current shape.

There is nothing to run from this repo: registration happens against your
Composio project with your own API key, and Thingery's server stays hosted by
us. That is why the verdict table calls this a copy-paste guide rather than a
verified example.

## Register Thingery (read tools, no auth)

`search_items`, `get_item`, and `describe_category` are public, so the
no-auth scheme is enough for buyer/search agents:

```bash
curl -X POST https://backend.composio.dev/api/v3.1/custom/toolkits/upsert \
  -H "x-api-key: $COMPOSIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "THINGERY",
    "toolkit_config": {
      "name": "Thingery",
      "app_url": "https://thingery.dev/mcp",
      "auth_schemes": [{"mode": "NO_AUTH"}]
    }
  }'
```

The response contains the project-scoped toolkit slug, `CUSTOM_THINGERY`.
Sync (automatic on first registration) pulls our 16 tool definitions; re-sync
after we add tools. Then add the toolkit to a session like any built-in one.

## Register Thingery (full read/write)

Write tools (listings, orders, payouts) need authentication. Use the API-key
scheme with a Thingery `thg_...` key from
[thingery.dev/login.html](https://thingery.dev/login.html); Composio connects
one key per toolkit per account:

```json
"auth_schemes": [
  {
    "mode": "API_KEY",
    "headers": { "Authorization": "Bearer {{generic_api_key}}" }
  }
]
```

Notes (from Composio's guidance): serve the final HTTPS endpoint directly —
`https://thingery.dev/mcp` already is — and keep keys out of URLs.

## Trade-off

We do not register or maintain anything on Composio's side, and each Composio
customer registers Thingery into their own project. No wrapper package: Custom
MCP consumes our existing MCP endpoint as-is, so a package would add
maintenance cost and zero capability. If Composio later ships a public
third-party MCP directory, listing there should go through the per-item
board-approval rule before anything is submitted.
