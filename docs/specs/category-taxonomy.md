# Spec: category taxonomy rework — two-level tree + facet attributes

- **Status:** Draft — pending Security review + CEO sign-off (protected paths `db/schema.sql`, `src/tools.ts`; repo `AGENTS.md` rule 2, board THI-36). Implementation children stay blocked until both verdicts are recorded in this PR.
- **Date:** 2026-11-13
- **Origin:** [GitHub issue #218](https://github.com/thingery/thingery/issues/218) (fedealconda), tracked as THI-733; plan rev `26b773eb`. Spec task THI-734.
- **Touches (protected):** `db/schema.sql`, `src/tools.ts`.
- **Touches (unprotected):** `src/items.ts`, `src/wanted.ts`, `src/intents.ts`, `src/chat.ts`, new `src/categories.ts`, `public/llms.txt`, `skills/`, `docs-site/`, `README.md`, tests.
- **Does not touch:** `src/auth.ts`, `src/routes.ts`, any item/wanted/intent row.

## 1. Problem

The category registry is a flat list of 14 slugs (`db/schema.sql` seed — the issue says 15 but lists 14; the seed has 14). As GH #218 documents:

1. **Fashion has no department facet.** No women/men/kids split exists even as an attribute, and `clothing.size` is free text ("M", "42", "One Size"), so size filters are unreliable. Bags, jewellery and watches all collapse into `clothing`.
2. **Overlapping categories make agents classify inconsistently.** `sneakers` vs `shoes`; `games` (video games) vs `toys` ("Toys and games"); `electronics` vs `phones`/`computers` — siblings, so filtering on `electronics` misses every phone; `music` mixes instruments with vinyl and CDs.
3. **Large second-hand segments fall into `other`.** Kids/baby gear (pushchairs, car seats), bags, beauty, pet care, bikes, cameras, garden/DIY tools. Once `other` grows, the category filter stops discriminating.
4. **Marketplace imports lose detail.** Mapping a deep external tree (Vinted: 3,081 categories, 9 departments; eBay similarly) onto 14 buckets collapses distinctions — women's, men's and kids' boots all become `shoes` (importer notes on #218).

Secondary latent bug: the categories seed uses `ON CONFLICT (name) DO NOTHING`, so shipped description/attribute-definition edits **never apply** to an existing database. The registry has no admin write path, so schema.sql is de facto the source of truth — but a non-converging one.

## 2. Context

- **Sellers are mostly agents.** With hundreds of leaves, two agents put the same item in different leaves and buyers' leaf filters miss listings. Vinted-style depth works for humans picking from menus; it works against us. We deliberately do **not** mirror Vinted's tree (also: its names are locale-translated, only IDs are stable; its depth is really facets; it is fashion-heavy; and it would tie the public schema to another platform's taxonomy).
- **Registry mechanics today.** `categories(name PK, description, attribute_definitions JSONB, created_at)`; `items.category` / `wanted_items.category` / `buyer_intents.category` are plain `TEXT` columns with **no FK** to `categories` — validation is at write time (`getCategory()` in `src/items.ts` for `create_listing`/`save_intent`; a direct query in `src/wanted.ts:211` for wanteds; `src/chat.ts` mirrors both). Reads filter `category = $x` exact-match (`searchItems`, `searchWanted`); intent matching uses `bi.category IS NULL OR bi.category = $2` (`src/intents.ts:358`).
- **Attributes are flexible by design.** `attribute_definitions` (key/type/enum/required/unit/description) validate declared keys on write; undeclared keys pass through; search filters match any key. `AttributeDefinition` already supports enums — the new facets need **no validation-code change**.
- **Schema application.** `scripts/migrate.ts` applies `db/schema.sql` wholesale at deploy (`npm run db:migrate`, DevOps runbook). Everything in schema.sql is already idempotent (`IF NOT EXISTS`, `ON CONFLICT`); this spec keeps that property.
- **No admin writes to `categories` exist.** Making the seed converge (D7) cannot clobber runtime state; the only current writers are the seed itself and hand-edits on self-hosted instances (documented behavior change, §8).
- **API evolution constraint.** All 14 slugs are public API surface used by registry-listed MCP installs, npm self-hosters, and live sessions on thingery.dev. No slug may be renamed, repurposed, or deleted.

## 3. Design decisions (D1–D9, from plan rev 26b773eb)

**D1 — Strict two levels; departments stay assignable.** `categories.parent TEXT NULL REFERENCES categories(name)`. 8 departments over 21 leaves. Departments remain valid assignment targets: a department assignment means "leaf unspecified". Every existing item (all `category='electronics'` etc.) keeps working unchanged. The #218 tension "make `sneakers` a child of `shoes`" is resolved by keeping them sibling leaves under `fashion`; classification consistency is attacked with descriptions + aliases (D4), not depth.

**D2 — Parent filter = department + direct children.** A department slug in `search_items`/`search_wanted` expands to `category IN (dept, children)` — one level, no recursion (two-level invariant). Departments become valid filter values (additive: today they are `unknown_category`).

**D3 — All 14 existing slugs survive unchanged.** No rename, repurpose, or delete. New leaves are additive. `music` stays as a legacy mixed leaf with a clarified description ("recorded music") while new instrument listings are steered to `instruments` (hobbies); existing `music` rows are untouched.

**D4 — Slug aliases.** `categories.aliases TEXT[] NOT NULL DEFAULT '{}'`. Create/search/describe paths accept an alias, resolve to canonical, and the write response reports the canonical slug. Kills the largest classification inconsistency cheaply.

**D5 — `describe_category` on a department returns both**: its own row (description + attribute definitions — departments are assignable, so their own definitions matter) **plus** a `children` array with per-child listing counts. No-arg listing stays flat; each row gains a `parent` field.

**D6 — Facets as attributes, expand-contract.** Optional `department` enum `[women|men|unisex|kids]` on fashion categories; typed sizes are **new keys** alongside legacy `size` (which stays accepted and searchable): `size_letter` enum `[XS,S,M,L,XL,XXL]` on clothing; numeric `size_eu` already exists on footwear. Nothing any existing agent sends becomes invalid.

**D7 — Registry as code (seed converges).** The seed switches from `ON CONFLICT (name) DO NOTHING` to `DO UPDATE SET description, attribute_definitions, parent, aliases`. schema.sql becomes the converging source of truth; `scripts/migrate.ts` unchanged (applies wholesale). Fixes the latent no-convergence bug. `created_at` is never touched.

**D8 — Zero item-row migration.** No `items`/`wanted_items`/`buyer_intents` row is read or written by the migration. Only data changes: new category rows (INSERT) and `parent`/`aliases` convergence on existing rows (idempotent UPDATE via D7). Optional Phase-3 quality backfill (Appendix B) is a separate, later, non-blocking decision.

**D9 — Importer mapping stays in `thingery/platform`** (per #218 point 4). Core-repo conventions for importers: auto-fill `department` when the source has it (Vinted's top level maps 1:1); record the source's own leaf name under the shared passthrough key `source_category` (undeclared key — passes through today, becomes a documented convention in llms.txt; no schema change). Platform-side work (mapping extension, department autofill, browse-UI tree) is the private-repo follow-up task THI-738.

### Decisions requested from this review (was: open questions)

1. **`games` under `electronics` — proposed: yes, keep.** The existing `platform` enum (`nintendo_switch`, `ps5`, …) is console-shaped; `games` means video games and consoles. Tabletop moves to a new `board-games` leaf under `hobbies`; `toys` (kids) description points there. Moving `games` under `hobbies`/`media` would repurpose an existing slug's semantics (API evolution lens) for zero compat benefit.
2. **Alias seed set — proposed initial 9 aliases on 6 rows** (§5.3): `trainers→sneakers`; `stroller, pram→baby`; `jewelry→accessories`; `smartphone→phones`; `laptop→computers`; `vinyl, records→music`. Additive to extend later; each addition is a schema.sql line.
3. **`save_intent` department expansion — proposed: yes.** Intents store the canonical slug (aliases resolved at save); `my_matches` matching expands the *item's* category to its closure `{leaf, parent?}` (§5.6). One expansion code path for search and matching.
4. **Google Product Taxonomy — proposed: not used.** Our slugs are generic plain-English terms independently chosen; nothing is copied from GPT, so there is no license exposure to verify. (Docs spot-checks the final seed for accidental verbatim overlap.)
5. **ROADMAP item 11** (allow `category` change in `update_listing`): **out of scope** here. Aliases + departments make it more attractive as a fast follow-up; noted on the roadmap, not this spec.

## 4. Proposed design — data model

### 4.1 Schema changes (`db/schema.sql`, protected)

```sql
-- Two-level taxonomy (spec THI-734 / GH #218): departments (parent NULL) over
-- leaves (parent = department name). Departments are assignable — parent NULL
-- means "valid category in its own right, top of tree". 'other' is parentless
-- and childless (fallback leaf-dept). FK guarantees a parent exists; the
-- two-level invariant (a parent's parent is always NULL) is enforced by the
-- seed order and asserted by tests — no trigger (Simplicity: registry is
-- code-owned, no runtime writer exists).
ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent TEXT REFERENCES categories(name);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS aliases TEXT[] NOT NULL DEFAULT '{}';
```

- Self-FK validated once against 14 existing rows (all parents NULL at ALTER time — trivially passes). Departments are inserted/updated **before** leaves in the multi-row seed so per-row FK checks succeed in one statement.
- `ON DELETE` defaults to `NO ACTION` — category deletion is not a supported operation (registry is additive; any future contraction is its own expand-contract decision).
- No index on `parent` or `aliases`: the registry is ~29 rows and read via PK/seq scan; expansion is one tiny query (Simplicity).

### 4.2 Seed switch (D7)

```sql
INSERT INTO categories (name, description, attribute_definitions, parent, aliases) VALUES
  (... 29 rows, departments first ...)
ON CONFLICT (name) DO UPDATE SET
  description          = EXCLUDED.description,
  attribute_definitions = EXCLUDED.attribute_definitions,
  parent               = EXCLUDED.parent,
  aliases              = EXCLUDED.aliases;
```

Idempotent and converging: re-running (or deploying) always yields the schema.sql registry. `created_at` untouched. PR 1 ships the mechanical switch with the current 14 rows (parent NULL, aliases `'{}'`); PR 2 ships the 29-row content. Between the two deploys the new columns exist but are unused by old content — inert (expand-contract).

## 5. Proposed design — taxonomy content and tool semantics

### 5.1 Registry (29 rows: 8 departments + 21 leaves)

† = existing slug, unchanged name. Attribute definitions listed are the *declared* set; undeclared keys keep passing through.

| Slug | Parent | New? | Description | Declared attributes |
|---|---|---|---|---|
| `fashion` | — | new | Clothing, footwear, bags, accessories, beauty (leaf unspecified) | `department` enum [women,men,unisex,kids] |
| `clothing`† | fashion | | Clothes; sizes: size_letter or free-text size | `size` (req), `size_letter` enum [XS,S,M,L,XL,XXL], `material`, `color`, `department` |
| `shoes`† | fashion | | Non-sneaker footwear | `size_eu` (req, number), `material`, `department` |
| `sneakers`† | fashion | | Trainers and sneakers | `size_eu` (req, number), `colorway`, `has_original_box` (bool), `department` |
| `bags` | fashion | new | Handbags, backpacks, luggage | `material`, `color`, `department` |
| `accessories` | fashion | new | Jewellery, watches, belts, sunglasses, scarves | `type` enum [jewellery,watch,belt,sunglasses,scarf,other], `department` |
| `beauty` | fashion | new | Makeup, skincare, fragrance | `type` enum [makeup,skincare,fragrance,haircare,other] |
| `kids` | — | new | Baby and kids: gear, clothing, toys (leaf unspecified) | — |
| `baby` | kids | new | Pushchairs, car seats, nursery | `type` enum [pushchair,car_seat,nursery,other] |
| `kids-clothing` | kids | new | Children's clothing; size in years or height (e.g. 6Y, 104) | `size` (req), `color` |
| `toys`† | kids | | Toys and playthings (tabletop games → board-games) | `age_range` |
| `electronics`† | — | | Consumer electronics (misc; see phones, computers, cameras, games) | `model`, `warranty_months` (number) |
| `phones`† | electronics | | Mobile phones | `model` (req), `storage_gb`, `battery_health_pct` |
| `computers`† | electronics | | Laptops and desktops | `model` (req), `ram_gb`, `storage_gb` |
| `cameras` | electronics | new | Cameras, lenses, drones | `model`, `shutter_count` (number) |
| `games`† | electronics | | Video games and consoles (tabletop → board-games) | `platform` enum (unchanged, req) |
| `home`† | — | | Furniture and household (incl. appliances; DIY/garden → tools) | `material`, `color` |
| `tools` | home | new | DIY, power tools, garden | `type` enum [power,hand,garden,other] |
| `pets` | home | new | Pet supplies: beds, carriers, aquariums | `type` enum [dog,cat,bird,small_animal,aquarium,other] |
| `media` | — | new | Books and recorded media (leaf unspecified) | — |
| `books`† | media | | Books and magazines | `author`, `isbn`, `language` |
| `music`† | media | | Recorded music: vinyl, CDs, cassettes (instruments → hobbies) | `format` enum [vinyl,cd,cassette,instrument,other] (unchanged), `artist` |
| `hobbies` | — | new | Collectibles, tabletop games, instruments (leaf unspecified) | — |
| `collectibles`† | hobbies | | Collectibles and memorabilia | `franchise` |
| `board-games` | hobbies | new | Tabletop and board games | `players` (e.g. "2-4"), `language` |
| `instruments` | hobbies | new | Musical instruments and gear | `instrument` (req) |
| `sports`† | — | | Sports and outdoor gear (bikes → bikes) | `sport` |
| `bikes` | sports | new | Bicycles: road, MTB, city, e-bikes | `type` enum [road,mtb,city,bmx,ebike,kids,other], `frame_size`, `wheel_size_inches` (number) |
| `other`† | — | | Everything else (fallback) | — |

Facet placement rationale (Simplicity): `department` only where a gender split is a real second-hand query axis (the five fashion leaves + the `fashion` dept itself, since it is assignable). `beauty` and `kids-clothing` skip it (kids is already the department; beauty has no meaningful split here). `size_letter` only on `clothing` — kids sizing is age/height-based, footwear already has numeric `size_eu`. `music`'s `format` enum keeps `instrument` as a valid value so existing rows stay valid; its description steers new listings to `instruments`.

### 5.2 New module `src/categories.ts` (single source of resolution/expansion)

Leaf module (imports only `db.js`), imported by `items.ts`, `wanted.ts`, `intents.ts`, `tools.ts`, `chat.ts` — one code path everywhere:

- `resolveCategory(raw: string): Promise<{ canonical: string; viaAlias: boolean } | null>` — lowercases; exact `name` match wins, else first `aliases @> ARRAY[$1]` row, else `null`. Deterministic precedence, documented.
- `categoryFilterNames(canonical: string): Promise<string[]>` — `SELECT name FROM categories WHERE name = $1 OR parent = $1` → `[dept, ...children]` for a department, `[leaf]` otherwise.
- `categoryClosureForItem(category: string): Promise<string[]>` — `[leaf, parent]` (intent matching, §5.6).
- `listCategoriesWithParents()`, `categoryChildren(dept)` — describe_category surfaces, reusing the existing `FEED_VISIBLE` feed-visibility predicate for listing counts.

Invariants asserted by tests (not triggers): every parent exists (FK), every parent's parent is NULL (two-level), no alias equals any canonical name, no alias appears in two rows, `other` is parentless.

### 5.3 Alias seed (D4)

| Canonical | Aliases |
|---|---|
| `sneakers` | `trainers` |
| `baby` | `stroller`, `pram` |
| `accessories` | `jewelry` |
| `phones` | `smartphone` |
| `computers` | `laptop` |
| `music` | `vinyl`, `records` |

Rules: aliases are lowercase; an alias never shadows a canonical name (exact match wins); one alias maps to exactly one canonical. Input case is normalized before resolution (existing `.toLowerCase()` behavior).

### 5.4 Resolution/expansion semantics (explicit — no undefined behavior)

Every category-accepting input follows the same table:

| Input | Write paths (create_listing, create_wanted, update_wanted, save_intent) | Read paths (search_items, search_wanted, describe_category) |
|---|---|---|
| canonical leaf | accepted, stored as-is | leaf filters itself; describe returns leaf |
| canonical department | accepted, stored as-is ("leaf unspecified") | filters `IN (dept, children)`; describe returns dept + children |
| alias | resolved → canonical stored; response note names the resolution | resolved → canonical, then expanded; describe returns canonical + note |
| unknown | `unknown_category` error (unchanged shape; available list now names all registry rows incl. departments) | same |

Intent matching (item-publish evaluation): intent category matches iff `bi.category IS NULL OR bi.category = ANY(item_closure)` where `item_closure = {item.category} ∪ {parent(item.category)}`. So a `fashion` intent matches a `sneakers` listing; a `sneakers` intent never matches a `fashion`-assigned listing (an unspecified-leaf item is not known to be sneakers). No other transitions exist; nothing about this is best-effort.

### 5.5 MCP tool changes (`src/tools.ts`, protected) — all additive

No tool signature changes; no input schema changes except descriptions. Existing outputs gain fields; no field is removed or retyped.

- **`describe_category`**
  - no-arg: `categories[]` rows gain `parent` (null for departments/`other`). Ordering unchanged (listing_count DESC, name ASC).
  - leaf arg: unchanged shape; `category` object gains `parent`.
  - department arg: `category` = own row (parent null) **plus** `children: [{name, description, listing_count}]` (same ordering rule; counts use the feed-visibility predicate). Note sentence extended to explain departments-as-categories and child filtering.
  - alias arg: resolves to canonical; output shape follows the canonical; note reports `"category 'trainers' resolved to canonical slug 'sneakers'"`.
- **`create_listing` / `create_wanted` / `update_wanted` / `save_intent`**: category resolves per §5.4; when an alias was resolved the response gains a `note` naming the canonical slug (stored `category` field is always canonical). Departments are accepted as categories (they are registry rows). Error semantics unchanged.
- **`search_items` / `search_wanted`**: `category` resolves and expands; the WHERE clause becomes `category = ANY($n::text[])` (parameterized array). Tool descriptions updated to document departments and aliases. Unknown → `unknown_category` unchanged.
- **`chat.ts`** (listing-flow parity, THI-83 §8/F3): `describe_category` and the create flow mirror the same shapes and resolution (parity test extended).

### 5.6 Blast radius (named)

- **Registry-listed MCP installs + live sessions:** additive output fields only; strict JSON parsers that reject unknown fields could break — accepted risk, consistent with every prior additive output change; nothing existing is removed or retyped.
- **npm self-hosters:** next `db:migrate` run converges their registry to schema.sql, overwriting any hand-edited `categories` rows. Documented behavior change (registry is code-owned; no admin write path exists to lose). Old images against the new schema: fully compatible (new columns unread, new rows behave as plain categories).
- **thingery.dev:** `/browse` and home search inherit dept expansion via `searchItems`. The browse-UI tree itself is the platform-repo follow-up (THI-738); the public repo's frozen `website/` is untouched (board ruling THI-565).
- **Importers (platform):** gain 15 finer mapping targets + `department` autofill + `source_category` convention (D9). THI-618 (silent `other` in review flow) is independent and fixes now.

Security lens: no new auth surface; category and alias values remain fully parameterized (`= ANY($n)`, `@> ARRAY[$n]`); input length caps unchanged (category 2–40 chars, aliases ≤ 40); alias scan is one query over a ~29-row table — no rate or DoS surface change; no PII. Security review requested on: the DO UPDATE convergence semantics (self-hoster overwrite), alias precedence, and the expanded `unknown_category` available-list (29 names, no info leak).

## 6. Migration plan

**Zero item-row migration (D8).** Deploy sequence (standard agent-owned deploy, THI-36/THI-705; DevOps runbook steps, no human gate):

1. **PR 1 merges → deploy.** Migrate applies the two `ADD COLUMN IF NOT EXISTS` (inert) and re-runs the 14-row seed with DO UPDATE (content unchanged → no-op). New code paths are live but find no parents/aliases/departments — resolution is exact-match-only, expansion returns single names: behavior byte-identical to today.
2. **PR 2 merges → deploy.** Migrate applies the 29-row seed: 15 INSERTs (new departments/leaves) + 14 UPDATEs (parents, aliases, `music`/`toys`/`electronics`/`home`/`sports` description clarifications, new fashion attribute definitions). No `items`/`wanted_items`/`buyer_intents` row is touched.
3. **PR 3 merges → deploy.** Docs/skills only.

Expand-contract posture: purely additive (new columns, new rows, new accepted values, new output fields). There is no contract step in this spec; removing a leaf later is a separate expand-contract decision with its own data migration.

## 7. Test plan

- **`src/categories.ts` unit:** resolution precedence (exact > alias > unknown); alias→canonical; case normalization; expansion (dept → dept+children; leaf → self; `other` → self); item closure (leaf → {leaf, parent}; dept-assigned → {dept}); invariants (two-level, no alias == canonical, alias uniqueness).
- **Schema/migration:** apply schema.sql twice against a fresh DB and once against a DB with a hand-diverged description → identical converged state (DO UPDATE convergence); 29-row count; departments-first FK ordering.
- **Search:** dept filter returns dept-assigned + child-assigned items and excludes siblings; leaf filter excludes dept-assigned items; alias filter resolves; unknown dept/leaf/alias → `unknown_category` with full available list.
- **describe_category:** no-arg rows carry `parent`; dept arg returns children with feed-visible counts; leaf arg carries `parent`; alias arg resolves + note.
- **Write paths:** alias accepted → canonical stored + note; department accepted; new enums validated (`department`, `size_letter` reject out-of-enum); legacy `size` still accepted on clothing alongside `size_letter`; existing definitions still required (e.g. `size_eu` on sneakers).
- **Intents:** save_intent stores canonical; `fashion` intent matches a `sneakers` listing publish; `sneakers` intent does not match a `fashion`-assigned listing; alias intent resolves at save.
- **Chat parity** (THI-83 §8/F3): describe_category shape and alias resolution match the MCP tool.
- **Existing suites green**, including the search-relevance harness and MCP gate tool list (directory profile unaffected — no tool added/removed).

## 8. Rollout + rollback

- **Rollout:** §6; each PR merges on green CI + recorded Security/CEO sign-off (this spec PR first — children THI-735–737 stay blocked until then), then deploys per the standard runbook.
- **Rollback per PR:** redeploy the previous image (DB untouched). New columns are unread by old code; new category rows are ordinary registry rows — old code accepts them for creates and exact-match search, which is harmless surplus. Rolling back PR 2's schema.sql as well is unnecessary and not recommended (old seed's DO NOTHING would simply leave the new rows in place — still harmless).
- **No destructive step exists in this design.** Destructive production actions outside a runbook still require explicit human approval (board THI-705 carve-out unaffected).

## 9. ADR

A short ADR (`docs/adr/0008-category-taxonomy-two-level.md`, ships in PR 3) records: context (§1–2), decision (two-level tree, departments assignable, facets-as-attributes, registry-as-code, zero item-row migration), rejected alternatives (flat list + more slugs; Vinted-depth copy; three-level `sneakers→shoes`; renaming `music`; FK trigger for the invariant; migrating existing rows), consequences (additive surface, self-hoster registry convergence, `other` shrink depends on importer follow-up).

## 10. Implementation steps (each one purpose, ≤ ~300 lines)

1. **PR 1 — schema plumbing + parent-aware filtering** (touches both protected files): `parent`/`aliases` columns; DO UPDATE seed switch (14 rows, content unchanged); `src/categories.ts`; expansion in `searchItems`/`searchWanted`; `describe_category` tree output + alias resolution; alias resolution + canonical note in create/save paths (`tools.ts`, `wanted.ts`, `chat.ts`); intent closure in `evaluateListingForIntents`; unit + integration tests. If review finds it over ~300 lines, the split line is chat-parity + intent closure into a PR 1b (still before PR 2).
2. **PR 2 — taxonomy content** (`db/schema.sql`, protected): the 29-row seed of §5.1–5.3 (parents, aliases, new leaves, facet definitions, description clarifications); registry-content test (tree shape, invariants, all-14-slugs-survive); migrate idempotency test.
3. **PR 3 — docs & skills:** `public/llms.txt` (departments, aliases, `source_category` convention), `skills/sell-item` + `skills/find-item`, `docs-site` regen (`npm run docs:tools`), README category mentions, ADR 0008. Docs agent keeps reference docs in sync.
4. **Platform follow-up (private repo `thingery/platform`, THI-738, not in these PRs):** extend Vinted/eBay mappings to new leaves; auto-fill `department` on fashion imports; adopt `source_category`; browse-UI tree; coordinate with THI-618.

## Appendix A — what deliberately does not change

- No tool added/removed; no input schema change on any tool; no error code change.
- No rename/repurpose/delete of any existing slug; no item/wanted/intent row migration.
- No change to attribute passthrough, caps, or the undeclared-key surface.
- `update_listing` still cannot change category (ROADMAP item 11 — follow-up).
- `website/` in the public repo stays frozen (board ruling THI-565).

## Appendix B — optional Phase-3 quality backfill (separate decision, not in PRs 1–3)

Only if counts justify it, a later script (e.g. `music` items with `attributes->>'format' = 'instrument'` → `instruments`; Vinted-imported `home` rows → `tools`/`pets` where the source category says so) re-categorizes rows additively. It requires its own task, count report, and expand-contract review; nothing in this spec depends on it.
