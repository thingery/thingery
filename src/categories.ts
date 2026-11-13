// Category registry resolution + two-level expansion (spec THI-734 / GH #218,
// PR 1). Single code path for every category-accepting surface: items.ts and
// wanted.ts (search filters), wanted.ts (write validation), intents.ts
// (matching closure), tools.ts and chat.ts (describe/create tools). Leaf
// module: imports only db.js, so every importer stays cycle-free.

import { pool } from "./db.js";

/** Input → canonical slug resolution (D4). Exact name match wins — an alias
 *  never shadows a canonical name (seed invariant); alias matches break ties
 *  by name so even a bad seed edit that duplicated an alias across rows still
 *  resolves deterministically (Security review note N2). Input case is
 *  normalized before resolution. Null = not in the registry. */
export interface ResolvedCategory {
  canonical: string;
  viaAlias: boolean;
}

export async function resolveCategory(raw: string): Promise<ResolvedCategory | null> {
  const name = raw.toLowerCase();
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM categories
     WHERE name = $1 OR aliases @> ARRAY[$1]::text[]
     ORDER BY (name = $1) DESC, name
     LIMIT 1`,
    [name],
  );
  const hit = rows[0];
  return hit ? { canonical: hit.name, viaAlias: hit.name !== name } : null;
}

/** Filter names for a canonical slug (D2): a department expands to itself +
 *  direct children — one level, no recursion (the two-level invariant makes
 *  it unnecessary). A leaf (or 'other') filters itself. Unknown input returns
 *  [input] unchanged so callers that pre-validated keep working; callers that
 *  must reject unknown input do so with resolveCategory first. */
export async function categoryFilterNames(canonical: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM categories WHERE name = $1 OR parent = $1
     ORDER BY (name = $1) DESC, name`,
    [canonical],
  );
  return rows.length > 0 ? rows.map((r) => r.name) : [canonical];
}

/** Matching closure for an item's stored category (spec §5.6): the item's own
 *  slug plus its department, so a 'fashion' intent matches a 'sneakers'
 *  listing while a 'sneakers' intent never matches a 'fashion'-assigned
 *  listing — an unspecified-leaf item is not known to be sneakers.
 *  Department-assigned items close to themselves. The only two transitions;
 *  nothing here is best-effort. */
export async function categoryClosureForItem(category: string): Promise<string[]> {
  const { rows } = await pool.query<{ parent: string | null }>(
    `SELECT parent FROM categories WHERE name = $1`,
    [category],
  );
  const parent = rows[0]?.parent ?? null;
  return parent ? [category, parent] : [category];
}

/** Canonical-echo note for write paths that resolved an alias (THI-734 D4):
 *  the stored category is always canonical, and the response says so. Shared
 *  by the MCP tools and the chat flow so the wording cannot drift. */
export function aliasResolutionNote(raw: string, canonical: string): string {
  return `category '${raw}' resolved to canonical slug '${canonical}' — stored category is '${canonical}'`;
}

/** describe_category note builder (THI-734 §5.5; THI-83 §8/F3 shape-once
 *  render-twice): src/tools.ts and src/chat.ts emit the identical string. */
export function describeCategoryNote(input: {
  raw: string;
  canonical: string;
  viaAlias: boolean;
  hasChildren: boolean;
  hasUndeclared: boolean;
}): string {
  return (
    (input.viaAlias ? `category '${input.raw}' resolved to canonical slug '${input.canonical}'. ` : "") +
    "attribute_definitions are the declared keys — create_listing validates them " +
    "(types, required, enums). Listings may also carry undeclared keys: they pass through " +
    "unvalidated, and search_items attribute filters match any key, declared or not." +
    (input.hasChildren
      ? " This category is a department: it is a valid category in its own right (leaf unspecified), and searching it also matches its children listed above."
      : "") +
    (input.hasUndeclared
      ? " undeclared_in_use lists undeclared keys observed on active listings (item and " +
        "distinct-seller counts); they are NOT validated — treat them as search hints, not contracts."
      : "")
  );
}
