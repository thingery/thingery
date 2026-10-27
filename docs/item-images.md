# Item photos — owner API and publishing rule

How photos attach to listings, and the rule that ties photos to visibility.
The audience is item-page/UI integrators and self-hosters; agents should use
the MCP tools (`create_listing` images, `add_item_image`) instead of these
session-cookie routes.

## Photo-required publishing

New listings need **at least one photo** to appear anywhere buyers look:
browse, `search_items`, and category counts. The rule is a single derived
predicate ([ADR 0005](adr/0005-photo-gated-visibility.md)):

```
visible_in_feeds = status = 'active' AND (NOT photo_required OR images ≠ [])
```

- `create_listing` (or the chat assistant) with **zero images succeeds** — the
  listing is created but **pending**: hidden from all feeds, its item page
  renders placeholder art and is `noindex`. The MCP result says so via
  `photo_required`, `visible: false`, and `next_steps`.
- **The first photo publishes it** — `add_item_image` (MCP) or the item-page
  upload below both flip it live; no second call is needed. `add_item_image`
  returns `visible: true` when it does, and every item object carries
  `needs_photo: true` while pending.
- **Deleting the last photo returns the listing to pending** (hidden again).
  The item page warns before allowing it; the delete response repeats the
  warning.
- **Pre-existing listings are grandfathered** — whatever existed when the deployment first
  ran this schema stays live with or without photos (on thingery.dev: created before
  2026-10-27).
- `get_item` and `my_listings` always return pending listings (with
  `needs_photo: true`); only feed surfaces filter them.

## Owner routes (session cookie auth)

All three routes require the item's owner to be signed in (`401` otherwise)
and address the item by UUID. They are what the item page's photo panel uses.

### `POST /api/items/:id/images` — upload

Raw image bytes as the request body with an image `Content-Type`
(jpeg/png/webp/gif; ≤ 5 MB). Images are re-encoded server-side: metadata
(EXIF/GPS/XMP) stripped, orientation baked in, downscaled to ≤ 2000 px;
animated GIFs stored as stills. Up to 12 images per item.

- `200` → `{ "url": "/img/items/{filename}" }`
- `400` → `{ "error": "…" }` (not an image, too large, cap reached, …)
- `429` → `{ "error": "Too many uploads — try again later." }`

### `DELETE /api/items/:id/images/:filename` — delete one photo

`filename` is the stored file name (the part after `/img/items/`) — or a full
external `http(s)://…` URL member, which is removed from the listing without
touching any file. The member must match an `images[]` entry exactly; stored
names are basename-checked (anything containing `/`, `\`, or `..` is
rejected).

- `200` → `{ "images": [...], "visible": true|false }` — the remaining array
  and post-delete feed visibility. If you just deleted the last photo of a
  photo-required listing, `visible` is `false` and the response also carries
  `{ "warning": "This listing is hidden from search until you add a photo." }`
- `400` → `{ "error": "Invalid photo reference." }` (bad filename shape)
- `401` → `{ "error": "Log in to manage photos." }`
- `404` → `{ "error": "Item not found or not owned by this seller." }` — the
  same fixed string whether the item, the ownership, or the membership failed
  (no enumeration oracle)
- `429` → `{ "error": "Too many photo changes — try again later." }`

The removal is one atomic statement — a photo uploaded concurrently is never
lost to a read-modify-write race. Deleting a server-stored file from disk is
best-effort after the row update; the `images` array is the source of truth.

### `PUT /api/items/:id/images/order` — reorder photos

Body: `{ "images": [...] }` — the **exact same set** of image references the
listing currently has, in the new order (first entry = cover photo). Partial
sets, duplicates, or foreign references are rejected; reorder can never add
or remove a photo. Array ≤ 12, elements ≤ 500 chars.

- `200` → `{ "images": [...] }` — the new order. Replaying the same body is a
  safe no-op.
- `400` → `{ "error": "Send images as an array of up to 12 photo references." }`
  (bad shape) or `{ "error": "Photos must be the exact same set as the current ones." }`
- `401` / `404` → same fixed strings as DELETE
- `409` → `{ "error": "Photos changed since the page loaded — showing the current set.", "images": [...] }`
  — the array changed between your read and this write; re-render from the
  returned current set and retry
- `429` → same as DELETE

## Rate limits

Delete and reorder share their own bucket — **60 mutations per seller per
hour** — separate from the upload quotas (30 uploads/seller/hour, 120
attempts/IP/hour), so reordering can never eat upload headroom. Every 429 is
logged server-side as a `rate_limit` security event.
