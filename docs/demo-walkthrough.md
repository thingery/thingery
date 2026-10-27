# Thingery end-to-end demo — technical walkthrough

The companion to [`scripts/demo-e2e.sh`](../scripts/demo-e2e.sh): one
reproducible run where **an AI agent lists a photo'd item end to end, a
completely separate anonymous buyer query finds it, and the public item page
is live** — with no human touching the UI at any point.

Two artifacts ship from this flow:

| Artifact | What it is | How it's made |
| --- | --- | --- |
| 45–60 s capture | 57 s terminal replay, 1600×900 MP4 | `scripts/render-demo-video.py` renders the saved summary of a **real** `demo-e2e.sh` run (`scripts/demo-capture-summary.json`) |
| This walkthrough | long-form technical version | the doc you are reading |

Everything in the capture comes from the saved production run — item id,
image URL, PASS lines. Nothing is mocked; re-running the two scripts against
a fresh run regenerates both.

## 1. What the demo proves

Thingery is the open item database and MCP server for AI agents to
list, find, and trade second-hand goods. The shorter pitch: *a marketplace
an AI agent can run end to end.* The demo proves the three claims that
make that true today:

1. **An agent can onboard itself — zero to a published listing in under a
   minute.** `POST /api/signup` hands back a `thg_…`
   seller API key. No human account setup, no UI.
2. **The marketplace enforces quality without a human moderator.** A listing
   without a photo is created but **hidden** (`needs_photo: true`,
   `visible: false`). Photo-gated publishing (THI-308) means search never
   shows a photo-less item — the gate is server-side, so it binds agents and
   humans alike.
3. **Discovery is open.** `search_items` works **anonymously** — the buyer
   calls in the demo carry no credentials at all. Any agent (or curl) can
   query the inventory, and the result links to a public, shareable item
   page.

## 2. The flow, call by call

All MCP calls go to `https://thingery.dev/mcp` (stateless streamable-HTTP;
the same server `npx thingery` self-hosters get). Seller calls carry
`Authorization: Bearer thg_…`; buyer calls carry nothing.

### Step 0 — the deployment is real

```bash
curl -s https://thingery.dev/healthz
# {"ok":true,"service":"thingery","version":"0.1.2","commit":"99fb9e7…"}
```

### Step 1 — agent onboarding

```bash
curl -s -X POST https://thingery.dev/api/signup -H 'Content-Type: application/json' \
  -d '{"email":"demo-…@example.test","password":"…","name":"Demo Seller"}'
# → { "seller": { "api_key": "thg_…" } }
```

### Step 2 — schema discovery

Agents don't hardcode categories; they ask the marketplace what a listing
needs:

```jsonc
// tools/call describe_category {"category":"sneakers"}
{ "category": { "name": "sneakers",
    "attribute_definitions": [
      { "key": "size_eu", "type": "number", "required": true },
      { "key": "colorway", "type": "string" },
      { "key": "has_original_box", "type": "boolean" } ] } }
```

### Step 3 — create the listing (no photo yet)

```jsonc
// tools/call create_listing { "title":"Nike Air Max 90 Infrared, EU 44",
//   "category":"sneakers", "condition":"like_new", "price_cents":9500,
//   "attributes":{"size_eu":44} }
{ "created": true, "photo_required": true,
  "item": { "id":"158b5028-…", "needs_photo": true, "status":"active" },
  "visible": false,
  "next_steps": ["The listing is hidden from search until it has at least one
     photo — add one with the add_item_image tool (the first photo publishes it)"] }
```

Note the shape: `status` is `active`, but `visible` is `false`. Publishing is
gated on media, not on a moderation queue — the item is one photo away from
the feed.

### Step 4 — anonymous buyer can NOT find it yet

```jsonc
// tools/call search_items {"q":"air max 90 infrared","attributes":{"size_eu":44}}
// → result list does not contain the item — the photo gate holds
```

### Step 5 — the photo that publishes

The agent sends the photo inline as a data URI (≤ 5 MB, jpeg/png/webp; the
server re-encodes and stores it):

```jsonc
// tools/call add_item_image { "item_id":"158b5028-…",
//   "image_base64":"data:image/jpeg;base64,…", "media_type":"image/jpeg" }
{ "added": true, "visible": true,
  "image_url":"https://thingery.dev/img/items/158b5028-…-mvr1tr9u.jpg" }
```

`visible` flips to `true` **on this call** — first photo publishes.

### Step 6 — same anonymous buyer query, now finds it

```jsonc
// tools/call search_items {"q":"air max 90 infrared","attributes":{"size_eu":44}}
// → the item is in .results[] with matching title
```

### Step 7 — the public item page

```
GET https://thingery.dev/item/158b5028-1d85-4080-8e83-d3da5fe54df9
200 OK · <title>Nike Air Max 90 Infrared, EU 44 …</title> · og:image present
```

Shareable immediately — OG tags mean chat/social previews render the photo.

### Cleanup (ops policy)

Per the ops smoke-test policy ([`docs/ops-smoke-policy.md`](ops-smoke-policy.md),
THI-388) the script marks the listing `reserved` before exiting so
production search stays clean; the page stays up for verification. `KEEP=1`
leaves it active.

## 3. Reproduce it

```bash
git clone https://github.com/thingery/thingery && cd thingery
scripts/demo-e2e.sh                     # against prod; 17 checks, exit 0
BASE_URL=http://localhost:3000 scripts/demo-e2e.sh   # or your own deploy
```

Env overrides: `SELLER_API_KEY` (reuse a key; signup is rate-limited 10/h per
IP), `DEMO_PHOTO` (any <5 MB jpeg/png/webp), `KEEP`, `BASE_URL`.

Refresh the capture after a new run:

```bash
python3 scripts/render-demo-video.py    # → scripts/demo-capture.mp4 (57 s)
```

(Save the new run's values into `scripts/demo-capture-summary.json` first;
`gen-demo-photo.py` regenerates the deterministic demo photo if needed.)

## 4. Narration scripts

### Short capture (57 s) — beat sheet

| Time | On screen | Narration |
| --- | --- | --- |
| 0:00–0:04 | title card | "Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods." |
| 0:04–0:10 | `demo-e2e.sh`, signup | "Zero to a published listing in under a minute, no human touching anything. One script drives the whole flow over MCP — the agent signs itself up and gets an API key." |
| 0:10–0:16 | `describe_category` | "It asks the marketplace what a sneaker listing needs." |
| 0:16–0:24 | `create_listing` | "It lists a pair of Air Max 90s — and Thingery says: created, but hidden until it has a photo." |
| 0:24–0:30 | anonymous search #1 | "A separate buyer asks — anonymously. Nothing. The photo gate holds." |
| 0:30–0:38 | `add_item_image` | "The agent attaches a photo — that's the moment it publishes." |
| 0:38–0:46 | anonymous search #2 | "Same anonymous query — now it finds them, size 44." |
| 0:46–0:57 | public page + endcard | "And anyone can open the public page. Listing, discovery, purchase surface — all agent-reachable, all scriptable, all Apache-2.0." |

### Long walkthrough (~3 min) — outline

1. **(30 s)** The problem: agent-driven commerce needs a marketplace agents
   can actually operate — onboard, list, discover, transact — not a UI they
   have to scrape.
2. **(45 s)** Architecture: one Express app serves the website, the public
   REST-ish surface, and the MCP endpoint at `/mcp`; Postgres holds items;
   photos are re-encoded and served from `/img/items/…`. Self-hosters get the
   identical server from npm (`npx thingery`).
3. **(60 s)** Walk the seven steps from §2 live, showing the raw JSON for
   `create_listing` → `needs_photo` and `add_item_image` → `visible:true`.
   Emphasize: the gate is server-side state, not prompt politeness.
4. **(30 s)** Show the item page in a browser: photo, price, OG preview.
5. **(15 s)** Close: the whole run is `scripts/demo-e2e.sh`, Apache-2.0 —
   viewers can reproduce it against their own deploy in minutes.

## 5. Verification record

- 2026-10-27, prod `99fb9e7` (v0.1.2): `demo-e2e.sh` → **17 passed, 0
  failed**; item `158b5028-1d85-4080-8e83-d3da5fe54df9`; capture rendered
  from that run's summary (57 s / 1600×900 / 1.5 MB).
