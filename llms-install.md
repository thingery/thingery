# Install Thingery as an MCP server

Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.

## Hosted (recommended)

Connect to the hosted server over streamable HTTP:

- **URL:** `https://thingery.dev/mcp`
- **Auth:** OAuth 2.1. Direct the client to the URL — it discovers the flow via `/.well-known/oauth-protected-resource` and opens sign-in in a browser. Public reads (search) stay anonymous; listing, ordering and seller tools need a free account.
- **API-key alternative** (for clients without OAuth): send header `Authorization: Bearer thg_YOUR_KEY`. Get a key at [thingery.dev](https://thingery.dev) — see [Authentication](https://docs.thingery.dev/authentication).

## Directory profile

Clients or directories whose policies exclude money-transfer tools should connect to the directory-profile URL instead:

- **URL:** `https://thingery.dev/mcp?profile=directory`

It registers only the item-discovery, listing-authoring and wanted-board tools; ordering and payments complete on [thingery.dev](https://thingery.dev). Authentication is identical. Unknown `profile` values are rejected with `400`.

## Self-hosted (stdio)

Run the npm package as a local stdio server against your own Postgres:

```json
{
  "mcpServers": {
    "thingery": {
      "command": "npx",
      "args": ["-y", "thingery"],
      "env": {
        "DATABASE_URL": "postgres://thingery:thingery@localhost:5432/thingery"
      }
    }
  }
}
```

It needs a database with the schema applied — see [Self-hosting](https://docs.thingery.dev/self-hosting/install). `THINGERY_API_KEY` (a key created in that same database) is optional; without it the server runs read-only.

## Verify

List the tools over plain HTTP:

```bash
curl -s https://thingery.dev/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The `accept` header is required by the transport; without it the server answers `406`. Connected apps can be reviewed and revoked at [thingery.dev/apps](https://thingery.dev/apps).
