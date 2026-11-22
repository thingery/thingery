// THI-1182 (P1-2b): registry canonicalization unit tests — pure functions,
// no DB, so they run everywhere (the DB-backed integration against the real
// seeded registry lives in extraction.test.ts; the full golden replay in
// extraction-golden.test.ts). The fold table pins THI-1181's live FAIL
// values (recorded-responses.json on the issue) to their golden-canonical
// enum slugs — the deterministic lever behind the ≥80% key-attr gate.

import { describe, expect, it } from "vitest";
import {
  canonicalizeEnumValue,
  normalizeFacetToken,
  refineOtherCategory,
  type RegistryEntry,
} from "../src/extraction.js";
import type { AttributeDefinition } from "../src/attributes.js";

const str = (key: string, enumValues?: string[], required?: boolean): AttributeDefinition => ({
  key,
  type: "string",
  ...(enumValues ? { enum: enumValues } : {}),
  ...(required ? { required: true } : {}),
});

// Mirrors the db/schema.sql seed for the categories the backstop scan needs.
const GAMES_PLATFORM = str("platform", ["nintendo_switch", "ps4", "ps5", "xbox_one", "xbox_series", "pc", "other"], true);
const MUSIC_FORMAT = str("format", ["vinyl", "cd", "cassette", "instrument", "other"]);
const BEAUTY_TYPE = str("type", ["makeup", "skincare", "fragrance", "haircare", "other"]);
const BABY_TYPE = str("type", ["pushchair", "car_seat", "nursery", "other"]);
const TOOLS_TYPE = str("type", ["power", "hand", "garden", "other"]);
const PETS_TYPE = str("type", ["dog", "cat", "bird", "small_animal", "aquarium", "other"]);
const BIKES_TYPE = str("type", ["road", "mtb", "city", "bmx", "ebike", "kids", "other"]);
const DEPARTMENT = str("department", ["women", "men", "unisex", "kids"]);
const SIZE_LETTER = str("size_letter", ["XS", "S", "M", "L", "XL", "XXL"]);

const REGISTRY: RegistryEntry[] = [
  { name: "fashion", parent: null, description: "", aliases: [], defs: [DEPARTMENT] },
  { name: "clothing", parent: "fashion", description: "", aliases: [], defs: [str("size", undefined, true), SIZE_LETTER, DEPARTMENT] },
  { name: "sneakers", parent: "fashion", description: "", aliases: ["trainers"], defs: [str("size_eu"), DEPARTMENT] },
  { name: "accessories", parent: "fashion", description: "", aliases: ["jewelry"], defs: [BEAUTY_TYPE] },
  { name: "beauty", parent: "fashion", description: "", aliases: [], defs: [BEAUTY_TYPE] },
  { name: "kids", parent: null, description: "", aliases: [], defs: [] },
  { name: "baby", parent: "kids", description: "", aliases: ["stroller", "pram"], defs: [BABY_TYPE] },
  { name: "kids-clothing", parent: "kids", description: "", aliases: [], defs: [str("size", undefined, true)] },
  { name: "toys", parent: "kids", description: "", aliases: [], defs: [str("age_range")] },
  { name: "electronics", parent: null, description: "", aliases: [], defs: [str("model")] },
  { name: "games", parent: "electronics", description: "", aliases: [], defs: [GAMES_PLATFORM] },
  { name: "media", parent: null, description: "", aliases: [], defs: [] },
  { name: "books", parent: "media", description: "", aliases: [], defs: [str("author")] },
  { name: "music", parent: "media", description: "", aliases: ["vinyl", "records"], defs: [MUSIC_FORMAT] },
  { name: "hobbies", parent: null, description: "", aliases: [], defs: [] },
  { name: "collectibles", parent: "hobbies", description: "", aliases: [], defs: [str("franchise")] },
  { name: "home", parent: null, description: "", aliases: [], defs: [str("material")] },
  { name: "tools", parent: "home", description: "", aliases: [], defs: [TOOLS_TYPE] },
  { name: "pets", parent: "home", description: "", aliases: [], defs: [PETS_TYPE] },
  { name: "sports", parent: null, description: "", aliases: [], defs: [str("sport")] },
  { name: "bikes", parent: "sports", description: "", aliases: [], defs: [BIKES_TYPE] },
  { name: "other", parent: null, description: "", aliases: [], defs: [] },
];

describe("normalizeFacetToken (THI-1182 case/accent/punct/whitespace folding)", () => {
  it("folds case, underscores, punctuation and multi-space to single-space tokens", () => {
    expect(normalizeFacetToken("Nintendo Switch")).toBe("nintendo switch");
    expect(normalizeFacetToken("nintendo_switch")).toBe("nintendo switch");
    expect(normalizeFacetToken("car_seat")).toBe("car seat");
    expect(normalizeFacetToken("  Men's  ")).toBe("men s");
    expect(normalizeFacetToken("vinyl LP (180g)")).toBe("vinyl lp 180g");
    expect(normalizeFacetToken("Maxi-Cosi")).toBe("maxi cosi");
    expect(normalizeFacetToken("Crème / Brûlée")).toBe("creme brulee"); // accents fold
    expect(normalizeFacetToken("///")).toBe("");
  });
});

describe("canonicalizeEnumValue (THI-1182 live miss folds → declared enum slugs)", () => {
  // Each row: [attribute def, raw model value from THI-1181's run, expected declared value]
  const liveMisses: Array<[AttributeDefinition, string, string]> = [
    [BEAUTY_TYPE, "body lotion", "skincare"], // be-1
    [BEAUTY_TYPE, "lipstick", "makeup"], // be-2
    [GAMES_PLATFORM, "Nintendo Switch", "nintendo_switch"], // ga-1
    [GAMES_PLATFORM, "PlayStation 5", "ps5"], // ga-2
    [TOOLS_TYPE, "cordless drill", "power"], // tl-1
    [TOOLS_TYPE, "electric hedge trimmer", "garden"], // tl-2
    [PETS_TYPE, "foldable dog crate", "dog"], // pe-1
    [MUSIC_FORMAT, "vinyl LP (180g)", "vinyl"], // mu-1
    [BIKES_TYPE, "city e-bike", "ebike"], // bi-2
  ];
  it("folds every THI-1181 live free-text miss onto its declared enum value", () => {
    for (const [def, raw, expected] of liveMisses) {
      expect(canonicalizeEnumValue(def, raw), `${def.key} '${raw}'`).toBe(expected);
    }
  });

  it("keeps already-canonical values exactly (idempotent — no re-folding drift)", () => {
    expect(canonicalizeEnumValue(GAMES_PLATFORM, "ps5")).toBe("ps5");
    expect(canonicalizeEnumValue(GAMES_PLATFORM, "nintendo_switch")).toBe("nintendo_switch");
    expect(canonicalizeEnumValue(BABY_TYPE, "car_seat")).toBe("car_seat");
    expect(canonicalizeEnumValue(SIZE_LETTER, "M")).toBe("M");
    expect(canonicalizeEnumValue(DEPARTMENT, "men")).toBe("men");
  });

  it("case-insensitive exact match returns the declared casing", () => {
    expect(canonicalizeEnumValue(SIZE_LETTER, "xl")).toBe("XL");
    expect(canonicalizeEnumValue(GAMES_PLATFORM, "PS5")).toBe("ps5");
  });

  it("normalized equality folds casing/punctuation variants onto the declared value", () => {
    expect(canonicalizeEnumValue(DEPARTMENT, "MEN")).toBe("men");
    expect(canonicalizeEnumValue(BIKES_TYPE, "E-Bike")).toBe("ebike");
    expect(canonicalizeEnumValue(GAMES_PLATFORM, "nintendo switch")).toBe("nintendo_switch");
  });

  it("aliases fold marketplace vocabulary onto declared values", () => {
    expect(canonicalizeEnumValue(DEPARTMENT, "men's")).toBe("men");
    expect(canonicalizeEnumValue(DEPARTMENT, "women's")).toBe("women");
    expect(canonicalizeEnumValue(DEPARTMENT, "kids clothing")).toBe("kids");
    expect(canonicalizeEnumValue(GAMES_PLATFORM, "Nintendo Switch Lite")).toBe("nintendo_switch");
    expect(canonicalizeEnumValue(GAMES_PLATFORM, "Sony PlayStation 5 console")).toBe("ps5");
    expect(canonicalizeEnumValue(BABY_TYPE, "Maxi-Cosi infant car seat")).toBe("car_seat");
    expect(canonicalizeEnumValue(MUSIC_FORMAT, "vinyl LP")).toBe("vinyl");
    expect(canonicalizeEnumValue(TOOLS_TYPE, "drilling and screwdriving set")).toBeNull(); // whole-token discipline: "drilling"/"screwdriving" are NOT "drill"/"screwdriver"
  });

  it("longest candidate wins: 'city e-bike' folds to ebike, not city", () => {
    expect(canonicalizeEnumValue(BIKES_TYPE, "city e-bike")).toBe("ebike");
    expect(canonicalizeEnumValue(BIKES_TYPE, "kids mountain bike")).toBe("mtb");
  });

  it("returns null for free text that matches no declared value (dropped with a note by the validator)", () => {
    expect(canonicalizeEnumValue(TOOLS_TYPE, "screws and bolts assorted")).toBeNull();
    expect(canonicalizeEnumValue(MUSIC_FORMAT, "acoustic guitar")).toBeNull();
    expect(canonicalizeEnumValue(TOOLS_TYPE, "second hand drill press")).toBe("power"); // "drill" is a whole token here — containment fallback
    expect(canonicalizeEnumValue(GAMES_PLATFORM, "quantum flux capacitor")).toBeNull();
    expect(canonicalizeEnumValue(BEAUTY_TYPE, "   ")).toBeNull();
  });

  it("returns null for non-enum definitions (free strings are never folded)", () => {
    expect(canonicalizeEnumValue(str("model"), "Galaxy S22")).toBeNull();
    expect(canonicalizeEnumValue(str("material"), "solid oak")).toBeNull();
  });
});

describe("refineOtherCategory (THI-1182 deterministic backstop for 'other')", () => {
  it("recovers ba-2: 'infant car seat' text + model said other → baby", () => {
    expect(refineOtherCategory("Maxi-Cosi infant car seat, never in an accident, light use", REGISTRY)).toBe("baby");
  });

  it("multi-token enum values and registry aliases are the scan vocabulary", () => {
    expect(refineOtherCategory("Nintendo Switch games bundle, Mario Kart included", REGISTRY)).toBe("games");
    expect(refineOtherCategory("box of vinyl records and CDs, some cassette tapes", REGISTRY)).toBe("music");
    expect(refineOtherCategory("pram with rain cover and footmuff", REGISTRY)).toBe("baby"); // registry alias
    expect(refineOtherCategory("pair of trainers size 42", REGISTRY)).toBe("sneakers"); // registry alias
    expect(refineOtherCategory("kids bike with stabilizers, hardly used", REGISTRY)).toBe("bikes");
  });

  it("returns null when the text carries no registry signal (stays other, honest)", () => {
    expect(refineOtherCategory("Mystery box from the attic, see photo", REGISTRY)).toBeNull();
    expect(refineOtherCategory("Box of assorted craft supplies: yarn, beads, ribbons", REGISTRY)).toBeNull();
    expect(refineOtherCategory("Jar of assorted screws and bolts, mixed sizes", REGISTRY)).toBeNull();
    expect(refineOtherCategory("LEGO Star Wars Millennium Falcon, built once", REGISTRY)).toBeNull(); // prompt lever's case
    expect(refineOtherCategory("   ", REGISTRY)).toBeNull();
  });

  it("never returns 'other' and never misfires on single common-word enum values", () => {
    // 'hand' ⊆ 'second hand' would be a misfire — single-token enum values
    // are excluded from the scan by design.
    expect(refineOtherCategory("second hand wardrobe, solid pine", REGISTRY)).toBeNull();
    expect(refineOtherCategory("bundle of various items in good condition", REGISTRY)).toBeNull();
    for (const text of ["anything", "pram", "cordless drill"]) {
      const r = refineOtherCategory(text, REGISTRY);
      expect(r === null || r !== "other", `never 'other' for '${text}'`).toBe(true);
    }
  });

  it("longest match wins: 'cordless drill' text → tools (via multi-token enum alias), not home", () => {
    expect(refineOtherCategory("cordless drill with two batteries and charger", REGISTRY)).toBe("tools");
  });
});
