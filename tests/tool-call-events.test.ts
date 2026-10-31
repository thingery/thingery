// THI-371 PR C: funnel instrumentation unit tests. Covers the pure helpers
// exported from mcp-gate.ts — `credentialKind` (header-prefix dispatch
// mirror), `logToolCallEvents` (one bounded JSON line per tools/call message)
// and the TOOL_NAMES drift check (same registration-capture pattern as
// tests/tool-annotations.test.ts, so a newly registered tool cannot silently
// lose its funnel line). No DB needed.

import { describe, expect, it, vi, afterEach } from "vitest";
import { credentialKind, logToolCallEvents, TOOL_NAMES } from "../src/mcp-gate.js";
import { registerTools } from "../src/tools.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credentialKind (Authorization prefix mirror)", () => {
  it("maps thg_/thgo_/absent prefixes to api_key/oauth/none", () => {
    expect(credentialKind("Bearer thg_abc")).toBe("api_key");
    expect(credentialKind("Bearer thgo_xyz")).toBe("oauth");
    expect(credentialKind(undefined)).toBe("none");
    expect(credentialKind("")).toBe("none");
    expect(credentialKind("Basic zzz")).toBe("none");
    expect(credentialKind("bearer thg_lowercase")).toBe("none"); // case-sensitive, like auth.ts
  });
});

describe("logToolCallEvents", () => {
  it("emits one line per tools/call message with tool, credential, sellerId", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolCallEvents(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_items", arguments: { q: "e-bike" } } },
      "oauth",
      "11111111-1111-1111-1111-111111111111",
    );
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0][0]);
    expect(line.type).toBe("tool_call");
    expect(line.tool).toBe("search_items");
    expect(line.credential).toBe("oauth");
    expect(line.sellerId).toBe("11111111-1111-1111-1111-111111111111");
    expect(typeof line.ts).toBe("string");
  });

  it("counts every message in a batch and ignores non-tools/call methods", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolCallEvents(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_item" } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "describe_category" } },
      ],
      "none",
      null,
    );
    expect(log).toHaveBeenCalledTimes(2);
    const tools = log.mock.calls.map((c) => JSON.parse(c[0]).tool);
    expect(tools).toEqual(["get_item", "describe_category"]);
    for (const call of log.mock.calls) {
      expect(JSON.parse(call[0]).sellerId).toBeNull();
      expect(JSON.parse(call[0]).credential).toBe("none");
    }
  });

  it("collapses unknown client-supplied tool names to _unknown — never logs raw strings", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolCallEvents(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "totally-made-up-tool OR 1=1; DROP TABLE" } },
      "api_key",
      null,
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0]).tool).toBe("_unknown");
    // Non-string / missing name → still a counted dispatch attempt, bounded slug.
    logToolCallEvents({ method: "tools/call", params: {} }, "none", null);
    expect(JSON.parse(log.mock.calls[1][0]).tool).toBe("_unknown");
  });

  it("logs nothing for bodies without tools/call (or garbage)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolCallEvents({ method: "ping" }, "none", null);
    logToolCallEvents("not an object", "none", null);
    logToolCallEvents(null, "none", null);
    logToolCallEvents([1, 2, 3], "none", null);
    expect(log).not.toHaveBeenCalled();
  });

  it("never includes arguments or params in the line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logToolCallEvents(
      { method: "tools/call", params: { name: "create_listing", arguments: { title: "SECRET" } } },
      "api_key",
      "22222222-2222-2222-2222-222222222222",
    );
    expect(log.mock.calls[0][0]).not.toContain("SECRET");
    expect(Object.keys(JSON.parse(log.mock.calls[0][0])).sort()).toEqual(["credential", "sellerId", "tool", "ts", "type"]);
  });
});

describe("TOOL_NAMES drift check (registration capture)", () => {
  it("exactly matches the tools registered by registerTools", () => {
    const registered = new Set<string>();
    registerTools(
      {
        registerTool(name: string) {
          registered.add(name);
        },
      },
      { seller: null },
    );
    expect(registered.size).toBe(21); // +4 intent tools (THI-360 PR 2), +my_matches (PR 4)
    expect([...TOOL_NAMES].sort()).toEqual([...registered].sort());
  });
});
