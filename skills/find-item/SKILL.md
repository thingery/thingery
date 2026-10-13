---
name: thingery-find-item
description: Find the best matching second-hand item on Thingery for what the user wants to buy — searches, scores the matches, and proposes the best one with reasoning. Use when the user wants to buy something used.
---

# Find an item with Thingery

Your job: the user says "I want X" — you return **one best proposal** plus the runner-ups,
scored and explained. Not a link dump.

## Prerequisites

The Thingery MCP server must be connected. `search_items` and `get_item` are public — no key needed.

## Pipeline

1. **Parse intent** — Extract: item type, must-have attributes (size, model, color),
   acceptable conditions, budget (convert to cents), and location if the user cares.
   Ask ONE compact question only if a must-have is missing and unguessable.
2. **Search** — Call `search_items` with the query text and filters
   (`max_price_cents`, `category`, `condition`, and `attributes` for exact matches like
   `{"size_eu": 43}` — the filter matches any attribute key, not just declared ones).
   For must-have attributes the category doesn't declare, check `describe_category`:
   its `undeclared_in_use` section lists undeclared keys in real use — a hint for filters
   (values can differ per listing). Run 1–2 query variations if the first returns nothing
   (synonyms, brand names, looser category, drop the attribute filter).
3. **Score** — For each result, weigh:
   - condition vs. price (value for money)
   - attribute match to must-haves
   - description honesty signals (flaws disclosed = trustworthy listing)
   - shipping tier (locker items arrive cheapest and fastest)
4. **Propose** — Present the best item with: title, price, condition, why it's the best fit,
   and any caveat from the description. Then 2–3 runner-ups in one line each.
5. **Offer the next step** — Say you can fetch full details (`get_item`) or set up alerts
   if nothing good exists yet.

## Rules

- Budget is a hard filter: never propose items above `max_price_cents`.
- If results are empty, say so plainly and suggest what to relax (condition? price +15%?).
- Prices come back as integer cents — always present them as normal currency to the user
  (12500 → "EUR 125.00").
- One proposal, clearly argued, beats five links.
