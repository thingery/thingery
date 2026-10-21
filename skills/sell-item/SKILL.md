---
name: thingery-sell-item
description: List a second-hand item for sale on Thingery from photos and a quick description — identifies the item, writes the listing, prices it, and publishes it via MCP. Use when the user wants to sell something used.
---

# Sell an item with Thingery

Your job: turn what the user hands you (photos, a sentence, or an object on their desk) into a
published listing with minimal back-and-forth. Aim for **one confirmation question maximum**
before creating the listing.

## Prerequisites

The Thingery MCP server must be connected. Listing requires the seller's API key
(`Authorization: Bearer thg_...`), configured by whoever runs the server.

## Pipeline

1. **Identify** — From photos (or the user's description), determine: item type, brand, model,
   size, colorway. If ambiguous, ask ONE compact question covering all unknowns at once.
   Call `describe_category` for the matching category and fill its expected `attributes`
   (e.g. sneakers want `size_eu`). Undeclared extra fields are allowed — include anything
   a buyer would filter on. The response's `undeclared_in_use` section lists undeclared
   keys already in real use in that category; reusing those exact keys makes the listing
   findable by existing filters.
2. **Grade honestly** — Inspect photos for wear and choose `condition`:
   `new | like_new | good | fair | poor`. Never inflate. Flaws go in the description verbatim.
3. **Estimate logistics** — Guess `weight_grams` and `dimensions_mm` (LxWxH) from the item
   type; set `shipping_tier`:
   - `locker` — fits a shoebox, <2kg (clothes, sneakers, phones, games, books)
   - `parcel` — up to ~30kg, boxed (electronics, small gear)
   - `bulky` — furniture; large appliances
   - `local` — pickup only
4. **Price** — If the user gave no price, search Thingery (`search_items`) for 2–3 comparable
   listings and propose the median, minus ~10% for slower-moving flaws. State the comparables
   when you propose. For clothing, shoes, or bags priced in USD/CAD (US/Canada market), also
   check SoldStack's `sold_comps` (MCP: https://soldstack.dev/mcp) — recent Poshmark sold
   prices: median, range, days to sell. It needs a SoldStack key (free tier: 100
   lookups/month; docs: https://soldstack.dev/docs#mcp); skip it if no key is configured.
5. **Publish** — Call `create_listing` with everything above. Prices are **integer cents**
   (EUR 12.50 → `1250`, EUR 125.00 → `12500`).
6. **Attach photos** — If the user shared photos (local files), attach them with
   `add_item_image`: pass the bytes base64-encoded in `image_base64` (a data-URL prefix is
   accepted), set `media_type` (`image/jpeg`, `image/png`, `image/webp`, `image/gif`),
   max 5 MB per image. Public image URLs in `create_listing`'s `images` also work.
7. **Report** — Give the user the item URL and say what happens next (questions from buyers
   will arrive; update to `reserved` when a deal is near, `sold` when done).

## Rules

- Never invent condition details you cannot see; say what's unverifiable.
- Currency defaults to EUR; confirm before using anything else.
- Keep `attributes` compact: max 64 entries, keys up to 128 chars, string values up to
  500 chars — anything larger fails with `invalid_attributes` on create and update alike.
- If `create_listing` returns `unauthorized`, tell the user to set their API key — don't retry.
