// THI-814 golden-set harness (spec-p1-1 rev 7766d9c3 §8): CI runs the full
// draft_listing pipeline over the 50-item fixture set with RECORDED model
// responses — offline, deterministic, no network. This tests the pipeline
// (parse → registry validation → alias resolution → attribute coercion →
// photo normalization → FMV assembly), not the model: model quality is
// measured live by scripts/extraction-eval.ts (≥90% category / ≥80%
// key-attribute accuracy, posted as PR evidence).
//
// Fixture/recorded-response integrity is checked here too — a fixture whose
// expected attributes are not declared registry keys for its category, or a
// missing recorded reply, fails the harness (annotation-drift guard, same
// spirit as the EXPECTED map in tool-annotations.test.ts).

import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { draftListing, extractionBudget } from "../src/extraction.js";
import { resolveCategory } from "../src/categories.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "fixtures", "extraction-golden");
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

interface Fixture {
  id: string;
  text?: string;
  photo?: string;
  expected: { category: string; attributes: Record<string, unknown>; condition: string };
}

const golden: Fixture[] = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, "golden-set.json"), "utf8"),
).fixtures;
const recorded: Record<string, Record<string, unknown>> = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, "recorded-responses.json"), "utf8"),
);

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
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

describe.skipIf(!available)("extraction golden set — recorded-stub CI harness (THI-814)", () => {
  let db: pg.Client;
  let registryDefs: Map<string, Array<{ key: string; type: string; enum?: string[] }>>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    const { rows } = await db.query<{ name: string; attribute_definitions: typeof registryDefs extends Map<string, infer D> ? D : never }>(
      "SELECT name, attribute_definitions FROM categories",
    );
    registryDefs = new Map(rows.map((r) => [r.name, r.attribute_definitions]));
    // Configured without any network: the fetch stub supplies every reply.
    process.env.LLM_API_KEY = "test-key";
    process.env.EXTRACTION_DAILY_CALL_CAP = "1000"; // the harness itself makes 50 calls
  });

  afterAll(async () => {
    delete process.env.LLM_API_KEY;
    delete process.env.EXTRACTION_DAILY_CALL_CAP;
    await db.end();
  });

  beforeEach(() => {
    extractionBudget.reset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    logSpy.mockRestore();
  });

  it("fixture integrity: exactly 50 unique fixtures, every one with a recorded reply", () => {
    expect(golden.length).toBe(50);
    const ids = new Set(golden.map((f) => f.id));
    expect(ids.size).toBe(50);
    for (const f of golden) {
      expect(recorded[f.id], `recorded reply for ${f.id}`).toBeDefined();
      expect(f.text || f.photo, `${f.id} has text and/or photo`).toBeTruthy();
    }
  });

  it("fixture integrity: every expected category resolves in the registry (aliases allowed)", async () => {
    for (const f of golden) {
      const resolved = await resolveCategory(f.expected.category);
      expect(resolved, `${f.id}: expected category '${f.expected.category}' must resolve`).not.toBeNull();
    }
  });

  it("fixture integrity: expected attribute keys are declared for the category, types and enums match", () => {
    for (const f of golden) {
      const defs = registryDefs.get(f.expected.category);
      expect(defs, `${f.id}: category '${f.expected.category}' exists`).toBeDefined();
      for (const [key, value] of Object.entries(f.expected.attributes)) {
        const def = defs!.find((d) => d.key === key);
        expect(def, `${f.id}: attribute '${key}' is declared for '${f.expected.category}'`).toBeDefined();
        if (def!.type === "number") expect(typeof value, `${f.id}:${key} is a number`).toBe("number");
        if (def!.type === "boolean") expect(typeof value, `${f.id}:${key} is a boolean`).toBe("boolean");
        if (def!.type === "string") expect(typeof value, `${f.id}:${key} is a string`).toBe("string");
        if (def!.enum) {
          expect(def!.enum, `${f.id}:${key} enum value '${value}' is declared`).toContain(value);
        }
      }
    }
  });

  it("replay: every fixture drafts to its expected category, condition, and key attributes", async () => {
    const mismatches: string[] = [];
    for (const f of golden) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: JSON.stringify(recorded[f.id]) } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
      );
      const photo =
        f.photo !== undefined
          ? [{ image_base64: readFileSync(path.join(FIXTURES_DIR, f.photo)).toString("base64"), media_type: "image/png" }]
          : undefined;
      const out = await draftListing({
        ...(f.text !== undefined ? { text: f.text } : {}),
        ...(photo ? { photos: photo } : {}),
      });

      if (out.draft.category !== f.expected.category) {
        mismatches.push(`${f.id}: category ${out.draft.category} != ${f.expected.category}`);
      }
      if (out.draft.condition !== f.expected.condition) {
        mismatches.push(`${f.id}: condition ${out.draft.condition} != ${f.expected.condition}`);
      }
      for (const [key, value] of Object.entries(f.expected.attributes)) {
        if (out.draft.attributes[key] !== value) {
          mismatches.push(`${f.id}: attribute ${key}=${JSON.stringify(out.draft.attributes[key])} != ${JSON.stringify(value)}`);
        }
      }
      // Degradation notes mean the pipeline mis-handled the recorded reply
      // (alias notes are informational, not degradation).
      const degradation = out.notes.filter(
        (n) => n.includes("fallback") || n.includes("dropped") || n.includes("could not be parsed"),
      );
      if (degradation.length > 0) mismatches.push(`${f.id}: degradation notes: ${degradation.join(" | ")}`);
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("replay: alias-coded recorded replies resolve through the registry", async () => {
    // sn-2's reply says 'trainers' (→ sneakers), mu-1 'vinyl' (→ music),
    // ba-1 'stroller' (→ baby) — asserted implicitly by the main replay, but
    // pinned here with the alias note so the mechanism is visible.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(recorded["sn-2"]) } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const out = await draftListing({ text: golden.find((f) => f.id === "sn-2")!.text });
    expect(out.draft.category).toBe("sneakers");
    expect(out.notes.join(" ")).toContain("'trainers' resolved via alias");
  });
});
