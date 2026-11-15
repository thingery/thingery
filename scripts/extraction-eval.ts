// THI-814 golden-set live eval (spec-p1-1 rev 7766d9c3 §8): runs the 50-item
// extraction golden set against the REAL configured provider and reports
// category accuracy (acceptance ≥90%) and key-attribute accuracy (≥80%),
// with condition accuracy reported for information. This is the manual,
// env-gated companion to the offline recorded-stub CI harness
// (tests/extraction-golden.test.ts) — no CI network, by spec.
//
// Usage:
//   DATABASE_URL=… EXTRACTION_API_KEY=… npx tsx scripts/extraction-eval.ts --live
//     --live      required: real provider calls (spends extraction budget —
//                 the deployment-wide daily cap still applies)
//     --record    write the model replies to
//                 tests/fixtures/extraction-golden/recorded-responses.json
//                 (refresh the CI stub from reality after a live run)
//     --filter=X  run only fixture ids containing X (debugging)
//
// Exits 1 when the acceptance thresholds are missed — a run must be able to
// fail loudly (same posture as backfill-embeddings).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { draftListing, extractionBudget, extractionLimits } from "../src/extraction.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, "..", "tests", "fixtures", "extraction-golden");

const LIVE = process.argv.includes("--live");
const RECORD = process.argv.includes("--record");
const FILTER = process.argv.find((a) => a.startsWith("--filter="))?.slice("--filter=".length);

const CATEGORY_ACCURACY_THRESHOLD = 0.9;
const ATTRIBUTE_ACCURACY_THRESHOLD = 0.8;

interface Fixture {
  id: string;
  text?: string;
  photo?: string;
  expected: { category: string; attributes: Record<string, unknown>; condition: string };
}

const golden: Fixture[] = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, "golden-set.json"), "utf8"),
).fixtures;

if (!LIVE) {
  console.error(
    "Refusing to run without --live: this script makes REAL provider calls that spend the " +
      "operator's extraction budget. The offline CI harness is tests/extraction-golden.test.ts.",
  );
  process.exit(1);
}
if (!process.env.LLM_API_KEY && !process.env.EXTRACTION_API_KEY) {
  console.error("EXTRACTION_API_KEY / LLM_API_KEY unset — no provider to evaluate against. Aborting.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL unset — category validation and FMV need the registry. Aborting.");
  process.exit(1);
}

const fixtures = FILTER ? golden.filter((f) => f.id.includes(FILTER)) : golden;

// Apply the schema so the category registry exists even on a bare database
// (same posture as the DB-backed suites).
{
  const bootstrap = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await bootstrap.connect();
  await bootstrap.query(readFileSync(path.resolve(__dirname, "..", "db", "schema.sql"), "utf8"));
  await bootstrap.end();
}

interface Outcome {
  id: string;
  ok: boolean;
  categoryHit: boolean;
  conditionHit: boolean;
  attrExpected: number;
  attrHit: number;
  problems: string[];
}

const outcomes: Outcome[] = [];
for (const f of fixtures) {
  const photo =
    f.photo !== undefined
      ? [
          {
            image_base64: readFileSync(path.join(FIXTURES_DIR, f.photo)).toString("base64"),
            media_type: "image/png",
          },
        ]
      : undefined;
  let out;
  try {
    out = await draftListing({
      ...(f.text !== undefined ? { text: f.text } : {}),
      ...(photo ? { photos: photo } : {}),
    });
  } catch (e) {
    outcomes.push({
      id: f.id,
      ok: false,
      categoryHit: false,
      conditionHit: false,
      attrExpected: Object.keys(f.expected.attributes).length,
      attrHit: 0,
      problems: [`pipeline error: ${e instanceof Error ? e.message : String(e)}`],
    });
    continue;
  }

  const problems: string[] = [];
  const categoryHit = out.draft.category === f.expected.category;
  const conditionHit = out.draft.condition === f.expected.condition;
  if (!categoryHit) problems.push(`category: got '${out.draft.category}', want '${f.expected.category}'`);
  if (!conditionHit) problems.push(`condition: got '${out.draft.condition}', want '${f.expected.condition}'`);
  let attrHit = 0;
  const expectedPairs = Object.entries(f.expected.attributes);
  for (const [key, want] of expectedPairs) {
    if (out.draft.attributes[key] === want) attrHit += 1;
    else problems.push(`attribute ${key}: got ${JSON.stringify(out.draft.attributes[key])}, want ${JSON.stringify(want)}`);
  }
  outcomes.push({
    id: f.id,
    ok: categoryHit && attrHit === expectedPairs.length,
    categoryHit,
    conditionHit,
    attrExpected: expectedPairs.length,
    attrHit,
    problems,
  });

  if (RECORD) {
    // Store what the model actually said (post-JSON-parse content is not
    // available here, so store the assembled validated draft as the reply —
    // the recorded file feeds the CI stub, which asserts pipeline behavior;
    // the confidence block is approximated from the draft's own confidences).
    const recordedPath = path.join(FIXTURES_DIR, "recorded-responses.json");
    const recorded = JSON.parse(readFileSync(recordedPath, "utf8")) as Record<string, unknown>;
    recorded[f.id] = {
      title: out.draft.title,
      category: out.draft.category,
      condition: out.draft.condition,
      brand: out.draft.brand ?? null,
      attributes: out.draft.attributes,
      shipping_tier_hint: out.draft.shipping_tier_hint ?? null,
      confidence: out.confidence,
      open_questions: out.openQuestions,
    };
    writeFileSync(recordedPath, JSON.stringify(recorded, null, 2) + "\n");
  }

  const mark = out.ok ? "✓" : "✗";
  console.log(
    `${mark} ${f.id}  category=${out.draft.category}(${categoryHit ? "hit" : "MISS"}) attrs=${out.attrHit}/${out.attrExpected} condition=${out.draft.condition}(${conditionHit ? "hit" : "MISS"})`,
  );
  for (const p of problems) console.log(`    ${p}`);
}

const categoryHits = outcomes.filter((o) => o.categoryHit).length;
const conditionHits = outcomes.filter((o) => o.conditionHit).length;
const attrExpected = outcomes.reduce((s, o) => s + o.attrExpected, 0);
const attrHit = outcomes.reduce((s, o) => s + o.attrHit, 0);
const categoryAccuracy = outcomes.length > 0 ? categoryHits / outcomes.length : 0;
const conditionAccuracy = outcomes.length > 0 ? conditionHits / outcomes.length : 0;
const attributeAccuracy = attrExpected > 0 ? attrHit / attrExpected : 0;

console.log("\n=== extraction eval summary ===");
console.log(`fixtures run:        ${outcomes.length} (of ${golden.length})`);
console.log(`category accuracy:   ${(categoryAccuracy * 100).toFixed(1)}%  (${categoryHits}/${outcomes.length}, threshold ≥90%)`);
console.log(`key-attr accuracy:   ${(attributeAccuracy * 100).toFixed(1)}%  (${attrHit}/${attrExpected}, threshold ≥80%)`);
console.log(`condition accuracy:  ${(conditionAccuracy * 100).toFixed(1)}%  (informational)`);
console.log(`budget used:         ${extractionBudget.usedCalls()} calls / ${extractionBudget.usedTokens()} tokens (cap ${extractionLimits.dailyCallCap}/${extractionLimits.dailyTokenBudget})`);
if (RECORD) console.log("recorded-responses.json updated from this run.");
const passed = categoryAccuracy >= CATEGORY_ACCURACY_THRESHOLD && attributeAccuracy >= ATTRIBUTE_ACCURACY_THRESHOLD;
console.log(passed ? "\nPASS — acceptance thresholds met." : "\nFAIL — below acceptance thresholds.");
process.exit(passed ? 0 : 1);
