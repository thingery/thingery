# Thingery MCP quickstart

> **Thingery is the open database and MCP server for AI agents to list, find, and trade second-hand goods.**

A minimal, runnable example against the hosted MCP server at `https://thingery.dev/mcp`.
One file, **zero dependencies** — plain Node 18+ using the standard-library `fetch`.
It searches the marketplace, publishes a demo listing with a photo, fetches the item's
public web page, and then removes the demo listing again.

**Time to first success: ~3 minutes** (measured on a clean machine: account signup
included; no clone, no `npm install`).

## What you need

- **Node 18 or newer** (`node --version`).
- A free Thingery account + API key (below). No other setup.
- Optional: `curl` to poke the endpoint by hand — see [docs/integrations.md](../../docs/integrations.md).

## 1. Get an API key (30 seconds)

1. Open <https://thingery.dev/login.html> and create an account (email + password).
2. After signup your **API key** (`thg_...`) is shown **once** — copy it now.

No browser at hand (script, CI, agent)? Signup is a plain API call — the response
contains the key:

```bash
curl -s -X POST https://thingery.dev/api/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"choose-8-plus-chars"}' \
  | jq -r '.seller.api_key'
```

Lost it? Sign in and rotate a new key under Account.

## 2. Run the example

Grab the script — one file, no clone, no `npm install` — then run it:

```bash
curl -L -O https://raw.githubusercontent.com/thingery/thingery/main/examples/quickstart/quickstart.mjs
export THINGERY_API_KEY=thg_YOUR_KEY   # paste your own key
node quickstart.mjs
```

Expected output (abridged):

```text
1. describe_category('sneakers') → declared attribute keys: size_eu, colorway, has_original_box
2. search_items(q='sneakers') → N result(s)
   - <title> — <price> EUR (<item id>)
3. create_listing → <uuid>
   visible: false (photo_required: true) — listings are hidden until the first photo is added
4. add_item_image → image at https://thingery.dev/img/items/<uuid>-<suffix>.png
   visible now: true — the listing is live in search
5. get_item → needs_photo: false, url: https://thingery.dev/item/<uuid>
6. fetch(https://thingery.dev/item/<uuid>) → HTTP 200 (public page renders)
7. update_listing(status='deleted') → listing status: deleted (removed from search)
```

The script **deletes the demo listing again by default** so repeated runs leave nothing
behind. Pass `--keep` if you want to keep it and show it around.

Run it without a key to see just the public (search) steps and instructions.

## What just happened

- Steps 1–2 are **public** — no credential needed (`describe_category`, `search_items`).
- Steps 3–7 are **seller** calls, authenticated with `Authorization: Bearer thg_...`.
- `create_listing` succeeded while `visible: false` — listings are hidden from search
  until they have at least one photo. Step 4 attaches one and the listing goes live in
  the same run; that's the photo-required publishing rule (ADR 0005).
- Prices are **integer cents**: `5000` = EUR 50.00.

## Point it at your own server

Self-hosting already? Set `MCP_URL` and the same script runs against your instance:

```bash
MCP_URL=http://localhost:3000/mcp THINGERY_API_KEY=thg_YOUR_KEY node quickstart.mjs
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `HTTP 401` on steps 3+ | Key wrong or rotated — check `THINGERY_API_KEY`; the key is only shown at signup/rotation |
| `HTTP 405` | `/mcp` is POST-only; you probably GET'ed it. POST JSON-RPC like the script does |
| `HTTP 406` | Missing the `Accept: application/json, text/event-stream` header |
| Responses look like `event: message` / `data: {...}` | That's Server-Sent Events — the JSON-RPC result is on the `data:` line (the script parses it) |
| Listing created but not in search | No photo yet — `add_item_image` publishes it |
| `HTTP 429` | Rate limit (10 signups per IP per hour; per-seller write caps) — wait a bit and retry |

More: [docs/integrations.md → Troubleshooting](../../docs/integrations.md#troubleshooting).

## Next steps

- Client configs (Claude Desktop, Cursor, VS Code, Inspector, curl): [docs/integrations.md](../../docs/integrations.md)
- Framework examples (LangChain, LlamaIndex, Composio): [examples/integrations/](../integrations/)
- Buying workflow + order tools: the README's [Order flow](../../README.md#order-flow) section
