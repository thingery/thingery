// Chat usage telemetry (THI-185, from the THI-181 cheaper-model examination
// findings §7 F1 / §8.1). One JSON line per chat turn on stdout — the same
// ship path as src/security-events.ts (Docker/Caddy capture; no log
// infrastructure yet, YAGNI per docs/security.md §6 H4.2).
//
// This is the SINGLE token meter for the chat pipeline. THI-180's per-user /
// daily budget work extends this same record and accumulation point in
// chat.ts (budget check before each callLlm, cumulative daily total as an
// extra field here) — it must not add a second meter.
//
// HARD RULE, inherited from docs/security.md: never log secrets, cookies,
// message content or tool arguments. The line is built field-by-field from
// the fixed whitelist below (never by stringifying turn state), so nothing
// beyond counts, slugs, the model name and sellerId can reach the log.

/** Token usage as reported by an OpenAI-compatible /chat/completions
 *  response (`usage` field). Every field optional: providers differ and the
 *  field can be absent entirely — absent means null in the log, never 0. */
export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Per-call token pair as it appears in the `calls` array of the log line. */
export interface LlmCallUsage {
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

/** Everything the per-turn log line carries (THI-185 scope). */
export interface ChatTurnUsage {
  /** Resolved LLM_MODEL for the calls in this turn (single-model today). */
  model: string;
  /** Cheap/strong tier once the model split lands (THI-181 F4 / THI-180);
   *  null until then — stable field for downstream queries from day one. */
  tier: string | null;
  /** callLlm invocations attempted (a failed API call still counts). */
  llmCalls: number;
  /** Usage per completed call, in order; entries may carry nulls. */
  calls: LlmCallUsage[];
  toolRounds: number;
  toolCalls: number;
  /** Sanitized tool names in call order (duplicates kept). */
  toolNames: string[];
  /** Tool calls whose arguments failed to parse or canonicalize. */
  toolArgErrors: number;
  durationMs: number;
  outcome: "ok" | "max_rounds" | "budget_exhausted" | "error";
  sellerId: string | null;
  /** THI-180: process-wide daily budget total after this turn charged it
   *  (UTC-day; always a number — a deployment without a budget cap still
   *  gets the running total). Appended per the single-meter contract. */
  dailyTotal: number;
}

/** Sums the present values; null when the provider never reported usage
 *  (mixed reports sum what was reported — partial data beats none). */
function sumOrNone(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

/** Builds the fixed-whitelist line object (pure, for tests). */
export function buildChatTurnUsageLine(u: ChatTurnUsage): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    type: "chat_turn_usage",
    outcome: u.outcome,
    model: u.model,
    tier: u.tier,
    llm_calls: u.llmCalls,
    prompt_tokens: sumOrNone(u.calls.map((c) => c.prompt_tokens)),
    completion_tokens: sumOrNone(u.calls.map((c) => c.completion_tokens)),
    calls: u.calls.map((c) => ({ prompt_tokens: c.prompt_tokens, completion_tokens: c.completion_tokens })),
    tool_rounds: u.toolRounds,
    tool_calls: u.toolCalls,
    tool_names: u.toolNames,
    tool_arg_errors: u.toolArgErrors,
    duration_ms: u.durationMs,
    daily_total: u.dailyTotal,
    sellerId: u.sellerId,
  };
}

/** Emits one chat-turn usage line to stdout (one JSON object per line). */
export function logChatTurnUsage(u: ChatTurnUsage): void {
  console.log(JSON.stringify(buildChatTurnUsageLine(u)));
}

/** Same slug rule as wrapToolResult in chat.ts: tool names reach the log
 *  only as [A-Za-z0-9_-] slugs. */
export function toolNameSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}
