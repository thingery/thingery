# ADR 0008: Category taxonomy — two-level tree with facet attributes

- **Status:** Accepted (spec THI-734, merged as `docs/specs/category-taxonomy.md` at PR #255; Security review APPROVE WITH NOTES THI-739; CEO acceptance THI-740; both 2026-11-13). Implemented in PRs #256 (plumbing) and #257 (content); origin [GH #218](https://github.com/thingery/thingery/issues/218).
- **Date:** 2026-11-13
- **Related:** GH #218 (fedealconda), THI-733 (tracking), THI-734 (spec), THI-735/THI-736 (implementation), THI-738 (platform importer follow-up), THI-739/THI-740 (reviews)

## Context

The category registry was a flat list of 14 slugs. GH #218 documented four failures: fashion
had no women/men/kids split and sizes were free text (`clothing.size` held "M", "42", "One
Size"); overlapping siblings (`sneakers`/`shoes`, `games`/`toys`, `electronics` vs
`phones`/`computers`) made agents classify inconsistently; large second-hand segments
(prams, bags, beauty, bikes, pet care) collapsed into `other`; and deep marketplace trees
(Vinted: 3,081 categories) mapped onto 14 buckets lost all detail. A latent bug compounded
it: the seed used `ON CONFLICT DO NOTHING`, so shipped registry edits never applied to an
existing database — schema.sql was de facto source of truth, but a non-converging one.

Constraints: sellers are mostly agents (Vinted-style depth works against agent
classification consistency); all 14 slugs are public API surface used by registry-listed MCP
installs, npm self-hosters, and live sessions; `scripts/migrate.ts` applies `db/schema.sql`
wholesale; no admin write path to `categories` exists.

## Decision

1. **Strict two-level tree** (`categories.parent` self-FK): 7 departments over 21 leaves,
   plus parentless, childless `other` as the fallback. **Departments stay assignable** — a
   department assignment means "leaf unspecified", so every existing item and slug keeps
   working unchanged.
2. **Parent filter = department + direct children** in `search_items`/`search_wanted` and
   intent matching (one level, no recursion; the two-level invariant is asserted by tests).
3. **All 14 legacy slugs survive** with name and attribute definitions intact; new leaves
   are purely additive. `music` stays as the recorded-music leaf, steering new instrument
   listings to `instruments`.
4. **Slug aliases** (`categories.aliases TEXT[]`): `trainers→sneakers`, `stroller`/`pram→baby`,
   `jewelry→accessories`, `smartphone→phones`, `laptop→computers`, `vinyl`/`records→music`.
   Exact name match wins, then alias; writes store the canonical slug and echo the
   resolution. Kills the largest classification inconsistency cheaply.
5. **Facets as attributes, expand-contract:** `department` enum `[women|men|unisex|kids]` on
   fashion categories; typed sizes as new keys alongside legacy free-text `size`
   (`size_letter` on clothing, numeric `size_eu` already existed on footwear). Nothing any
   existing agent sends becomes invalid.
6. **Registry as code:** the seed converges via `ON CONFLICT (name) DO UPDATE` — re-applying
   schema.sql always yields the shipped registry. Fixes the latent no-convergence bug.
7. **Zero item-row migration:** no `items`/`wanted_items`/`buyer_intents` row is read or
   written by the rollout; the only data changes are registry rows.
8. **Importer conventions in the public repo, mapping stays in `platform`:** importers
   auto-fill `department` when the source has it and record the source's leaf name under the
   passthrough key `source_category` (THI-738 does the platform-side mapping).

## Alternatives considered

- **Flat list with more slugs:** rejected — more siblings worsen the exact overlap problem
  (classification inconsistency) without giving buyers a department axis.
- **Copy Vinted's depth:** rejected — humans pick from menus, agents don't; two agents put
  the same item in different leaves and leaf filters miss listings. Its names are
  locale-translated (only IDs stable), its depth is really facets, and it would tie the
  public schema to another platform's taxonomy.
- **Three levels (`sneakers` under `shoes`):** rejected — repurposes an existing slug's
  semantics for zero compat benefit; consistency is attacked with descriptions + aliases.
- **Renaming `music`:** rejected — renames break registry-listed installs; a clarified
  description plus a new `instruments` leaf achieves the split additively.
- **FK trigger enforcing two levels:** rejected — the registry is code-owned with no runtime
  writer; the invariant is asserted by tests (Simplicity).
- **Migrating existing item rows to new leaves:** rejected — zero-migration keeps rollout
   additive and reversible; quality backfill is a separate later decision (spec Appendix B).
- **DB-level alias-uniqueness guarantee (exclusion constraint):** rejected at 29 code-owned
  rows — recorded as a future option if the registry grows; resolution keeps a deterministic
  `ORDER BY` even if the invariant were ever broken by a bad seed edit.

## Consequences

- Additive surface only: new columns, new rows, new accepted values, new output fields
  (`parent`, `children`, alias notes). Strict parsers that reject unknown fields could break
  — accepted risk, consistent with prior additive changes.
- **Self-hoster registry convergence:** the next `db:migrate` overwrites hand-edited
  `categories` rows and slug-colliding local additions — documented as the managed-table
  contract in the self-hosting docs and release notes (Security review N1/N3, CEO note 2).
- Shrinking `other` depends on the importer follow-up (THI-738, platform repo), not on this
  rework alone.
- `update_listing` still cannot change a listing's category; that follow-up is tracked by
  its source, [GH #218](https://github.com/thingery/thingery/issues/218) (aliases +
  departments make it more attractive as a fast follow-up).
