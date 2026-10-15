// Chat usage hard limits (spec THI-180): env-configurable per-user request
// limits and an aggregate daily token budget. Config is loaded once at boot
// with the envValue/envInt semantics from src/config.ts — malformed or absent
// values fall back to today's hardcoded behavior, so an upgrade with no env
// changes reproduces the status quo (plus the protective 2M/day default).
//
// The budget is in-memory single-instance state by design — the same accepted
// posture as RateLimiter (src/rate-limit.ts): a restart (including a deploy)
// resets the day's accounting, and multi-instance deployments would carry
// per-instance budgets (spec §3.2 limitations; revisit when federating).

import { envInt, envValue } from "./config.js";

export interface ChatLimitsConfig {
  /** CHAT_TURNS_HOURLY_AUTHED — logged-in chats per seller per hour (60). */
  turnsHourlyAuthed: number;
  /** CHAT_TURNS_HOURLY_ANON — anonymous chats per IP per hour (10). */
  turnsHourlyAnon: number;
  /** CHAT_MAX_TOKENS_PER_CALL — max_tokens sent on each LLM call (1200). */
  maxTokensPerCall: number;
  /** CHAT_ROUNDS_PER_TURN — max LLM calls per chat turn (6). */
  roundsPerTurn: number;
  /** CHAT_DAILY_TOKEN_BUDGET — aggregate input+output tokens per UTC day
   *  across all users (2,000,000); 0 is the explicit "off" opt-out. */
  dailyTokenBudget: number;
}

/**
 * Non-negative-integer env parser. Unlike `envInt` (positive-only), 0 is a
 * legal explicit value here: `CHAT_DAILY_TOKEN_BUDGET=0` must turn the
 * budget off, not silently re-enable the default cap. Malformed, fractional
 * or negative values fall back to the default (fail-secure: a typo degrades
 * to the protective 2M cap, never to "off").
 */
function envNonNegativeInt(name: string, fallback: number): number {
  const raw = envValue(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function chatLimitsConfig(): ChatLimitsConfig {
  return {
    turnsHourlyAuthed: envInt("CHAT_TURNS_HOURLY_AUTHED", 60),
    turnsHourlyAnon: envInt("CHAT_TURNS_HOURLY_ANON", 10),
    maxTokensPerCall: envInt("CHAT_MAX_TOKENS_PER_CALL", 1200),
    roundsPerTurn: envInt("CHAT_ROUNDS_PER_TURN", 6),
    dailyTokenBudget: envNonNegativeInt("CHAT_DAILY_TOKEN_BUDGET", 2_000_000),
  };
}

/** Read once at boot (spec §3.1); no request-derived value ever reaches it. */
export const chatLimits = chatLimitsConfig();

// --- provider usage parsing (spec §3.2/§3.3; Security review THI-182 N1a) ---

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Finite non-negative number — the only shape that may be credited to the
 *  budget. NaN, negatives, non-numbers and ±Infinity are all malformed. */
function tokenCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Parses the provider `usage` object from an OpenAI-compatible
 * chat-completions response. THI-182 N1(a): missing, malformed, non-numeric,
 * NaN or negative usage is treated as MISSING (the caller charges the
 * deterministic fallback) — garbage can never be credited to the budget.
 * `{prompt_tokens, completion_tokens}` is preferred; a bare `total_tokens`
 * counts whole (spec §3.2's fallback).
 */
export function parseLlmUsage(raw: unknown): LlmUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { prompt_tokens, completion_tokens, total_tokens } = raw as Record<string, unknown>;
  if (tokenCount(prompt_tokens) && tokenCount(completion_tokens)) {
    return { promptTokens: prompt_tokens, completionTokens: completion_tokens };
  }
  if (tokenCount(total_tokens)) return { promptTokens: total_tokens, completionTokens: 0 };
  return null;
}

/**
 * THI-182 N1(c): when a provider reports no usable usage, the deterministic
 * charge is the request's own serialized size (chars/4 ≈ tokens) plus the
 * per-call output cap. A call's real cost is input-dominated, so the cap
 * alone would under-count by ~an order of magnitude on non-usage-reporting
 * providers (LLM_API_URL accepts any OpenAI-compatible endpoint).
 */
export function fallbackUsageEstimate(messages: unknown[], cfg: ChatLimitsConfig = chatLimits): LlmUsage {
  const chars = JSON.stringify(messages).length;
  return { promptTokens: Math.ceil(chars / 4), completionTokens: cfg.maxTokensPerCall };
}

// --- daily token budget (spec §3.2) -----------------------------------------

/** UTC day key — budget days roll over at UTC midnight. */
function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Aggregate daily token budget, explicit state machine (spec §3.2):
 *
 *   open      used < budget for today's UTC day
 *   exhausted used ≥ budget (checkpoints reject; N concurrent in-flight
 *             requests may each complete one more round — bounded overshoot)
 *   rollover  exhausted → open lazily on the first access after UTC midnight
 *
 * Both checkpoints are cheap map-free reads: `isExhausted()` pre-flight in
 * POST /api/chat and between rounds inside chatTurn's loop.
 */
export class DailyTokenBudget {
  private usedTokens = 0;
  private dayKey: string;

  /** `budget === 0` means unlimited (documented operator opt-out). */
  constructor(readonly budget: number, now: Date = new Date()) {
    this.dayKey = utcDayKey(now);
  }

  /** Lazy UTC-day rollover — no timer, no sweep, no DB (spec §3.2). */
  private rollover(now: Date): void {
    const key = utcDayKey(now);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.usedTokens = 0;
    }
  }

  /** Pre-flight / between-rounds checkpoint. Always false when unlimited. */
  isExhausted(now: Date = new Date()): boolean {
    if (this.budget === 0) return false;
    this.rollover(now);
    return this.usedTokens >= this.budget;
  }

  /** Tokens consumed today (post-rollover) — the `daily_total` of the
   *  chat_usage log line. */
  used(now: Date = new Date()): number {
    this.rollover(now);
    return this.usedTokens;
  }

  /**
   * Charges one completed LLM call: provider usage when it parsed, else the
   * deterministic `fallbackTokens` (spec §3.2) — a provider that omits or
   * mangles `usage` cannot silently unplug the budget.
   */
  record(usage: LlmUsage | null, fallbackTokens: number, now: Date = new Date()): void {
    this.rollover(now);
    this.usedTokens += usage ? usage.promptTokens + usage.completionTokens : fallbackTokens;
  }

  /** Test isolation (RateLimiter.reset() convention). */
  reset(now: Date = new Date()): void {
    this.dayKey = utcDayKey(now);
    this.usedTokens = 0;
  }
}

/** The process-wide budget instance shared by routes.ts and chat.ts. */
export const dailyTokenBudget = new DailyTokenBudget(chatLimits.dailyTokenBudget);
