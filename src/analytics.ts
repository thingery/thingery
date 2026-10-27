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

import type { Request } from "express";
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

// ---------------------------------------------------------------------------
// THI-396 (sprint D9 sharing loop): visit-origin capture on public item pages.
//
// Canonical listing URLs are deliberately query-string-free (SEO + unfurl
// stability, PR #166), so utm_* params and the Referer header are the ONLY
// signals of where a visit came from — and they exist solely at request time.
// itemPage (src/web-pages.ts) therefore emits ONE structured `page_view` line
// per successful render, with the origin classified server-side here. The
// line is consumed by scripts/daily-metrics.sh (THI-394 dashboards) exactly
// like tool_result lines: same stdout JSON-line discipline, no new table, no
// new infrastructure.
//
// Privacy contract (documented in docs/metrics.md):
//   - Referer: HOST ONLY, lowercased. The full Referer URL (paths, query
//     strings) is never logged — third-party referrer URLs can carry user
//     paths and identifiers.
//   - utm_* values: logged only when they match a conservative clamped charset
//     (see UTM_VALUE); anything else is dropped, never logged raw.
//   - itemId: the PUBLIC listing UUID. Per-listing attribution is the point of
//     this line; item pages are public and the UUID identifies no person. This
//     is a documented exception to the tool_result rule (which never logs item
//     ids) — tool arguments remain unlogged there.
//   - owner: whether the viewer is the listing's own seller, so self-views can
//     be excluded from share metrics. No seller UUID is logged for views.
//   - bot: fixed-substring unfurler/crawler classification of User-Agent.
//     Card-unfurl fetches (facebookexternalhit, twitterbot, …) are themselves
//     evidence a link was shared, but must not count as human visits.

/** Visit origin classified from the Referer header: no/blocked referrer →
 *  `direct`; referrer on our own host (request host or PUBLIC_BASE_URL) →
 *  `internal`; any other referrer host → `external` (the sharing platform). */
export type VisitOrigin = "direct" | "internal" | "external";

export interface VisitOriginInfo {
  origin: VisitOrigin;
  /** External referrer host (lowercased); present only when origin === "external". */
  refHost: string | null;
  /** Sanitized utm_* params present on the request URL; null when none survive validation. */
  utm: Partial<Record<"source" | "medium" | "campaign" | "content" | "term", string>> | null;
  /** Heuristic unfurler/crawler classification of the User-Agent. */
  bot: boolean;
}

const UTM_KEYS = ["source", "medium", "campaign", "content", "term"] as const;
/** Conservative, log-safe utm charset: alnum first, then a small punctuation
 *  set, ≤ 64 chars. Campaign names outside it are dropped, not sanitized. */
const UTM_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,63}$/;
/** Fixed lowercase substrings that identify unfurlers/crawlers. Deliberately
 *  short and NOT including in-app browser markers (e.g. "WhatsApp") — those
 *  carry the app name in real human UAs. */
const BOT_UA_SUBSTRINGS: readonly string[] = [
  "bot", "crawl", "spider", "slurp", "headless", "lighthouse",
  "facebookexternalhit", "linkedinbot", "preview", "fetcher", "pingdom", "uptime",
];

/** Classify where a public item-page visit came from, at request time.
 *  Pure function over headers/query — safe to unit-test without a server. */
export function classifyVisitOrigin(req: Request): VisitOriginInfo {
  // Own host = request Host header (sans port) plus PUBLIC_BASE_URL's host
  // when set, so self-hosted deployments classify their own domain internal.
  const ownHosts = new Set<string>();
  // Defensive access: a malformed/absent headers or query object must never
  // break a page render — analytics is strictly best-effort.
  const hostHeader = (req.headers?.host ?? "").split(":")[0]?.toLowerCase();
  if (hostHeader) ownHosts.add(hostHeader);
  try {
    const publicHost = new URL(process.env.PUBLIC_BASE_URL ?? "").hostname.toLowerCase();
    if (publicHost) ownHosts.add(publicHost);
  } catch {
    // PUBLIC_BASE_URL unset/invalid — the Host header is enough.
  }

  let origin: VisitOrigin = "direct";
  let refHost: string | null = null;
  const referer = req.headers?.referer;
  if (typeof referer === "string" && referer) {
    try {
      const host = new URL(referer).hostname.toLowerCase();
      if (host) {
        origin = ownHosts.has(host) ? "internal" : "external";
        refHost = origin === "external" ? host : null;
      }
    } catch {
      // Unparseable Referer — treat as absent rather than guessing.
    }
  }

  const utm: NonNullable<VisitOriginInfo["utm"]> = {};
  let haveUtm = false;
  for (const key of UTM_KEYS) {
    const raw = req.query?.[`utm_${key}`];
    if (typeof raw === "string" && UTM_VALUE.test(raw)) {
      utm[key] = raw;
      haveUtm = true;
    }
  }

  const ua = typeof req.headers?.["user-agent"] === "string" ? (req.headers["user-agent"] as string).toLowerCase() : "";
  const bot = BOT_UA_SUBSTRINGS.some((s) => ua.includes(s));

  return { origin, refHost, utm: haveUtm ? utm : null, bot };
}

/** Emit one `page_view` line for a successful public item-page render.
 *  Self-contained: an analytics failure must never break a page render. */
export function logPageView(view: { itemId: string; owner: boolean } & VisitOriginInfo): void {
  try {
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      type: "page_view",
      page: "item",
      itemId: view.itemId,
      owner: view.owner === true,
      origin: view.origin,
      bot: view.bot === true,
    };
    if (view.refHost) line.refHost = view.refHost;
    if (view.utm) line.utm = view.utm;
    console.log(JSON.stringify(line));
  } catch {
    // Swallow: analytics lines are best-effort by design.
  }
}
