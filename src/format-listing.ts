// format_listing — cross-platform listing copy generator (spec THI-813 §5,
// P1-4 / THI-816). One structured item → ready-to-paste listing copy for the
// legacy marketplaces (Subito, Vinted, Wallapop, eBay) plus an API-ready
// JSON envelope. Export only: nothing here ever talks to those platforms
// (plan D3 — no scraping, no posting); the seller pastes the copy herself.
//
// Deterministic string assembly, NO LLM (ADR 0009 rejected LLM copy as a
// hallucination surface): same item + platform + language → byte-identical
// output, asserted by the template-lint tests. The layout mirrors the
// extraction module: a pure core that never touches the database (offline
// unit tests) and a thin async wrapper the MCP tool calls.

import { z } from "zod";
import { CONDITIONS, type ItemRow } from "./db.js";
import { getCategory, getItem } from "./items.js";
import { computeComparablesAndFmv, computeFmv, type FairMarketValue } from "./extraction.js";
import { screenContactInfo } from "./contact-scrub.js";
import type { AttributeDefinition, CategoryRow } from "./attributes.js";

// --- wire contract -----------------------------------------------------------------

export const PLATFORMS = ["subito", "vinted", "wallapop", "ebay"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const LANGUAGES = ["it", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export const formatListingRequestSchema = z.object({
  item_id: z.string().uuid(),
  platform: z.enum(PLATFORMS),
  language: z.enum(LANGUAGES).optional(),
});
export type FormatListingRequest = z.infer<typeof formatListingRequestSchema>;

/** Per-platform title-length limits. TEMPLATE CONSTANTS, not an API contract
 *  (spec THI-813 §5 + Open Question 6, Architect pin b820110c and Security
 *  rider 25c2b6c3 on THI-816): they are verified against the live platform
 *  docs at PR time and pinned in tests/format-listing.test.ts. Platform drift
 *  is a same-PR test+constant update, never a breaking change. */
export const PLATFORM_TITLE_LIMITS: Record<Platform, number> = {
  ebay: 80,
  subito: 60,
  vinted: 60,
  wallapop: 50,
};

/** json envelope contract version — bumped when a listing shape changes
 *  meaningfully so caller scripts can branch on it. */
export const FORMAT_JSON_VERSION = 1 as const;

// --- template input ----------------------------------------------------------------

/** The item fields the templates may use — exactly the allowlist the lint
 *  test enforces ("no PII leakage beyond item fields"): seller identity,
 *  contact columns and images never enter the template surface. */
export interface FormatListingItem {
  title: string;
  description: string;
  category: string;
  condition: string;
  brand: string | null;
  price_cents: number;
  currency: string;
  shipping_tier: string;
  shipping_price_cents: number;
  attributes: Record<string, string | number | boolean>;
}

export interface FormatListingComparables {
  count: number;
  min_cents: number | null;
  max_cents: number | null;
  currency: string | null;
}

export interface FormatListingInput {
  item: FormatListingItem;
  platform: Platform;
  /** Defaults to "it" — the four target marketplaces are the deployment's
   *  Italian-market export lane; there is no item- or deployment-level
   *  locale in the public repo to derive it from (spec: "default from item
   *  locale/deployment"; neither exists yet — revisit if either lands). */
  language?: Language;
  /** The category registry's declared attributes, in declared order — the
   *  "declared first" ordering for attribute lines and platform fields. */
  definitions?: AttributeDefinition[];
  comparables?: FormatListingComparables;
}

export interface FormatListingResult {
  title: string;
  description: string;
  fields: Record<string, string>;
  json: {
    version: typeof FORMAT_JSON_VERSION;
    platform: Platform;
    language: Language;
    listing: Record<string, unknown>;
  };
  warnings: string[];
}

export class FormatListingError extends Error {
  constructor(readonly code: "not_found" | "invalid_params", message: string) {
    super(message);
    this.name = "FormatListingError";
  }
}

// --- i18n dictionaries (templates only — no machine translation, spec §5) ----------

type Dict = {
  /** Number-format locale for Intl (currency + decimal rendering). */
  intlLocale: string;
  conditionLabels: Record<(typeof CONDITIONS)[number], string>;
  shipping: {
    locker: string;
    parcel: string;
    bulky: string;
    included: string;
    pickup: string;
    label: string;
  };
  description: {
    conditionPrefix: string;
    priceLabel: string;
    marketRange: string;
    marketRangeBasis: (n: number) => string;
  };
  fields: {
    title: string;
    price: string;
    condition: string;
    brand: string;
    model: string;
    color: string;
    size: string;
    material: string;
    type: string;
    department: string;
    booleanYes: string;
    booleanNo: string;
  };
};

const DICTS: Record<Language, Dict> = {
  it: {
    intlLocale: "it-IT",
    conditionLabels: { new: "nuovo", like_new: "come nuovo", good: "buono", fair: "discreto", poor: "usato" },
    shipping: {
      locker: "Consegna a locker",
      parcel: "Spedizione",
      bulky: "Consegna per oggetti ingombranti (da concordare)",
      included: "spedizione inclusa",
      pickup: "Ritiro a mano",
      label: "Spedizione",
    },
    description: {
      conditionPrefix: "Condizione",
      priceLabel: "Prezzo",
      marketRange: "Fascia di mercato",
      marketRangeBasis: (n) => `su ${n} annunci simili attivi (prezzi d'inserto)`,
    },
    fields: {
      title: "titolo",
      price: "prezzo",
      condition: "condizione",
      brand: "marca",
      model: "modello",
      color: "colore",
      size: "taglia",
      material: "materiale",
      type: "tipo",
      department: "reparto",
      booleanYes: "sì",
      booleanNo: "no",
    },
  },
  en: {
    intlLocale: "en-IE",
    conditionLabels: { new: "new", like_new: "like new", good: "good", fair: "fair", poor: "used" },
    shipping: {
      locker: "Locker delivery",
      parcel: "Shipping",
      bulky: "Bulky-item delivery (to be arranged)",
      included: "shipping included",
      pickup: "In-person pickup",
      label: "Shipping",
    },
    description: {
      conditionPrefix: "Condition",
      priceLabel: "Price",
      marketRange: "Market range",
      marketRangeBasis: (n) => `from ${n} comparable active listings (asking prices)`,
    },
    fields: {
      title: "title",
      price: "price",
      condition: "condition",
      brand: "brand",
      model: "model",
      color: "color",
      size: "size",
      material: "material",
      type: "type",
      department: "department",
      booleanYes: "yes",
      booleanNo: "no",
    },
  },
};

/** Structured attribute fields a platform can render (the localized label
 *  names live in the dicts; "title"/"price"/"condition" are item columns). */
type AttrField = "brand" | "model" | "color" | "size" | "material" | "type" | "department";
type FieldKey = "title" | "price" | "condition" | AttrField;

/** Attribute keys that map onto a platform's structured field (case- and
 *  locale-insensitive match against stored keys). Anything not claimed here
 *  falls into description block (3) per spec §5 — declared attrs first. */
const FIELD_ATTR_KEYS: Record<AttrField, readonly string[]> = {
  brand: ["brand", "marca"],
  model: ["model", "modello"],
  color: ["color", "colorway", "colore"],
  size: ["size", "size_eu", "size_letter", "taglia"],
  material: ["material", "materiale"],
  type: ["type", "tipo"],
  department: ["department", "reparto"],
};

const ATTRIBUTE_KEY_ALIASES: ReadonlyMap<string, AttrField> = new Map(
  (Object.entries(FIELD_ATTR_KEYS) as Array<[AttrField, readonly string[]]>).flatMap(
    ([field, keys]) => keys.map((k) => [k.toLowerCase(), field] as const),
  ),
);

// --- helpers -----------------------------------------------------------------------

function formatMoney(cents: number, currency: string, intlLocale: string): string {
  // Intl output is deterministic for a given Node/ICU build; the lint test
  // pins byte-identical double renders rather than exact locale strings.
  try {
    return new Intl.NumberFormat(intlLocale, { style: "currency", currency }).format(cents / 100);
  } catch {
    // Unknown currency code — degrade to a plain deterministic form.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function formatAttributeValue(
  value: string | number | boolean,
  dict: Dict,
): string {
  if (typeof value === "boolean") return value ? dict.fields.booleanYes : dict.fields.booleanNo;
  return String(value);
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/** Word-boundary-aware deterministic clamp (spec §5: titles are "clamped to
 *  the platform's title limit"). Cuts at the last space when that keeps at
 *  least ~60% of the budget, else hard-cuts — either way the same input
 *  always yields the same title. */
export function clampTitleToLimit(raw: string, limit: number): { title: string; clamped: boolean } {
  const singleSpaced = raw.replace(/\s+/g, " ").trim();
  if (singleSpaced.length <= limit) return { title: singleSpaced, clamped: false };
  const cut = singleSpaced.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  const title = (lastSpace >= Math.floor(limit * 0.6) ? cut.slice(0, lastSpace) : cut).trimEnd();
  return { title, clamped: true };
}

/** The platform field labels the tool emits. eBay follows the Item
 *  Specifics Title-case convention; Vinted's condition field is "status"
 *  (their term); Subito and Wallapop use the label of the export language.
 *  Field names are part of the versioned json envelope, not an API promise:
 *  platform drift = same-PR update (spec §5, Open Question 6 posture). */
function fieldLabels(platform: Platform, dict: Dict): Record<string, string> {
  switch (platform) {
    case "ebay":
      return {
        title: "Title",
        price: "StartPrice",
        condition: "Condition",
        brand: "Brand",
        model: "Model",
        color: "Color",
        size: "Size",
        material: "Material",
        type: "Type",
        department: "Department",
      };
    case "vinted":
      return {
        title: "title",
        price: "price",
        condition: "status", // Vinted names the condition field "status"
        brand: "brand",
        model: "model",
        color: "color",
        size: "size",
        material: "material",
        type: "type",
        department: "department",
      };
    case "subito":
      return {
        title: "titolo",
        price: "prezzo",
        condition: "condizione",
        brand: "marca",
        model: "modello",
        color: "colore",
        size: "taglia",
        material: "materiale",
        type: "tipo",
        department: "reparto",
      };
    case "wallapop":
      return {
        title: "titulo",
        price: "precio",
        condition: "estado",
        brand: "marca",
        model: "modelo",
        color: "color",
        size: "talla",
        material: "material",
        type: "tipo",
        department: "departamento",
      };
  }
}

/** Which platform field each localized label renders into. Same partitions
 *  as fieldLabels — kept as a separate table so the two stay reviewable
 *  together (a platform that drops a field updates both in one edit). */
function platformFields(platform: Platform): ReadonlyArray<FieldKey> {
  switch (platform) {
    case "ebay":
      return ["title", "price", "condition", "brand", "model", "color", "size", "material", "type", "department"];
    case "vinted":
      return ["title", "price", "condition", "brand", "size", "color"];
    case "subito":
      return ["title", "price", "condition", "brand", "size", "color"];
    case "wallapop":
      return ["title", "price", "condition", "brand", "size", "color", "material"];
  }
}

// --- title formula (spec §5) -------------------------------------------------------

/** `{Brand} {Model/identity} {key attr} – {condition bucket}`, clamped to the
 *  platform limit. Identity = the model attribute when present, else the
 *  item title (with a duplicated leading brand stripped, case-insensitive).
 *  Key attr = the first declared attribute (registry order) whose formatted
 *  value stays short enough for a title; deterministic first-match. */
export function buildTitle(item: FormatListingItem, language: Language, definitions: AttributeDefinition[]): {
  title: string;
  keyAttrUsed: string | null;
} {
  const dict = DICTS[language];
  const conditionLabel = dict.conditionLabels[item.condition as (typeof CONDITIONS)[number]] ?? item.condition;
  const brand = item.brand?.trim() || null;

  const modelAttr = Object.entries(item.attributes).find(([k]) => normalizeKey(k) === "model");
  let identity: string;
  if (modelAttr && typeof modelAttr[1] === "string" && modelAttr[1].trim()) {
    identity = modelAttr[1].trim();
  } else if (brand && item.title.toLowerCase().startsWith(brand.toLowerCase())) {
    identity = item.title.slice(brand.length).replace(/^[\s\-–:]+/, "").trim();
  } else {
    identity = item.title.trim();
  }

  // Key attr: first declared, non-model attribute with a short formatted value.
  let keyAttrUsed: string | null = null;
  let keyAttrPart: string | null = null;
  for (const def of definitions) {
    const normalized = normalizeKey(def.key);
    if (normalized === "model") continue;
    const value = item.attributes[def.key];
    if (value === undefined || value === null || value === "") continue;
    const formatted = formatAttributeValue(value as string | number | boolean, dict);
    if (formatted.length > 0 && formatted.length <= 20) {
      keyAttrUsed = def.key;
      keyAttrPart = formatted;
      break;
    }
  }

  const parts = [brand, identity, keyAttrPart].filter((p): p is string => p !== null && p.length > 0);
  const raw = `${parts.join(" ")} – ${conditionLabel}`;
  return { title: raw, keyAttrUsed };
}

// --- description blocks (spec §5 block order) --------------------------------------

function buildDescription(
  item: FormatListingItem,
  platform: Platform,
  language: Language,
  definitions: AttributeDefinition[],
  comparables: FormatListingComparables | undefined,
): string {
  const dict = DICTS[language];
  const conditionLabel = dict.conditionLabels[item.condition as (typeof CONDITIONS)[number]] ?? item.condition;
  const lines: string[] = [];

  // (1) identity line — the assembled title without the condition bucket.
  const { title } = buildTitle(item, language, definitions);
  const identityLine = title.includes(" – ") ? title.slice(0, title.lastIndexOf(" – ")) : title;
  lines.push(identityLine);

  // (2) condition + known flaws (the seller's own description text carries
  // the flaws — template only labels the condition bucket).
  lines.push(`${dict.description.conditionPrefix}: ${conditionLabel}`);
  const descriptionText = item.description.trim();
  if (descriptionText) lines.push(descriptionText);

  // (3) attribute lines for the declared attributes the platform field map
  // does not consume (spec: unmappable attributes fall into this block),
  // in declared order.
  const consumed = new Set(platformFields(platform).filter((f) => f !== "title" && f !== "price" && f !== "condition"));
  for (const def of definitions) {
    const field = ATTRIBUTE_KEY_ALIASES.get(normalizeKey(def.key));
    if (field && consumed.has(field)) continue;
    const value = item.attributes[def.key];
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${def.key}: ${formatAttributeValue(value as string | number | boolean, dict)}`);
  }

  // (4) shipping/pickup terms (item shipping tier + what the buyer pays).
  const shippingLine = shippingTerms(item, dict);
  if (shippingLine) lines.push(shippingLine);

  // (5) price + FMV rationale (from comparables when present). The label is
  // the dict's human term (Prezzo/Price), not the platform form-field name —
  // this block is pasted into the description box, not the form.
  lines.push(`${dict.description.priceLabel}: ${formatMoney(item.price_cents, item.currency, dict.intlLocale)}`);
  if (comparables && comparables.count > 0 && comparables.min_cents !== null && comparables.max_cents !== null && comparables.currency) {
    const min = formatMoney(comparables.min_cents, comparables.currency, dict.intlLocale);
    const max = formatMoney(comparables.max_cents, comparables.currency, dict.intlLocale);
    lines.push(
      `${dict.description.marketRange}: ${min}–${max} — ${dict.description.marketRangeBasis(comparables.count)}`,
    );
  }

  return lines.join("\n");
}

function shippingTerms(item: FormatListingItem, dict: Dict): string | null {
  const s = dict.shipping;
  switch (item.shipping_tier) {
    case "local":
      return s.pickup;
    case "locker":
    case "parcel":
    case "bulky": {
      const base = s[item.shipping_tier];
      return item.shipping_price_cents === 0
        ? `${base} — ${s.included}`
        : `${base} — ${formatMoney(item.shipping_price_cents, item.currency, dict.intlLocale)}`;
    }
    default:
      return null; // unknown tier → omit the block, never guess
  }
}

// --- fields map (spec §5) ----------------------------------------------------------

function buildFields(
  item: FormatListingItem,
  platform: Platform,
  language: Language,
  definitions: AttributeDefinition[],
  conditionLabel: string,
): Record<string, string> {
  const dict = DICTS[language];
  const labels = fieldLabels(platform, dict);
  const fields: Record<string, string> = {};

  for (const field of platformFields(platform)) {
    const label = labels[field];
    switch (field) {
      case "title":
        // The clamped platform title — same string the paste-ready title uses.
        fields[label] = clampTitleToLimit(
          buildTitle(item, language, definitions).title,
          PLATFORM_TITLE_LIMITS[platform],
        ).title;
        break;
      case "price":
        fields[label] = formatMoney(item.price_cents, item.currency, dict.intlLocale);
        break;
      case "condition":
        fields[label] = conditionLabel;
        break;
      default: {
        // Structured attribute field: item column first, then the first
        // matching declared attribute (registry order → deterministic).
        const keys = FIELD_ATTR_KEYS[field];
        const direct = field === "brand" && item.brand?.trim();
        if (direct) {
          fields[label] = item.brand!.trim();
          break;
        }
        const match = Object.entries(item.attributes).find(([k]) =>
          keys.map(normalizeKey).includes(normalizeKey(k)),
        );
        if (match && match[1] !== "" && match[1] !== null && match[1] !== undefined) {
          fields[label] = formatAttributeValue(match[1] as string | number | boolean, dict);
        }
        break;
      }
    }
  }
  return fields;
}

// --- per-platform json envelope (spec §5, version 1) --------------------------------

function buildJsonListing(
  item: FormatListingItem,
  platform: Platform,
  language: Language,
  description: string,
  fields: Record<string, string>,
  conditionLabel: string,
): Record<string, unknown> {
  const dict = DICTS[language];
  const money = (cents: number, currency: string) => ({ amount: Number((cents / 100).toFixed(2)), currency });
  const shipping = shippingTerms(item, dict);

  switch (platform) {
    case "ebay":
      // Trading-API-flavoured envelope: Item Specifics as Name/Value pairs
      // (platform-documented names, v1 envelope).
      return {
        Title: fields["Title"],
        Description: description,
        StartPrice: money(item.price_cents, item.currency),
        Condition: conditionLabel,
        ItemSpecifics: Object.entries(fields)
          .filter(([name]) => name !== "Title" && name !== "StartPrice" && name !== "Condition")
          .map(([Name, Value]) => ({ Name, Value })),
        Currency: item.currency,
        ...(shipping ? { shipping } : {}),
      };
    case "vinted":
      return {
        title: fields["title"],
        description,
        brand: fields["brand"],
        size: fields["size"],
        status: conditionLabel, // Vinted's condition field
        price: money(item.price_cents, item.currency),
        color: fields["color"],
        ...(shipping ? { shipping } : {}),
      };
    case "subito":
      return {
        titolo: fields["titolo"],
        descrizione: description,
        prezzo: money(item.price_cents, item.currency),
        condizione: conditionLabel,
        marca: fields["marca"],
        taglia: fields["taglia"],
        colore: fields["colore"],
        ...(shipping ? { spedizione: shipping } : {}),
      };
    case "wallapop":
      return {
        titulo: fields["titulo"],
        descripcion: description,
        precio: money(item.price_cents, item.currency),
        estado: conditionLabel,
        marca: fields["marca"],
        talla: fields["talla"],
        ...(shipping ? { envio: shipping } : {}),
      };
  }
}

// --- pure core ---------------------------------------------------------------------

/** Deterministic template assembly. Same input → byte-identical output
 *  (lint-pinned). Never throws on data shape: unknown values degrade to
 *  plain strings, unknown currencies to a plain decimal form. */
export function formatListing(input: FormatListingInput): FormatListingResult {
  const language = input.language ?? "it";
  const dict = DICTS[language];
  const definitions = input.definitions ?? [];
  const warnings: string[] = [];

  const conditionLabel = dict.conditionLabels[input.item.condition as (typeof CONDITIONS)[number]] ?? input.item.condition;

  // Title: formula → platform clamp (+ warning when truncation fired).
  const built = buildTitle(input.item, language, definitions);
  const { title, clamped } = clampTitleToLimit(built.title, PLATFORM_TITLE_LIMITS[input.platform]);
  if (clamped) warnings.push(`title_truncated: clamped to the ${input.platform} limit of ${PLATFORM_TITLE_LIMITS[input.platform]} characters`);

  // PII-scrub passthrough (existing contact-scrub conventions respected):
  // the copy is an export of the seller's own published content, so it is
  // NEVER silently rewritten — silent scrubbing corrupts user content (the
  // rule documented in src/contact-scrub.ts). When the assembled title or
  // description trips a rule, the copy ships unchanged and a warning names
  // the rule so the caller can decide.
  const description = buildDescription(input.item, input.platform, language, definitions, input.comparables);
  const hit = screenContactInfo({ title, notes: description });
  if (hit) {
    warnings.push(`contact_info_detected (${hit.rule}) in the source item fields — export passes the seller's own content through unchanged`);
  }

  // No comparables → the FMV rationale block is omitted; say so once.
  if (!input.comparables || input.comparables.count === 0) {
    warnings.push("no_comparables: no comparable active listings found — market-range line omitted");
  }

  const fields = buildFields(input.item, input.platform, language, definitions, conditionLabel);
  const jsonListing = buildJsonListing(input.item, input.platform, language, description, fields, conditionLabel);

  return {
    title,
    description,
    fields,
    json: {
      version: FORMAT_JSON_VERSION,
      platform: input.platform,
      language,
      listing: jsonListing,
    },
    warnings,
  };
}

// --- async wrapper (the one the MCP tool calls) -------------------------------------

/** Loads the item (owner-scoped by the caller — the tool checks seller
 *  ownership before calling), the category registry definitions, and the
 *  live comparables for the FMV rationale; then runs the pure core.
 *  Comparables reuse the extraction pipeline's deterministic search + FMV
 *  math (same query shape, same p25/p75 / ±20% rules) — one code path for
 *  both surfaces. A comparables failure degrades to "no comparables"
 *  (warning), never fails the export. */
export async function formatListingForItem(request: FormatListingRequest): Promise<FormatListingResult> {
  const item: ItemRow | null = await getItem(request.item_id);
  if (!item || item.status === "deleted") {
    throw new FormatListingError("not_found", "item not found");
  }

  const category: CategoryRow | null = await getCategory(item.category);
  const definitions = category?.attribute_definitions ?? [];

  let comparables: FormatListingComparables | undefined;
  try {
    const { fmv } = await computeComparablesAndFmv(
      { title: item.title, category: item.category, condition: item.condition, attributes: item.attributes as FormatListingItem["attributes"] },
      [],
    );
    comparables = toComparables(fmv);
  } catch {
    comparables = toComparables(computeFmv([], item.currency));
  }

  return formatListing({
    item: {
      title: item.title,
      description: item.description,
      category: item.category,
      condition: item.condition,
      brand: item.brand,
      price_cents: item.price_cents,
      currency: item.currency,
      shipping_tier: item.shipping_tier,
      shipping_price_cents: item.shipping_price_cents,
      attributes: item.attributes as FormatListingItem["attributes"],
    },
    platform: request.platform,
    language: request.language,
    definitions,
    comparables,
  });
}

function toComparables(fmv: FairMarketValue): FormatListingComparables {
  return {
    count: fmv.n_comparables,
    min_cents: fmv.min_cents,
    max_cents: fmv.max_cents,
    currency: fmv.currency,
  };
}
