// THI-394 (sprint week-1 instrumentation): outcome-aware `tool_result` lines.
//
// The dispatch-time `tool_call` line (THI-371, src/mcp-gate.ts) proves a call
// reached the transport; it cannot say what happened next. The sprint's three
// numbers need outcomes: search success (query → results), the listing-creation
// funnel (attempt → created → published) and activation (first *useful*, i.e.
// successful, action). This module emits ONE structured `tool_result` JSON line
// per executed MCP tool call with the same stdout JSON-line discipline as
// src/security-events.ts and src/mcp-gate.ts — no new infrastructure, no new
// table, no protected file touched. It wraps tool registration in
// src/server.ts; src/tools.ts is not modified.
//
// Privacy contract (documented for users in docs/metrics.md):
//   - NEVER logged: tool arguments, query text, item ids/titles/attributes,
//     user content, tokens, IPs, error messages. The only per-request
//     identifier is the resolved seller UUID (or null for anonymous callers) —
//     the same field security events and the THI-371 dispatch line carry.
//   - Tool names are logged only when they are registered names (the dispatch
//     layer already collapses unknown client-supplied names to "_unknown";
//     this wrapper only ever sees registered names).
//   - Payload-derived values are read BY FIXED NAME from the tool handler's
//     own JSON output (`count` for search_items; `created`/`visible` for
//     create_listing; `visible` for add_item_image), coerced and clamped
//     before logging. Every other payload field is ignored.
//
// Storage & retention: stdout → Docker json-file driver with rotation
// (max-size 10m, max-file 3 per service — docker-compose.prod.yml, THI-312).
// The durable record is the daily snapshot written by scripts/daily-metrics.sh
// (counts only, one small JSON file per day); raw lines rotate away with the
// container logs and are not backed up offsite.

import type { ToolContext } from "./tools.js";

/** Minimal shape of a tool-handler result (the `ok`/`err` helpers in tools.ts). */
export interface ToolHandlerResult {
  content?: Array<{ type?: string; text?: unknown }>;
  isError?: boolean;
}

/** The wrapped handler signature every registerTools callback already has. */
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolHandlerResult>;

/** Server subset registerTools needs. tools.ts already types this boundary
 *  as `{ registerTool: Function }` (the SDK's registerTool is heavily
 *  generic); we mirror that same loose type rather than fighting variance —
 *  the proxy only ever forwards (name, config, cb) unchanged. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export interface RegisterToolTarget {
  registerTool: Function;
}

/** The ONLY payload fields ever logged, by fixed tool name. Adding a field
 *  here is a data-collection change: update docs/metrics.md in the same PR. */
const METRIC_FIELDS: Readonly<Record<string, ReadonlyArray<"count" | "created" | "visible">>> = {
  search_items: ["count"], // → `results`: 0..N active listings matched
  create_listing: ["created", "visible"], // attempt outcome + publish state
  add_item_image: ["visible"], // first photo publishes a pending listing
};

/** Clamp/coerce a payload number for logging (defensive: never NaN/Infinity). */
function metricNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1000, Math.trunc(value)))
    : undefined;
}

/** Parse the first text content block as the handler's JSON payload.
 *  Returns null on any shape mismatch — callers log only bounded fields. */
function payloadOf(result: ToolHandlerResult): Record<string, unknown> | null {
  try {
    const text = result.content?.[0]?.text;
    if (typeof text !== "string") return null;
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Emit one `tool_result` line. `result` is undefined when the handler threw.
 *  Self-contained: an analytics failure must never break a tool call. */
export function logToolResult(
  tool: string,
  sellerId: string | null,
  result: ToolHandlerResult | undefined,
  ms: number,
): void {
  try {
    const ok = result !== undefined && result.isError !== true;
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      type: "tool_result",
      tool,
      sellerId,
      ok,
      ms: Math.max(0, Math.trunc(ms)),
    };
    const payload = ok ? payloadOf(result ?? {}) : null;
    const fields = METRIC_FIELDS[tool];
    if (payload && fields) {
      for (const field of fields) {
        if (field === "count") {
          const results = metricNumber(payload.count);
          if (results !== undefined) line.results = results;
        } else if (typeof payload[field] === "boolean") {
          line[field] = payload[field];
        }
      }
    }
    console.log(JSON.stringify(line));
  } catch {
    // Swallow: analytics lines are best-effort by design.
  }
}

/** Wrap a registerTool target so every tool handler logs one `tool_result`
 *  line after execution (success, structured error, or throw). The proxy is
 *  structural — registerTools never notices it — so tool signatures, schemas
 *  and responses are byte-identical to an unwrapped registration. */
export function withToolResultLogging(server: RegisterToolTarget, ctx: ToolContext): RegisterToolTarget {
  const register: (name: string, config: unknown, handler: ToolHandler) => void =
    (name, config, handler) => server.registerTool(name, config, handler);
  return {
    registerTool(name: string, config: unknown, handler: ToolHandler) {
      register(name, config, async (args: Record<string, unknown>) => {
        const startedAt = Date.now();
        let result: ToolHandlerResult | undefined;
        try {
          result = await handler(args);
          return result;
        } finally {
          // `result` stays undefined on throw → ok:false. finally (not catch):
          // the rejection propagates unchanged to the SDK's own error path.
          logToolResult(name, ctx.seller?.id ?? null, result, Date.now() - startedAt);
        }
      });
    },
  };
}
