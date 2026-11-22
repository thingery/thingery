// THI-814 (P1-2 draft_listing extraction, ADR 0009): unit tests for the pure
// layers (FMV math, JSON parsing, title clamp, budget guard, request schema,
// photo normalization) + DB-backed tests for the validation post-pass and the
// full pipeline with a scripted provider (fetch stub — no real LLM, no
// network). Event capture follows the chat.test.ts console-spy pattern;
// seeding follows the search-items test pattern.

import { describe, expect, it, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import sharp from "sharp";
import pg from "pg";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeFmv,
  percentile,
  conditionBand,
  clampTitle,
  parseDraftJson,
  normalizeCompletionsUrl,
  normalizePhoto,
  validateModelDraft,
  draftListing,
  draftListingRequestSchema,
  ExtractionBudget,
  ExtractionError,
  extractionBudget,
  extractionLimits,
  loadRegistry,
  type RegistryEntry,
} from "../src/extraction.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

// ---------------------------------------------------------------------------
// Pure: FMV math
// ---------------------------------------------------------------------------

describe("FMV math (ADR 0009 §3 — deterministic, no LLM in the math)", () => {
  it("percentile interpolates linearly on sorted input", () => {
    expect(percentile([100], 0.25)).toBe(100);
    expect(percentile([100, 200, 300, 400], 0.25)).toBe(175);
    expect(percentile([100, 200, 300, 400], 0.75)).toBe(325);
    expect(percentile([100, 200, 300], 0.5)).toBe(200);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });

  it("n=0 → nulls + method 'none'", () => {
    const fmv = computeFmv([], "EUR");
    expect(fmv.min_cents).toBeNull();
    expect(fmv.max_cents).toBeNull();
    expect(fmv.method).toBe("none");
    expect(fmv.basis).toBe("asking_prices");
    expect(fmv.n_comparables).toBe(0);
    expect(fmv.currency).toBe("EUR");
  });

  it("n≥3 → p25–p75, rounded outward to whole units (range never shrinks)", () => {
    // p25 = 1018.75 → floor 10.00 EUR; p75 = 2287.5 → ceil 23.00 EUR.
    const fmv = computeFmv([1000, 1025, 2050, 3000], "EUR");
    expect(fmv.method).toBe("comparables_p25_p75");
    expect(fmv.min_cents).toBe(1000);
    expect(fmv.max_cents).toBe(2300);
    expect(fmv.n_comparables).toBe(4);
  });

  it("n=1–2 → median ±20%, rounded outward", () => {
    const one = computeFmv([5000], "EUR");
    expect(one.method).toBe("median_spread_20");
    expect(one.min_cents).toBe(4000);
    expect(one.max_cents).toBe(6000);
    const two = computeFmv([4000, 5000], "EUR"); // median 4500 → 3600..5400
    expect(two.min_cents).toBe(3600);
    expect(two.max_cents).toBe(5400);
  });
});

describe("condition band for comparable search", () => {
  it("extracted grade plus adjacent grades", () => {
    expect(conditionBand("good")).toEqual(["like_new", "good", "fair"]);
    expect(conditionBand("new")).toEqual(["new", "like_new"]);
    expect(conditionBand("poor")).toEqual(["fair", "poor"]);
  });

  it("unknown condition degrades to the full scale", () => {
    expect(conditionBand("banana").length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Pure: parsing + clamping + URL normalization
// ---------------------------------------------------------------------------

describe("parseDraftJson (robust model-output extraction)", () => {
  it("parses a clean object", () => {
    expect(parseDraftJson('{"title": "Bike"}')).toEqual({ title: "Bike" });
  });

  it("parses inside markdown fences", () => {
    expect(parseDraftJson('```json\n{"title": "Bike"}\n```')).toEqual({ title: "Bike" });
  });

  it("parses an object wrapped in prose", () => {
    expect(parseDraftJson('Sure! Here is the draft: {"title": "Bike"} — hope it helps.')).toEqual({
      title: "Bike",
    });
  });

  it("returns null on garbage rather than throwing", () => {
    expect(parseDraftJson("no json here")).toBeNull();
    expect(parseDraftJson('{"title": truncated')).toBeNull();
    expect(parseDraftJson("[1,2,3]")).toBeNull(); // arrays are not drafts
  });
});

describe("clampTitle (3–200, deterministic fallback chain)", () => {
  it("keeps a good model title", () => {
    expect(clampTitle("Vintage BMX bike", "old bike")).toEqual({ title: "Vintage BMX bike", degraded: false });
  });

  it("falls back to the seller text when the model title is too short", () => {
    expect(clampTitle("ok", "Rusty frame bike")).toEqual({ title: "Rusty frame bike", degraded: true });
  });

  it("falls back to the constant when everything is too short", () => {
    expect(clampTitle("", "hi")).toEqual({ title: "Draft listing", degraded: true });
  });

  it("clamps overlong titles to 200 chars", () => {
    const { title } = clampTitle("x".repeat(500), undefined);
    expect(title.length).toBe(200);
  });
});

describe("normalizeCompletionsUrl (LLM_API_URL seam posture)", () => {
  it("appends /chat/completions to a bare base", () => {
    expect(normalizeCompletionsUrl("https://api.z.ai/api/paas/v4/")).toBe(
      "https://api.z.ai/api/paas/v4/chat/completions",
    );
  });

  it("passes a full completions URL through", () => {
    expect(normalizeCompletionsUrl("https://api.openai.com/v1/chat/completions")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("falls back to the default on garbage or empty", () => {
    expect(normalizeCompletionsUrl(undefined)).toContain("api.openai.com/v1/chat/completions");
    expect(normalizeCompletionsUrl("not a url")).toContain("api.openai.com/v1/chat/completions");
  });
});

// ---------------------------------------------------------------------------
// Pure: budget guard (mirrors chat-limits semantics)
// ---------------------------------------------------------------------------

describe("ExtractionBudget", () => {
  const limits = { dailyCallCap: 3, dailyTokenBudget: 1000 };
  const day1 = new Date("2026-01-10T10:00:00Z");

  it("charges calls and tokens, exhausts on the call cap with the knob named", () => {
    const b = new ExtractionBudget(limits, day1);
    b.record({ promptTokens: 100, completionTokens: 50 }, 0, day1);
    expect(b.isExhausted(day1)).toBeNull();
    b.record({ promptTokens: 100, completionTokens: 50 }, 0, day1);
    b.record({ promptTokens: 100, completionTokens: 50 }, 0, day1);
    expect(b.isExhausted(day1)).toMatchObject({ reason: "call_cap", calls: 3, tokens: 450 });
  });

  it("exhausts on the token budget with the knob named", () => {
    const b = new ExtractionBudget({ dailyCallCap: 0, dailyTokenBudget: 100 }, day1);
    b.record({ promptTokens: 60, completionTokens: 50 }, 0, day1);
    expect(b.isExhausted(day1)).toMatchObject({ reason: "token_budget", tokens: 110 });
  });

  it("rolls over on UTC-day change", () => {
    const b = new ExtractionBudget(limits, day1);
    b.record({ promptTokens: 900, completionTokens: 900 }, 0, day1);
    expect(b.isExhausted(day1)).not.toBeNull();
    const day2 = new Date("2026-01-11T00:00:01Z");
    expect(b.isExhausted(day2)).toBeNull();
    expect(b.usedTokens(day2)).toBe(0);
  });

  it("0 = off on both knobs (explicit opt-out)", () => {
    const b = new ExtractionBudget({ dailyCallCap: 0, dailyTokenBudget: 0 }, day1);
    for (let i = 0; i < 100; i++) b.record({ promptTokens: 1e9, completionTokens: 1e9 }, 0, day1);
    expect(b.isExhausted(day1)).toBeNull();
  });

  it("charges the fallback estimate when the provider omits usage", () => {
    const b = new ExtractionBudget({ dailyCallCap: 5, dailyTokenBudget: 0 }, day1);
    b.record(null, 1234, day1);
    expect(b.usedTokens(day1)).toBe(1234);
    b.record(null, -50, day1); // negative fallback cannot credit the budget
    expect(b.usedTokens(day1)).toBe(1234);
  });

  it("throttle warning fires exactly once per UTC day at ≥80%", () => {
    const b = new ExtractionBudget({ dailyCallCap: 10, dailyTokenBudget: 0 }, day1);
    expect(b.consumeThrottleWarning(day1)).toBe(false);
    b.record(null, 0, day1);
    for (let i = 1; i < 8; i++) b.record(null, 0, day1); // 8/10 calls
    expect(b.consumeThrottleWarning(day1)).toBe(true);
    expect(b.consumeThrottleWarning(day1)).toBe(false);
    // New day re-arms (state rolled over).
    expect(b.consumeThrottleWarning(new Date("2026-01-11T10:00:00Z"))).toBe(false);
  });

  it("reset() restores a clean day (test isolation)", () => {
    const b = new ExtractionBudget(limits, day1);
    b.record({ promptTokens: 1000, completionTokens: 1000 }, 0, day1);
    b.reset(day1);
    expect(b.isExhausted(day1)).toBeNull();
    expect(b.usedCalls(day1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pure: request schema (shared by MCP tool and POST /api/draft-listing)
// ---------------------------------------------------------------------------

describe("draftListingRequestSchema", () => {
  it("accepts text only, photo only, and both", () => {
    expect(draftListingRequestSchema.safeParse({ text: "bmx" }).success).toBe(true);
    expect(
      draftListingRequestSchema.safeParse({ photos: [{ image_base64: "a".repeat(60), media_type: "image/png" }] })
        .success,
    ).toBe(true);
    expect(
      draftListingRequestSchema.safeParse({
        text: "bmx",
        photos: [{ image_base64: "a".repeat(60), media_type: "image/png" }],
      }).success,
    ).toBe(true);
  });

  it("rejects neither, two photos, bad media types, and overlong text", () => {
    expect(draftListingRequestSchema.safeParse({}).success).toBe(false);
    expect(draftListingRequestSchema.safeParse({ text: "   " }).success).toBe(false);
    expect(
      draftListingRequestSchema.safeParse({
        photos: [
          { image_base64: "a".repeat(60), media_type: "image/png" },
          { image_base64: "b".repeat(60), media_type: "image/png" },
        ],
      }).success,
    ).toBe(false); // v1 single-photo limit (spec §11.1)
    expect(
      draftListingRequestSchema.safeParse({ photos: [{ image_base64: "a".repeat(60), media_type: "image/avif" }] })
        .success,
    ).toBe(false);
    expect(draftListingRequestSchema.safeParse({ text: "x".repeat(501) }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Photo normalization (real sharp round-trip)
// ---------------------------------------------------------------------------

describe("normalizePhoto (ADR 0004 strip path + ≤768px downsample)", () => {
  it("re-encodes a valid PNG to a ≤768px JPEG data URL", async () => {
    const png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#224" } })
      .png()
      .toBuffer();
    const url = await normalizePhoto({ image_base64: png.toString("base64"), media_type: "image/png" });
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
    const meta = await sharp(Buffer.from(url.split(",")[1], "base64")).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(768);
  });

  it("accepts a data-URL prefix (stripped before decode)", async () => {
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#333" } })
      .png()
      .toBuffer();
    const url = await normalizePhoto({
      image_base64: `data:image/png;base64,${png.toString("base64")}`,
      media_type: "image/png",
    });
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("rejects declared-type mismatch (content sniffing wins)", async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#111" } })
      .png()
      .toBuffer();
    await expect(
      normalizePhoto({ image_base64: png.toString("base64"), media_type: "image/jpeg" }),
    ).rejects.toMatchObject({ code: "invalid_image" });
  });

  it("rejects undecodable bytes", async () => {
    await expect(
      normalizePhoto({ image_base64: Buffer.from("this is not an image at all").toString("base64"), media_type: "image/png" }),
    ).rejects.toMatchObject({ code: "invalid_image" });
  });

  it("rejects oversized images before decoding", async () => {
    await expect(
      normalizePhoto({ image_base64: "e".repeat(5 * 1024 * 1024 + 2048), media_type: "image/png" }),
    ).rejects.toMatchObject({ code: "invalid_image" });
  });
});

// ---------------------------------------------------------------------------
// DB-backed: validation post-pass + full pipeline
// ---------------------------------------------------------------------------

describe("validateModelDraft + draftListing (DB + scripted provider)", () => {
  let db: pg.Client;
  let sellerId: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const COMPARABLE_CATEGORY = "toys"; // seeded leaf: age_range attribute
  const SNEAKERS: RegistryEntry = {
    name: "sneakers",
    parent: "fashion",
    description: "Trainers and sneakers",
    defs: [
      { key: "size_eu", type: "number", required: true },
      { key: "colorway", type: "string" },
      { key: "has_original_box", type: "boolean" },
      { key: "department", type: "string", enum: ["women", "men", "unisex", "kids"] },
    ],
  };
  const OTHER: RegistryEntry = { name: "other", parent: null, description: "fallback", defs: [] };

  /** Scripted provider response: an OpenAI-style chat-completions body. */
  function llmBody(content: string, usage?: Record<string, number>) {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) }),
    };
  }
  function llmResponse(content: string, usage?: Record<string, number>) {
    const b = llmBody(content, usage);
    return new Response(b.body, { status: b.status, headers: b.headers });
  }

  const goodDraftJson = JSON.stringify({
    title: "Vintage wooden puzzle set",
    description: "Complete, all pieces present",
    category: "toys",
    condition: "like_new",
    brand: null,
    attributes: { age_range: "6+" },
    shipping_tier_hint: "parcel",
    confidence: { category: 0.9, condition: 0.8, title: 0.7, attributes: { age_range: 0.9 } },
    open_questions: ["Any missing pieces?"],
  });

  beforeAll(async () => {
    db = new pg.Client({ connectionString });
    await db.connect();
    await db.query(readFileSync(schemaPath, "utf8"));
    // Isolated seller for this run; comparables seeded in a seeded leaf
    // category. TRUNCATE-free on purpose — other suites may share the DB.
    const seller = await db.query<{ id: string }>(
      `INSERT INTO sellers (api_key_hash, display_name, email) VALUES ($1, 'extraction-tests', $2) RETURNING id`,
      [`thg_extraction_${Date.now()}`, `extraction-${Date.now()}@t.dev`],
    );
    sellerId = seller.rows[0].id;
    // Three active comparables in 'toys' with EUR prices (2.50, 5, 11.50).
    // Titles contain the model-draft title ("Vintage wooden puzzle set") so
    // the keyword fallback's ILIKE substring probe hits without embeddings.
    for (const [title, cents] of [
      ["Vintage wooden puzzle set small", 250],
      ["Vintage wooden puzzle set medium", 500],
      ["Vintage wooden puzzle set large", 1150],
    ] as const) {
      await db.query(
        `INSERT INTO items (seller_id, title, price_cents, category, condition, images, currency)
         VALUES ($1, $2, $3, $4, 'like_new', ARRAY['https://img.example.com/p.jpg'], 'EUR')`,
        [sellerId, title, cents, COMPARABLE_CATEGORY],
      );
    }
    process.env.LLM_API_KEY = "test-key"; // configured without any network
  });

  afterAll(async () => {
    delete process.env.LLM_API_KEY;
    delete process.env.EXTRACTION_API_KEY;
    await db.query(`DELETE FROM items WHERE seller_id = $1`, [sellerId]);
    await db.query(`DELETE FROM sellers WHERE id = $1`, [sellerId]);
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

  function jsonLines(type: string): Array<Record<string, unknown>> {
    return logSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.startsWith('{"ts":'))
      .map((s) => JSON.parse(s))
      .filter((o: Record<string, unknown>) => o.type === type);
  }

  it("validateModelDraft: unknown category → other + note + confidence ≤0.4 + open question", async () => {
    const core = await validateModelDraft(
      { title: "Mystery gadget", category: "quantum-flux-capacitor", condition: "good", confidence: { category: 0.9 } },
      undefined,
      [OTHER],
    );
    expect(core.draft.category).toBe("other");
    expect(core.confidence.category).toBeLessThanOrEqual(0.4);
    expect(core.notes.join(" ")).toContain("category fallback to other");
    expect(core.openQuestions.join(" ")).toContain("category");
  });

  it("validateModelDraft: resolves aliases through the registry (trainers → sneakers)", async () => {
    const core = await validateModelDraft(
      { title: "White trainers", category: "trainers", condition: "good", attributes: { size_eu: "42" } },
      undefined,
      await loadRegistry(),
    );
    expect(core.draft.category).toBe("sneakers");
    expect(core.notes.join(" ")).toContain("alias");
    expect(core.draft.attributes.size_eu).toBe(42); // numeric string coerced to number
  });

  it("validateModelDraft: enum free text folds to the declared slug (THI-1182), non-matching text is dropped", async () => {
    const core = await validateModelDraft(
      {
        title: "Bosch cordless drill",
        category: "tools",
        condition: "good",
        attributes: { type: "cordless drill" }, // marketplace vocabulary → declared enum
      },
      undefined,
      await loadRegistry(),
    );
    expect(core.draft.attributes.type).toBe("power"); // canonicalized, not raw free text
    expect(core.notes.join(" ")).toContain("attribute 'type' canonicalized from 'cordless drill' to 'power'");

    const dropped = await validateModelDraft(
      {
        title: "Jar of screws",
        category: "tools",
        condition: "good",
        attributes: { type: "screws and bolts assorted" }, // matches no declared value
      },
      undefined,
      await loadRegistry(),
    );
    expect(dropped.draft.attributes.type).toBeUndefined(); // the old fallthrough leaked raw text here
    expect(dropped.notes.join(" ")).toContain("dropped");
  });

  it("validateModelDraft: 'other' + car-seat text → refined to baby by registry keyword scan (THI-1182 backstop)", async () => {
    const core = await validateModelDraft(
      {
        title: "Maxi-Cosi infant car seat",
        category: "car-seat", // resolves to nothing → 'other' path
        condition: "good",
        confidence: { category: 0.2 },
      },
      "Maxi-Cosi infant car seat, never in an accident, light use",
      await loadRegistry(),
    );
    expect(core.draft.category).toBe("baby");
    expect(core.notes.join(" ")).toContain("refined to 'baby'");
    expect(core.confidence.category).toBeGreaterThanOrEqual(0.6);
    expect(core.openQuestions.join(" ")).not.toContain("Which category"); // no longer an open question
  });

  it("validateModelDraft: attribute shape rules — undeclared dropped, ill-typed dropped, enum canonicalized, boolean string coerced", async () => {
    const core = await validateModelDraft(
      {
        title: "White trainers",
        category: "sneakers",
        condition: "good",
        attributes: {
          size_eu: 43, // declared number — kept
          colorway: "  white/grey  ", // trimmed string — kept
          has_original_box: "true", // boolean string coerced
          department: "MEN", // enum canonicalized to the declared casing
          brand_model: "Air Max 90", // NOT declared — dropped
          size_eu_typo: 43, // NOT declared — dropped
        },
      },
      undefined,
      [SNEAKERS],
    );
    expect(core.draft.attributes).toEqual({
      size_eu: 43,
      colorway: "white/grey",
      has_original_box: true,
      department: "men",
    });
    const notes = core.notes.join(" ");
    expect(notes).toContain("brand_model");
    expect(notes).toContain("not declared");
  });

  it("validateModelDraft: ill-typed attribute value dropped with a note", async () => {
    const core = await validateModelDraft(
      { title: "White trainers", category: "sneakers", condition: "good", attributes: { size_eu: "not-a-number" } },
      undefined,
      [SNEAKERS],
    );
    expect(core.draft.attributes.size_eu).toBeUndefined();
    expect(core.notes.join(" ")).toContain("size_eu");
    expect(core.notes.join(" ")).toContain("number");
  });

  it("validateModelDraft: invalid condition → good + open question", async () => {
    const core = await validateModelDraft(
      { title: "Old ladder", category: "other", condition: "pristine-mint", confidence: { condition: 0.9 } },
      undefined,
      [OTHER],
    );
    expect(core.draft.condition).toBe("good");
    expect(core.notes.join(" ")).toContain("condition fallback");
    expect(core.openQuestions.join(" ")).toContain("condition");
  });

  it("happy path: text-only draft with real comparables → validated draft + deterministic FMV + one usage event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => llmResponse(goodDraftJson, { prompt_tokens: 500, completion_tokens: 120 })));
    const out = await draftListing({ text: "wooden puzzle set for kids", sellerId });

    // Draft fields pass registry validation.
    expect(out.draft.title).toBe("Vintage wooden puzzle set");
    expect(out.draft.category).toBe("toys");
    expect(out.draft.condition).toBe("like_new");
    expect(out.draft.attributes.age_range).toBe("6+");
    expect(out.draft.shipping_tier_hint).toBe("parcel");
    expect(out.confidence.category).toBe(0.9);

    // FMV from the three seeded EUR comparables: p25 of [250,500,1150] = 312.5
    // → rounds DOWN to 300; p75 = 862.5 → rounds UP to 900. n=3 → p25–p75.
    expect(out.fair_market_value).toMatchObject({
      min_cents: 300,
      max_cents: 900,
      currency: "EUR",
      method: "comparables_p25_p75",
      basis: "asking_prices",
      n_comparables: 3,
    });
    expect(out.comparables.length).toBe(3);
    expect(out.comparables[0].url).toMatch(/\/item\/[0-9a-f-]{36}$/);
    expect(out.notes).toEqual([]);
    expect(out.open_questions).toEqual(["Any missing pieces?"]);

    // Exactly one extraction_usage line: numbers and slugs only.
    const usage = jsonLines("extraction_usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: "gpt-4o-mini",
      photo_count: 0,
      tokens_in: 500,
      tokens_out: 120,
      call_cap: 200,
      token_budget: 1_000_000,
      usage_source: "provider",
      sellerId,
    });
    expect(jsonLines("extraction_budget")).toHaveLength(0);
    // Budget was charged: 500 + 120.
    expect(extractionBudget.usedTokens()).toBe(620);
    expect(extractionBudget.usedCalls()).toBe(1);
  });

  it("the provider receives a JSON-mode request with the registry in the prompt (no photo part for text-only)", async () => {
    const fetchMock = vi.fn(async () => llmResponse(goodDraftJson));
    vi.stubGlobal("fetch", fetchMock);
    await draftListing({ text: "wooden puzzle set", sellerId });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/chat/completions");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.model).toBe("gpt-4o-mini");
    const system = body.messages.find((m) => m.role === "system");
    expect(String(system?.content)).toContain("registry");
    const user = body.messages.find((m) => m.role === "user");
    expect(typeof user?.content).toBe("string");
    expect(String(user?.content)).toContain("Seller description: wooden puzzle set");
    expect(String(user?.content)).toContain("toys");
  });

  it("photo path: the provider gets a downscaled JPEG data-URL part, original bytes never leave the process", async () => {
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#7a5" } })
      .png()
      .toBuffer();
    const fetchMock = vi.fn(async () => llmResponse(goodDraftJson));
    vi.stubGlobal("fetch", fetchMock);
    const out = await draftListing({
      photos: [{ image_base64: png.toString("base64"), media_type: "image/png" }],
      sellerId,
    });
    expect(out.draft.category).toBe("toys");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      messages: Array<{ content: unknown }>;
    };
    const parts = body.messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    const imagePart = parts.find((p) => p.type === "image_url");
    expect(imagePart).toBeDefined();
    expect(imagePart!.image_url!.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    // Downsampled, not the original: decodes to ≤768px and is much smaller
    // than a 1200×800 PNG.
    const sent = Buffer.from(imagePart!.image_url!.url.split(",")[1], "base64");
    const meta = await sharp(sent).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(768);
    const usage = jsonLines("extraction_usage")[0];
    expect(usage.photo_count).toBe(1);
  });

  it("unparseable model output degrades to an empty draft + note — never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => llmResponse("I cannot help with that.")));
    const out = await draftListing({ text: "wooden puzzle set", sellerId });
    expect(out.draft.title).toBe("wooden puzzle set"); // falls back to seller text
    expect(out.draft.category).toBe("other");
    expect(out.confidence.category).toBeLessThanOrEqual(0.4);
    expect(out.notes.join(" ")).toContain("could not be parsed");
    expect(out.open_questions.join(" ")).toContain("describe the item");
    expect(out.fair_market_value.method).toBe("none"); // no usable comparables for 'other'
  });

  it("mixed-currency comparables: modal currency wins, others excluded with a note", async () => {
    // One USD listing joins the three EUR ones.
    await db.query(
      `INSERT INTO items (seller_id, title, price_cents, category, condition, images, currency)
       VALUES ($1, 'Vintage wooden puzzle set usd', 999, $2, 'like_new', ARRAY['https://img.example.com/p.jpg'], 'USD')`,
      [sellerId, COMPARABLE_CATEGORY],
    );
    try {
      vi.stubGlobal("fetch", vi.fn(async () => llmResponse(goodDraftJson)));
      const out = await draftListing({ text: "wooden puzzle set", sellerId });
      expect(out.fair_market_value.currency).toBe("EUR");
      expect(out.fair_market_value.n_comparables).toBe(3);
      expect(out.comparables.length).toBe(3);
      expect(out.notes.join(" ")).toContain("USD");
      expect(out.notes.join(" ")).toContain("excluded");
    } finally {
      await db.query(`DELETE FROM items WHERE title = 'Vintage wooden puzzle set usd'`);
    }
  });

  it("provider 402 → typed error + insufficient-balance alert event (D7)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Insufficient balance" } }), { status: 402 })),
    );
    await expect(draftListing({ text: "wooden puzzle set", sellerId })).rejects.toMatchObject({
      code: "extraction_provider_unavailable",
    });
    const alerts = jsonLines("extraction_budget");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].action).toBe("provider_insufficient_balance");
    // The failed call is NOT charged — budget accounting stays honest about
    // completed work only.
    expect(extractionBudget.usedCalls()).toBe(0);
  });

  it("provider 500 → typed error, no alert (transient), no charge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(draftListing({ text: "wooden puzzle set", sellerId })).rejects.toMatchObject({
      code: "extraction_provider_unavailable",
    });
    expect(jsonLines("extraction_budget")).toHaveLength(0);
    expect(extractionBudget.usedCalls()).toBe(0);
  });

  it("budget exhausted → typed error + budget event, and the provider is never called", async () => {
    extractionBudget.record(null, Number.MAX_SAFE_INTEGER); // exhaust tokens for today
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(draftListing({ text: "wooden puzzle set", sellerId })).rejects.toMatchObject({
      code: "extraction_budget_exhausted",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const events = jsonLines("extraction_budget");
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("token_budget_exhausted");
    expect(events[0].daily_tokens as number).toBeGreaterThan(extractionLimits.dailyTokenBudget);
  });

  it("not configured → fail-closed typed error before any spend", async () => {
    // Save/restore: process.env is worker-wide state — later tests in this
    // file must still see a configured deployment.
    const saved = { llm: process.env.LLM_API_KEY, extraction: process.env.EXTRACTION_API_KEY };
    try {
      delete process.env.LLM_API_KEY;
      delete process.env.EXTRACTION_API_KEY;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(draftListing({ text: "wooden puzzle set", sellerId })).rejects.toMatchObject({
        code: "extraction_not_configured",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(jsonLines("extraction_usage")).toHaveLength(0);
    } finally {
      if (saved.llm !== undefined) process.env.LLM_API_KEY = saved.llm;
      if (saved.extraction !== undefined) process.env.EXTRACTION_API_KEY = saved.extraction;
    }
  });

  it("invalid photo fails before the provider call (no spend on client error)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      draftListing({
        photos: [{ image_base64: Buffer.from("not an image").toString("base64"), media_type: "image/png" }],
        sellerId,
      }),
    ).rejects.toMatchObject({ code: "invalid_image" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing usage falls back to the deterministic estimate and the event says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => llmResponse(goodDraftJson)));
    await draftListing({ text: "wooden puzzle set", sellerId });
    const usage = jsonLines("extraction_usage")[0];
    expect(usage.usage_source).toBe("estimate_fallback");
    // The provider gave no numbers, so tokens_in/out are 0 — the fallback
    // charge shows in the daily_tokens counter, not in per-call fields.
    expect(usage.tokens_in).toBe(0);
    expect(usage.tokens_out).toBe(0);
    expect(extractionBudget.usedTokens()).toBeGreaterThan(0);
  });

  it("ExtractionError is a typed error, not a 500-class crash", () => {
    const e = new ExtractionError("invalid_image", "nope");
    expect(e.code).toBe("invalid_image");
    expect(e).toBeInstanceOf(Error);
  });
});
