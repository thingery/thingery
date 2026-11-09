// search_items `offset` over MCP: input bounds, omitted-offset compatibility
// and the page metadata. searchItems is stubbed, so no database is needed;
// the SQL and real paging are covered in tests/search-items-paging.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { searchItems } = vi.hoisted(() => ({ searchItems: vi.fn() }));
vi.mock("../src/items.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/items.js")>()),
  searchItems,
}));

import { SEARCH_MAX_OFFSET } from "../src/items.js";
import { registerTools } from "../src/tools.js";

interface Captured {
  config: { description?: string; inputSchema: z.ZodRawShape };
  handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
}

function searchTool(): Captured {
  const registered = new Map<string, Captured>();
  registerTools(
    {
      registerTool(name: string, config: Captured["config"], handler: Captured["handler"]) {
        registered.set(name, { config, handler });
      },
    },
    { seller: null },
  );
  return registered.get("search_items") as Captured;
}

const tool = searchTool();
const inputSchema = z.object(tool.config.inputSchema);

function rows(length: number): Array<Record<string, unknown>> {
  return Array.from({ length }, (_, n) => ({ id: `item-${n}`, images: [], status: "active" }));
}

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await tool.handler(args);
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("search_items offset input", () => {
  it.each([0, 1, SEARCH_MAX_OFFSET])("accepts %i", (offset) => {
    expect(inputSchema.safeParse({ offset }).success).toBe(true);
  });

  it("is optional, with no default injected", () => {
    const parsed = inputSchema.parse({});
    expect(parsed).not.toHaveProperty("offset");
  });

  it.each([
    ["one past the bound", SEARCH_MAX_OFFSET + 1],
    ["negative", -1],
    ["fractional", 1.5],
    ["a numeric string", "10"],
    ["null", null],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s", (_label, offset) => {
    expect(inputSchema.safeParse({ offset }).success).toBe(false);
  });

  it("is documented in the tool description, including that count is not a total", () => {
    expect(tool.config.description).toContain(`offset (0-${SEARCH_MAX_OFFSET})`);
    expect(tool.config.description).toContain("not a total");
  });
});

describe("search_items paging behaviour", () => {
  beforeEach(() => {
    searchItems.mockReset();
  });

  it.each([[undefined, 0], [40, 40]])("offset %s requests rows from %i with one lookahead row", async (offset, expected) => {
    searchItems.mockResolvedValue(rows(2));
    await call({ limit: 10, offset, currency: "EUR" });
    expect(searchItems).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: expected, lookahead: true }));
  });

  it.each([
    ["a lookahead row exists", 11, 10, 0, 10, true],
    ["the last page is exactly full", 10, 10, 10, 10, false],
    ["the next offset would be rejected", 51, 50, SEARCH_MAX_OFFSET, 50, false],
    ["the next offset lands on the bound", 51, 50, SEARCH_MAX_OFFSET - 50, 50, true],
  ])("when %s", async (_case, fetched, limit, offset, count, hasMore) => {
    searchItems.mockResolvedValue(rows(fetched));
    const body = await call({ limit, offset, currency: "EUR" });
    expect(body.count).toBe(count);
    expect(body.results).toHaveLength(count);
    expect(body.has_more).toBe(hasMore);
  });

  it("keeps the empty-search hint on the first page only", async () => {
    searchItems.mockResolvedValue([]);
    expect((await call({ limit: 10, currency: "EUR" })).note).toContain("No active listings match");
    expect(await call({ limit: 10, offset: 20, currency: "EUR" })).not.toHaveProperty("note");
  });
});
