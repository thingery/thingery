// Spec THI-180 §7 (PR-A): chat-limits config defaults + env fallbacks, the
// non-negative budget parser (0 = unlimited), and the DailyTokenBudget state
// machine — checkpoints, lazy UTC-day rollover, fallback charging, and the
// THI-182 N2 overshoot bound (per in-flight request, not one round total).

import { describe, expect, it } from "vitest";
import {
  DailyTokenBudget,
  chatLimitsConfig,
  fallbackUsageEstimate,
  parseLlmUsage,
  type ChatLimitsConfig,
} from "../src/chat-limits.js";

const DEFAULTS: ChatLimitsConfig = {
  turnsHourlyAuthed: 60,
  turnsHourlyAnon: 10,
  maxTokensPerCall: 1200,
  roundsPerTurn: 6,
  dailyTokenBudget: 2_000_000,
};

const VARS = [
  "CHAT_TURNS_HOURLY_AUTHED",
  "CHAT_TURNS_HOURLY_ANON",
  "CHAT_MAX_TOKENS_PER_CALL",
  "CHAT_ROUNDS_PER_TURN",
  "CHAT_DAILY_TOKEN_BUDGET",
] as const;

/** Runs fn with a clean CHAT_* env (plus the given overrides), restoring the
 *  process env afterwards — config must be testable without re-importing. */
function withEnv(overrides: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const name of VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
  try {
    fn();
  } finally {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

describe("chatLimitsConfig (spec §3.1)", () => {
  it("defaults reproduce today's hardcoded values", () => {
    withEnv({}, () => expect(chatLimitsConfig()).toEqual(DEFAULTS));
  });

  it("reads every limit from env", () => {
    withEnv(
      {
        CHAT_TURNS_HOURLY_AUTHED: "30",
        CHAT_TURNS_HOURLY_ANON: "5",
        CHAT_MAX_TOKENS_PER_CALL: "800",
        CHAT_ROUNDS_PER_TURN: "3",
        CHAT_DAILY_TOKEN_BUDGET: "500000",
      },
      () =>
        expect(chatLimitsConfig()).toEqual({
          turnsHourlyAuthed: 30,
          turnsHourlyAnon: 5,
          maxTokensPerCall: 800,
          roundsPerTurn: 3,
          dailyTokenBudget: 500000,
        }),
    );
  });

  it("malformed values fall back to defaults (envValue/envInt semantics)", () => {
    withEnv(
      {
        CHAT_TURNS_HOURLY_AUTHED: "abc",
        CHAT_TURNS_HOURLY_ANON: "-5",
        CHAT_MAX_TOKENS_PER_CALL: "1.5",
        CHAT_ROUNDS_PER_TURN: "0", // positive-int parser: 0 is malformed here
        CHAT_DAILY_TOKEN_BUDGET: "x",
      },
      () => expect(chatLimitsConfig()).toEqual(DEFAULTS),
    );
  });

  it("empty/whitespace values count as unset (fail-closed rule #1)", () => {
    withEnv(
      { CHAT_TURNS_HOURLY_AUTHED: "", CHAT_TURNS_HOURLY_ANON: "   " },
      () => expect(chatLimitsConfig()).toEqual(DEFAULTS),
    );
  });

  it("CHAT_DAILY_TOKEN_BUDGET uses a non-negative parser: 0 is legal, negative is not", () => {
    withEnv({ CHAT_DAILY_TOKEN_BUDGET: "0" }, () =>
      expect(chatLimitsConfig().dailyTokenBudget).toBe(0),
    );
    // Unlike the positive-int envInt, a negative must NOT silently re-enable
    // the cap either — malformed degrades to the protective default.
    withEnv({ CHAT_DAILY_TOKEN_BUDGET: "-1" }, () =>
      expect(chatLimitsConfig().dailyTokenBudget).toBe(2_000_000),
    );
    withEnv({ CHAT_DAILY_TOKEN_BUDGET: "2000000" }, () =>
      expect(chatLimitsConfig().dailyTokenBudget).toBe(2_000_000),
    );
  });
});

describe("parseLlmUsage (spec §3.2; THI-182 N1a)", () => {
  it("parses prompt + completion tokens", () => {
    expect(parseLlmUsage({ prompt_tokens: 100, completion_tokens: 40 })).toEqual({
      promptTokens: 100,
      completionTokens: 40,
    });
  });

  it("falls back to total_tokens when the split is absent", () => {
    expect(parseLlmUsage({ total_tokens: 250 })).toEqual({ promptTokens: 250, completionTokens: 0 });
    expect(parseLlmUsage({ prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 })).toEqual({
      promptTokens: 100,
      completionTokens: 40,
    });
  });

  it("treats missing, malformed, NaN, negative and partial usage as missing", () => {
    expect(parseLlmUsage(undefined)).toBeNull();
    expect(parseLlmUsage(null)).toBeNull();
    expect(parseLlmUsage("500")).toBeNull();
    expect(parseLlmUsage({})).toBeNull();
    expect(parseLlmUsage({ prompt_tokens: -100, completion_tokens: 40 })).toBeNull();
    expect(parseLlmUsage({ prompt_tokens: NaN, completion_tokens: 40 })).toBeNull();
    expect(parseLlmUsage({ prompt_tokens: Infinity, completion_tokens: 40 })).toBeNull();
    expect(parseLlmUsage({ prompt_tokens: "100", completion_tokens: 40 })).toBeNull();
    // Partial (one of the two split fields, no total): never credited.
    expect(parseLlmUsage({ prompt_tokens: 100 })).toBeNull();
    expect(parseLlmUsage({ completion_tokens: 40 })).toBeNull();
    expect(parseLlmUsage({ total_tokens: -1 })).toBeNull();
  });
});

describe("fallbackUsageEstimate (THI-182 N1c)", () => {
  it("charges serialized chars/4 for input plus the per-call output cap", () => {
    const messages = [{ role: "user", content: "x".repeat(400) }];
    const est = fallbackUsageEstimate(messages, { ...DEFAULTS, maxTokensPerCall: 1200 });
    expect(est.completionTokens).toBe(1200);
    // ceil(JSON length / 4) — the wrapper JSON adds a few chars over 400.
    expect(est.promptTokens).toBe(Math.ceil(JSON.stringify(messages).length / 4));
    expect(est.promptTokens).toBeGreaterThanOrEqual(100);
  });

  it("honors the configured output cap", () => {
    const est = fallbackUsageEstimate([{ role: "user", content: "hi" }], {
      ...DEFAULTS,
      maxTokensPerCall: 800,
    });
    expect(est.completionTokens).toBe(800);
  });
});

describe("DailyTokenBudget (spec §3.2)", () => {
  // Fixed UTC dates so rollover is deterministic regardless of test TZ.
  const day1 = new Date("2026-03-10T12:00:00Z");
  const day1Late = new Date("2026-03-10T23:59:59Z");
  const day2 = new Date("2026-03-11T00:00:01Z");

  it("is open below the budget, exhausted at and above it", () => {
    const b = new DailyTokenBudget(1000, day1);
    expect(b.isExhausted(day1)).toBe(false);
    b.record({ promptTokens: 600, completionTokens: 100 }, 0, day1);
    expect(b.isExhausted(day1)).toBe(false);
    expect(b.used(day1)).toBe(700);
    b.record({ promptTokens: 300, completionTokens: 0 }, 0, day1);
    expect(b.isExhausted(day1)).toBe(true);
    expect(b.used(day1)).toBe(1000);
  });

  it("budget 0 means unlimited: never exhausted regardless of charges", () => {
    const b = new DailyTokenBudget(0, day1);
    expect(b.isExhausted(day1)).toBe(false);
    b.record({ promptTokens: 10_000_000, completionTokens: 5_000_000 }, 0, day1);
    expect(b.isExhausted(day1)).toBe(false);
    expect(b.used(day1)).toBe(15_000_000); // accounting continues for the log line
  });

  it("charges the deterministic fallback when usage is missing", () => {
    const b = new DailyTokenBudget(2400, day1);
    b.record(null, 1200, day1); // spec §3.2: cap-fallback charge
    b.record({ promptTokens: 900, completionTokens: 300 }, 0, day1);
    expect(b.used(day1)).toBe(2400);
    expect(b.isExhausted(day1)).toBe(true);
  });

  it("lazily rolls over at UTC midnight and resets accounting", () => {
    const b = new DailyTokenBudget(1000, day1);
    b.record({ promptTokens: 1000, completionTokens: 0 }, 0, day1);
    expect(b.isExhausted(day1Late)).toBe(true);
    expect(b.isExhausted(day2)).toBe(false); // new UTC day → open again
    expect(b.used(day2)).toBe(0);
    b.record({ promptTokens: 400, completionTokens: 0 }, 0, day2);
    expect(b.used(day2)).toBe(400);
  });

  it("same-day access never rolls over", () => {
    const b = new DailyTokenBudget(100, day1);
    b.record({ promptTokens: 100, completionTokens: 0 }, 0, day1);
    b.isExhausted(day1Late);
    expect(b.used(day1)).toBe(100);
  });

  it("THI-182 N2: overshoot is per in-flight request — two interleaved pre-flights can both pass", () => {
    // Two concurrent turns that both passed the pre-flight checkpoint each
    // complete one more round before observing exhaustion: worst-case
    // overshoot ≈ N in-flight requests × one round, not one round total.
    const b = new DailyTokenBudget(1000, day1);
    expect(b.isExhausted(day1)).toBe(false); // turn A pre-flight: open
    expect(b.isExhausted(day1)).toBe(false); // turn B pre-flight: still open
    b.record({ promptTokens: 600, completionTokens: 0 }, 0, day1); // turn A round
    b.record({ promptTokens: 600, completionTokens: 0 }, 0, day1); // turn B round
    expect(b.isExhausted(day1)).toBe(true); // both see it at the next checkpoint
    expect(b.used(day1)).toBe(1200); // bounded overshoot over the 1000 budget
  });

  it("reset() restores construction state (test isolation)", () => {
    const b = new DailyTokenBudget(100, day1);
    b.record({ promptTokens: 100, completionTokens: 0 }, 0, day1);
    expect(b.isExhausted(day1)).toBe(true);
    b.reset(day1);
    expect(b.isExhausted(day1)).toBe(false);
    expect(b.used(day1)).toBe(0);
  });
});
