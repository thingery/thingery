// THI-394: unit tests for the outcome-aware `tool_result` analytics lines
// (src/analytics.ts). Covers logToolResult's bounded field extraction, the
// withToolResultLogging proxy (success / isError / throw, return-value
// passthrough), the privacy contract (no args or payload content in lines)
// and the drift check: every tool registerTools registers must flow through
// the wrapper (same capture pattern as tests/tool-call-events.test.ts).
// No DB needed — registration never executes handlers.

import { describe, expect, it, vi, afterEach } from "vitest";
import { logToolResult, withToolResultLogging } from "../src/analytics.js";
import { TOOL_NAMES } from "../src/mcp-gate.js";
import { registerTools } from "../src/tools.js";
import type { ToolHandlerResult } from "../src/analytics.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const text = (data: unknown): ToolHandlerResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const err = (): ToolHandlerResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: "boom" }) }],
  isError: true,
});

describe("logToolResult (bounded line shape)", () => {
  it("search_items: logs results count, never the payload or arguments", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolResult(
      "search_items",
      null,
      text({ count: 3, results: [{ title: "Secret Sneaker" }], note: "hidden note" }),
      12,
    );
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line).toEqual({
      ts: expect.any(String),
      type: "tool_result",
      tool: "search_items",
      sellerId: null,
      ok: true,
      ms: 12,
      results: 3,
    });
  });

  it("create_listing: created/visible booleans; add_item_image: visible only", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolResult("create_listing", "11111111-1111-1111-1111-111111111111", text({ created: true, visible: false }), 40);
    logToolResult("add_item_image", null, text({ added: true, visible: true }), 80);
    const [create, image] = log.mock.calls.map((c) => JSON.parse(c[0]));
    expect(create.results).toBeUndefined();
    expect(create.created).toBe(true);
    expect(create.visible).toBe(false);
    expect(image).toEqual({
      ts: expect.any(String),
      type: "tool_result",
      tool: "add_item_image",
      sellerId: null,
      ok: true,
      ms: 80,
      visible: true,
    });
  });

  it("isError results log ok:false with no payload-derived fields", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolResult("search_items", null, err(), 5);
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line.ok).toBe(false);
    expect(line.results).toBeUndefined();
  });

  it("a thrown handler logs ok:false (result undefined)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolResult("get_item", null, undefined, 7);
    expect(JSON.parse(log.mock.calls[0][0]).ok).toBe(false);
  });

  it("drops malformed/absent payload fields instead of guessing", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolResult("search_items", null, text({ count: "three" }), 1); // wrong type
    logToolResult("search_items", null, text({}), 1); // missing
    logToolResult("search_items", null, { content: [{ type: "text", text: "not json" }] }, 1); // unparseable
    logToolResult("get_item", null, text({ item: { id: "x" } }), 1); // no metric fields for this tool
    const lines = log.mock.calls.map((c) => JSON.parse(c[0]));
    for (const line of lines) {
      expect(line.results).toBeUndefined();
      expect(line.created).toBeUndefined();
      expect(line.visible).toBeUndefined();
      expect(line.ok).toBe(true);
    }
  });

  it("clamps and truncates counts (no NaN/Infinity/huge numbers in lines)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolResult("search_items", null, text({ count: Number.NaN }), 1); // dropped entirely
    logToolResult("search_items", null, text({ count: 999_999 }), 1); // clamped to cap
    logToolResult("search_items", null, text({ count: 2.9 }), 1); // truncated
    const counts = log.mock.calls.map((c) => JSON.parse(c[0]).results);
    expect(counts).toEqual([undefined, 1000, 2]);
  });
});

describe("withToolResultLogging proxy", () => {
  function harness(ctx: { seller: { id: string } | null }) {
    const registered: Array<{ name: string; config: unknown; handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> }> = [];
    const target = {
      registerTool(name: string, config: unknown, handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>) {
        registered.push({ name, config, handler });
      },
    };
    const proxied = withToolResultLogging(target, ctx as never);
    return { proxied, registered };
  }

  it("wraps the handler and passes the tool result through unchanged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { proxied, registered } = harness({ seller: { id: "22222222-2222-2222-2222-222222222222" } });
    const inner = vi.fn(async () => text({ count: 1 }));
    proxied.registerTool("search_items", { title: "Search" }, inner);

    expect(registered).toHaveLength(1);
    const result = await registered[0].handler({ q: "sneakers" });
    expect(inner).toHaveBeenCalledWith({ q: "sneakers" });
    expect(JSON.parse(result.content?.[0]?.text as string).count).toBe(1);

    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line.tool).toBe("search_items");
    expect(line.sellerId).toBe("22222222-2222-2222-2222-222222222222");
    expect(line.ok).toBe(true);
    expect(line.results).toBe(1);
  });

  it("logs ok:false when the handler throws and re-throws unchanged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { proxied, registered } = harness({ seller: null });
    proxied.registerTool("create_listing", {}, async () => {
      throw new Error("db down");
    });
    await expect(registered[0].handler({})).rejects.toThrow("db down");
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line.ok).toBe(false);
    expect(line.sellerId).toBeNull();
  });

  it("drift check: every registered tool flows through the wrapper", () => {
    // Registration capture over the REAL registerTools — proves no tool can
    // be added to tools.ts without gaining its tool_result line.
    const names: string[] = [];
    const target = {
      registerTool(name: string) {
        names.push(name);
      },
    };
    registerTools(withToolResultLogging(target, { seller: null } as never), { seller: null } as never);
    expect(new Set(names)).toEqual(TOOL_NAMES);
  });
});
