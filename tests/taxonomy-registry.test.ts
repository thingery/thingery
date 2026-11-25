// Registry-content tests — taxonomy PR 2 (spec THI-734 §5.1–5.3, task THI-736)
// extended by THI-820 PR 1 (PC/homelab facets + pc-components/networking/nas)
// and THI-820 PR 2 (camera facets + camera-lenses/camera-accessories).
// Asserts the seeded registry itself, not the code paths around it (those are
// PR 1's tests): tree shape (8 parentless rows — 7 departments + 'other' —
// over 26 leaves), the two-level invariant, all 14 legacy slugs surviving,
// the §5.3 alias seeds and alias invariants, facet attribute definitions
// (department enum on fashion rows, size_letter on clothing) with legacy
// definitions intact, and D7 convergence (DO UPDATE): a hand-diverged row and
// a slug-colliding local row are restored by re-applying schema.sql, while
// created_at is never touched. Skips when no Postgres is reachable so bare
// `npm test` stays green locally (same convention as tests/schema.test.ts).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { validateAttributes } from "../src/attributes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    connectionTimeoutMillis: 1500,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

const available = await dbAvailable();

// Spec §5.1: department → direct children. 'other' is parentless AND childless.
const TREE: Record<string, string[]> = {
  fashion: ["accessories", "bags", "beauty", "clothing", "shoes", "sneakers"],
  kids: ["baby", "kids-clothing", "toys"],
  electronics: ["camera-accessories", "camera-lenses", "cameras", "computers", "games", "nas", "networking", "pc-components", "phones"],
  home: ["pets", "tools"],
  media: ["books", "music"],
  hobbies: ["board-games", "collectibles", "instruments"],
  sports: ["bikes"],
  other: [],
};

// The 14 legacy slugs (pre-taxonomy registry) — all must survive (D3).
const LEGACY_14 = [
  "sneakers", "shoes", "clothing", "electronics", "phones", "computers",
  "games", "books", "music", "sports", "home", "toys", "collectibles", "other",
];

// Spec §5.3 alias seed. Exact — no other row carries any alias.
const ALIASES: Record<string, string[]> = {
  sneakers: ["trainers"],
  baby: ["stroller", "pram"],
  accessories: ["jewelry"],
  phones: ["smartphone"],
  computers: ["laptop"],
  music: ["vinyl", "records"],
  "pc-components": ["pc-parts", "computer-parts", "gpu", "cpu", "motherboard", "ram"],
  networking: ["router", "routers", "network-switch", "networking-gear"],
  nas: ["storage-server", "network-storage", "diskstation"],
  "camera-lenses": ["lens", "lenses"],
  "camera-accessories": ["tripod", "speedlight", "camera-bag"],
};

interface RegistryRow {
  name: string;
  description: string;
  parent: string | null;
  aliases: string[];
  attribute_definitions: Array<{ key: string; type: string; required?: boolean; enum?: string[] }>;
}

describe.skipIf(!available)("taxonomy registry content (THI-734 §5.1–5.3)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery",
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function registry(): Promise<RegistryRow[]> {
    const { rows } = await client.query<RegistryRow>(
      `SELECT name, description, parent, aliases, attribute_definitions FROM categories ORDER BY name`,
    );
    return rows;
  }

  it("applies fresh against an empty categories table (departments-first FK ordering)", async () => {
    // Hermetic fresh apply, atomic for concurrent DB users (schema.test.ts
    // convention): no table references categories (items.category is plain
    // TEXT), so the drop is safe. A fresh apply only succeeds if every
    // department row precedes its leaves inside the single INSERT…SELECT.
    await client.query("BEGIN");
    try {
      await client.query(`DROP TABLE IF EXISTS categories CASCADE`);
      await client.query(readFileSync(schemaPath, "utf8"));
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });

  it("seeds 34 rows: 8 parentless (7 departments + other) over 26 leaves", async () => {
    const rows = await registry();
    expect(rows).toHaveLength(34);
    const parentless = rows.filter((r) => r.parent === null).map((r) => r.name).sort();
    expect(parentless).toEqual([...Object.keys(TREE)].sort());
    expect(rows.filter((r) => r.parent !== null)).toHaveLength(26);
  });

  it("wires the department → children tree exactly per spec §5.1", async () => {
    const rows = await registry();
    for (const [dept, children] of Object.entries(TREE)) {
      const actual = rows.filter((r) => r.parent === dept).map((r) => r.name).sort();
      expect(actual, `children of ${dept}`).toEqual([...children].sort());
    }
  });

  it("keeps the two-level invariant: every parent exists and every parent's parent is NULL", async () => {
    const { rows } = await client.query<{ violations: string }>(
      `SELECT c.name AS violations
       FROM categories c
       LEFT JOIN categories p ON p.name = c.parent
       WHERE c.parent IS NOT NULL AND (p.name IS NULL OR p.parent IS NOT NULL)`,
    );
    expect(rows).toEqual([]);
  });

  it("all 14 legacy slugs survive unchanged (D3 — no rename, repurpose or delete)", async () => {
    const names = new Set((await registry()).map((r) => r.name));
    for (const slug of LEGACY_14) expect(names.has(slug), slug).toBe(true);
  });

  it("seeds exactly the §5.3 aliases; no alias equals a canonical name or appears in two rows", async () => {
    const rows = await registry();
    const canonical = new Set(rows.map((r) => r.name));
    const seen = new Map<string, string>();
    for (const row of rows) {
      const expected = ALIASES[row.name] ?? [];
      expect(row.aliases, `aliases of ${row.name}`).toEqual(expected);
      for (const alias of row.aliases) {
        expect(canonical.has(alias), `alias '${alias}' must not shadow a canonical name`).toBe(false);
        const first = seen.get(alias);
        expect(first, `alias '${alias}' must map to exactly one canonical row`).toBeUndefined();
        seen.set(alias, row.name);
      }
    }
    expect(seen.size).toBe(Object.values(ALIASES).flat().length);
  });

  it("'other' stays parentless and childless (fallback leaf-dept)", async () => {
    const rows = await registry();
    const other = rows.find((r) => r.name === "other");
    expect(other?.parent).toBeNull();
    expect(rows.filter((r) => r.parent === "other")).toEqual([]);
  });

  it("converges on re-apply: hand-edited and slug-colliding local rows are restored, created_at untouched (D7)", async () => {
    // Simulate a self-hosted database that diverged from the seed (spec §5.6
    // N1 case): a hand-edited description on a legacy row, plus a locally
    // added row whose slug collides with a new seed slug ('bags').
    await client.query(`UPDATE categories SET description = 'hand-edited' WHERE name = 'sneakers'`);
    await client.query(`DELETE FROM categories WHERE name = 'bags'`);
    await client.query(
      `INSERT INTO categories (name, description, attribute_definitions, parent, aliases)
       VALUES ('bags', 'my local bags', '[]', NULL, '{}')`,
    );
    await client.query(`UPDATE categories SET created_at = now() - interval '400 days' WHERE name = 'clothing'`);
    const { rows: before } = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM categories WHERE name = 'clothing'`,
    );

    await client.query(readFileSync(schemaPath, "utf8")); // migrate re-apply

    const rows = await registry();
    const sneakers = rows.find((r) => r.name === "sneakers");
    const bags = rows.find((r) => r.name === "bags");
    expect(sneakers?.description).toBe("Trainers and sneakers");
    expect(bags?.description).toBe("Handbags, backpacks, luggage");
    expect(bags?.parent).toBe("fashion");
    const { rows: after } = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM categories WHERE name = 'clothing'`,
    );
    expect(new Date(after[0].created_at).getTime()).toBe(new Date(before[0].created_at).getTime());
  });

  it("is idempotent: re-applying the schema changes no registry row", async () => {
    const snapshot = async () =>
      (await client.query(
        `SELECT name, description, parent, aliases, attribute_definitions::text AS defs
         FROM categories ORDER BY name`,
      )).rows;
    const before = await snapshot();
    await client.query(readFileSync(schemaPath, "utf8"));
    expect(await snapshot()).toEqual(before);
  });

  it("declares the facet attributes (department enum on fashion, size_letter on clothing) with legacy definitions intact", async () => {
    const rows = await registry();
    const defs = (name: string) => {
      const row = rows.find((r) => r.name === name);
      expect(row, name).toBeDefined();
      return Object.fromEntries(row!.attribute_definitions.map((d) => [d.key, d]));
    };

    const department = { type: "string", enum: ["women", "men", "unisex", "kids"] };
    // department only where a gender split is a real query axis (§5.1 rationale):
    for (const name of ["fashion", "clothing", "shoes", "sneakers", "bags", "accessories"]) {
      expect(defs(name).department, `${name} department facet`).toMatchObject(department);
    }
    for (const name of ["beauty", "kids-clothing", "kids", "toys"]) {
      expect(defs(name).department, `${name} must not carry the department facet`).toBeUndefined();
    }

    const clothing = defs("clothing");
    expect(clothing.size).toMatchObject({ type: "string", required: true });
    expect(clothing.size_letter).toMatchObject({ type: "string", enum: ["XS", "S", "M", "L", "XL", "XXL"] });

    // Legacy definitions survive verbatim where the spec keeps them.
    expect(defs("sneakers").size_eu).toMatchObject({ type: "number", required: true });
    expect(defs("sneakers").colorway).toBeDefined();
    expect(defs("sneakers").has_original_box).toMatchObject({ type: "boolean" });
    expect(defs("games").platform).toMatchObject({
      type: "string",
      enum: ["nintendo_switch", "ps4", "ps5", "xbox_one", "xbox_series", "pc", "other"],
      required: true,
    });
    expect(defs("music").format).toMatchObject({
      type: "string",
      enum: ["vinyl", "cd", "cassette", "instrument", "other"],
    });

    // New leaves carry their §5.1 definitions.
    expect(defs("bikes").type).toMatchObject({
      type: "string",
      enum: ["road", "mtb", "city", "bmx", "ebike", "kids", "other"],
    });
    expect(defs("instruments").instrument).toMatchObject({ type: "string", required: true });
    expect(defs("board-games").players).toBeDefined();
    expect(defs("cameras").shutter_count).toMatchObject({ type: "number" });
    expect(defs("baby").type).toMatchObject({ type: "string", enum: ["pushchair", "car_seat", "nursery", "other"] });
    expect(defs("kids-clothing").size).toMatchObject({ type: "string", required: true });

    // THI-820 PR 1 (PC/homelab): computers facets deepened — legacy keys keep
    // their shape, all new keys are optional (no new required on existing rows).
    const computers = defs("computers");
    expect(computers.model).toMatchObject({ type: "string", required: true });
    expect(computers.ram_gb).toMatchObject({ type: "number" });
    expect(computers.storage_gb).toMatchObject({ type: "number" });
    expect(computers.cpu_socket).toMatchObject({ type: "string" });
    expect(computers.ram_type).toMatchObject({ type: "string", enum: ["ddr3", "ddr4", "ddr5", "other"] });
    expect(computers.rack_units).toMatchObject({ type: "number" });
    for (const key of ["cpu_model", "ram_speed_mhz", "storage_type", "gpu_model", "form_factor"]) {
      expect(computers[key], `computers.${key} declared`).toBeDefined();
      expect(computers[key]?.required, `computers.${key} stays optional`).toBeUndefined();
    }

    // New PC/homelab leaves carry their THI-820 §3.2–3.4 definitions.
    const parts = defs("pc-components");
    expect(parts.type).toMatchObject({
      type: "string",
      required: true,
      enum: ["cpu", "gpu", "motherboard", "ram", "storage", "psu", "case", "cooling", "expansion_card", "cable_adapter", "other"],
    });
    expect(parts.socket).toMatchObject({ type: "string" });
    expect(parts.vram_gb).toMatchObject({ type: "number" });
    expect(parts.form_factor).toMatchObject({ type: "string", enum: ["atx", "micro_atx", "mini_itx", "other"] });
    const net = defs("networking");
    expect(net.type).toMatchObject({
      type: "string",
      required: true,
      enum: ["switch", "router", "access_point", "firewall", "modem", "patch_panel", "pdu", "other"],
    });
    expect(net.ports).toMatchObject({ type: "number" });
    expect(net.poe).toMatchObject({ type: "boolean" });
    expect(net.managed).toMatchObject({ type: "boolean" });
    expect(net.rack_units).toMatchObject({ type: "number" });
    const nas = defs("nas");
    expect(nas.model).toMatchObject({ type: "string", required: true });
    expect(nas.drive_bays).toMatchObject({ type: "number" });
    expect(nas.drive_form).toMatchObject({ type: "string", enum: ["2.5in", "3.5in", "m2", "mixed", "other"] });

    // THI-820 PR 2 (camera gear): cameras facets deepened — legacy keys keep
    // their shape (model stays optional), all new keys are optional.
    const cams = defs("cameras");
    expect(cams.model).toMatchObject({ type: "string" });
    expect(cams.shutter_count).toMatchObject({ type: "number" });
    expect(cams.type).toMatchObject({
      type: "string",
      enum: ["dslr", "mirrorless", "compact", "film", "instant", "action", "drone", "other"],
    });
    expect(cams.sensor_format).toMatchObject({
      type: "string",
      enum: ["full_frame", "aps_c", "micro_four_thirds", "1_inch", "medium_format", "other"],
    });
    expect(cams.lens_mount).toMatchObject({ type: "string" });
    expect(cams.video_max_res).toMatchObject({ type: "string", enum: ["720p", "1080p", "4k", "6k", "8k", "other"] });
    expect(cams.ibis).toMatchObject({ type: "boolean" });
    expect(cams.weather_sealed).toMatchObject({ type: "boolean" });
    for (const key of ["type", "sensor_format", "lens_mount", "megapixels", "video_max_res", "ibis", "weather_sealed"]) {
      expect(cams[key]?.required, `cameras.${key} stays optional`).toBeUndefined();
    }

    // New camera leaves carry their THI-820 §3.6–3.7 definitions.
    const lens = defs("camera-lenses");
    expect(lens.lens_mount).toMatchObject({ type: "string", required: true });
    expect(lens.focal_length_mm).toMatchObject({ type: "string" });
    expect(lens.max_aperture).toMatchObject({ type: "string" });
    expect(lens.zoom).toMatchObject({ type: "boolean" });
    expect(lens.image_stabilization).toMatchObject({ type: "boolean" });
    expect(lens.filter_thread_mm).toMatchObject({ type: "number" });
    const acc = defs("camera-accessories");
    expect(acc.type).toMatchObject({
      type: "string",
      required: true,
      enum: ["flash", "tripod", "filter", "battery", "grip", "strap", "bag", "memory_card", "light", "remote", "cable", "cleaning", "other"],
    });
    expect(acc.compatible_mount).toMatchObject({ type: "string" });
    expect(acc.capacity_mah).toMatchObject({ type: "number" });
    expect(acc.load_kg).toMatchObject({ type: "number" });
  });

  it("validates new facets and keeps legacy values accepted (validateAttributes over the live registry)", async () => {
    const rows = await registry();
    const liveDefs = (name: string) => rows.find((r) => r.name === name)!.attribute_definitions;

    // clothing: legacy free-text size still required and accepted; size_letter
    // and department are validated enums; out-of-enum values are rejected.
    expect(validateAttributes(liveDefs("clothing"), { size: "M", size_letter: "L", department: "men" })).toEqual([]);
    expect(validateAttributes(liveDefs("clothing"), { size: "42" })).toEqual([]);
    expect(validateAttributes(liveDefs("clothing"), { size_letter: "L", department: "men" }).join("; ")).toContain('"size"');
    expect(validateAttributes(liveDefs("clothing"), { size: "M", size_letter: "XXXL" }).join("; ")).toContain("size_letter");
    expect(validateAttributes(liveDefs("clothing"), { size: "M", department: "mens" }).join("; ")).toContain("department");

    // sneakers: legacy size_eu requirement unchanged alongside the new facet.
    expect(validateAttributes(liveDefs("sneakers"), { department: "women" }).join("; ")).toContain("size_eu");

    // games: platform enum unchanged.
    expect(validateAttributes(liveDefs("games"), { platform: "ps5" })).toEqual([]);
    expect(validateAttributes(liveDefs("games"), { platform: "dreamcast" }).join("; ")).toContain("platform");

    // music: 'instrument' stays a valid legacy format value even though new
    // instrument listings are steered to hobbies/instruments by description.
    expect(validateAttributes(liveDefs("music"), { format: "instrument" })).toEqual([]);

    // THI-820 PR 1: legacy computers payloads without new keys stay accepted;
    // new facets validate when present; new leaves enforce their required key.
    expect(validateAttributes(liveDefs("computers"), { model: "ThinkCentre M720q" })).toEqual([]);
    expect(validateAttributes(liveDefs("computers"), { model: "M720q", cpu_socket: "LGA1151", ram_type: "ddr4", rack_units: 1 })).toEqual([]);
    expect(validateAttributes(liveDefs("computers"), { model: "M720q", ram_type: "ddr9" }).join("; ")).toContain("ram_type");
    expect(validateAttributes(liveDefs("computers"), { model: "M720q", rack_units: "1U" }).join("; ")).toContain("rack_units");
    expect(validateAttributes(liveDefs("pc-components"), { type: "gpu", vram_gb: 16 })).toEqual([]);
    expect(validateAttributes(liveDefs("pc-components"), { vram_gb: 16 }).join("; ")).toContain('"type"');
    expect(validateAttributes(liveDefs("pc-components"), { type: "tape_drive" }).join("; ")).toContain("type");
    expect(validateAttributes(liveDefs("networking"), { type: "switch", ports: 8, port_speed_mbps: 10000, poe: true, managed: true })).toEqual([]);
    expect(validateAttributes(liveDefs("networking"), { ports: 8 }).join("; ")).toContain('"type"');
    expect(validateAttributes(liveDefs("nas"), { model: "DS923+", drive_bays: 4, drive_form: "3.5in" })).toEqual([]);
    expect(validateAttributes(liveDefs("nas"), { drive_bays: 4 }).join("; ")).toContain("model");

    // THI-820 PR 2: legacy cameras payloads (even empty) stay accepted; new
    // facets validate when present; new leaves enforce their required key.
    expect(validateAttributes(liveDefs("cameras"), {})).toEqual([]);
    expect(validateAttributes(liveDefs("cameras"), { shutter_count: 12500 })).toEqual([]);
    expect(validateAttributes(liveDefs("cameras"), {
      model: "A7 III", type: "mirrorless", sensor_format: "full_frame", lens_mount: "Sony E", megapixels: 24, video_max_res: "4k", ibis: true, weather_sealed: true,
    })).toEqual([]);
    expect(validateAttributes(liveDefs("cameras"), { sensor_format: "medium format" }).join("; ")).toContain("sensor_format");
    expect(validateAttributes(liveDefs("cameras"), { megapixels: "24" }).join("; ")).toContain("megapixels");
    expect(validateAttributes(liveDefs("camera-lenses"), {
      lens_mount: "Sony E", focal_length_mm: "24-70", max_aperture: "f/2.8", zoom: true, image_stabilization: true, filter_thread_mm: 77,
    })).toEqual([]);
    expect(validateAttributes(liveDefs("camera-lenses"), { focal_length_mm: "50" }).join("; ")).toContain("lens_mount");
    expect(validateAttributes(liveDefs("camera-lenses"), { lens_mount: "Sony E", zoom: "yes" }).join("; ")).toContain("zoom");
    expect(validateAttributes(liveDefs("camera-accessories"), { type: "tripod", load_kg: 8 })).toEqual([]);
    expect(validateAttributes(liveDefs("camera-accessories"), { filter_size_mm: 77 }).join("; ")).toContain('"type"');
    expect(validateAttributes(liveDefs("camera-accessories"), { type: "drone" }).join("; ")).toContain("type");
  });
});
