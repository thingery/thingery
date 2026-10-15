// THI-133 F1 — type-level assertions for the SecurityEvent schema.
// `route` and `reason` are compile-time literal unions (SecurityEventRoute /
// SecurityEventReason in src/security-events.ts): a dynamic, request-derived
// string (e.g. req.path or an echoed Content-Type) must NOT typecheck, so the
// no-attacker-data-in-the-log guarantee lives in the type system instead of
// call-site discipline. This file runs under vitest typecheck mode
// (`typecheck` in vitest.config.ts → tsconfig.typecheck.json); widening the
// unions back to `string` turns each `@ts-expect-error` into an
// "Unused '@ts-expect-error' directive" failure, and passing a dynamic value
// at any new call site fails `npm run typecheck` on src/.

import { describe, expectTypeOf, it } from "vitest";
import {
  logSecurityEvent,
  type ChatgptOauthErrorReason,
  type SecurityEvent,
  type SecurityEventReason,
  type SecurityEventRoute,
} from "../src/security-events.js";

describe("SecurityEvent route/reason literal unions (THI-133)", () => {
  it("route accepts only the fixed literals", () => {
    expectTypeOf<SecurityEventRoute>().toEqualTypeOf<
      | "/api/signup"
      | "/api/login"
      | "/mcp"
      | "/api/items/:id/images"
      | "/api/chat"
      | "/api/me/llm-credential"
      | "/api/me/chatgpt/connect" // THI-193 PR-2: connect rate-limit log line
    >();
    const routes: SecurityEventRoute[] = [
      "/api/signup",
      "/api/login",
      "/mcp",
      "/api/items/:id/images",
      "/api/chat",
      "/api/me/llm-credential",
      "/api/me/chatgpt/connect",
    ];
    expectTypeOf(routes).toEqualTypeOf<SecurityEventRoute[]>();
  });

  it("reason accepts only the fixed slugs", () => {
    expectTypeOf<SecurityEventReason>().toEqualTypeOf<
      | "unsupported_media_type"
      | "empty"
      | "too_large"
      | "not_owned"
      | "bad_magic"
      | "media_type_mismatch"
      | "item_image_limit"
      | "quota_exceeded"
      | "decode_failed" // THI-156 re-encode pipeline (spec rev 2)
      | "pixel_limit"
      | "reencode_failed"
      | "output_too_large"
    >();
  });

  it("a dynamic (attacker-derivable) string is a compile error for route", () => {
    // Simulates req.path or any runtime-computed value flowing into the log.
    const dynamic: string = "/api/signup"; // value is irrelevant; type is string
    // @ts-expect-error rate_limit.route is a literal union — dynamic strings must not typecheck
    logSecurityEvent({ type: "rate_limit", route: dynamic });
  });

  it("a dynamic (attacker-derivable) string is a compile error for reason", () => {
    // Simulates an echoed media type or other request-derived slug.
    const dynamic: string = "too_large";
    // @ts-expect-error image_upload.reason is a literal union — dynamic strings must not typecheck
    logSecurityEvent({ type: "image_upload", outcome: "rejected", reason: dynamic });
  });

  it("a non-slug literal is still rejected", () => {
    // @ts-expect-error /api/logout is not in the route union — adding a route is a reviewed type change
    const event: SecurityEvent = { type: "rate_limit", route: "/api/logout" };
    expectTypeOf(event).toBeObject();
  });
});

describe("chatgpt_oauth_error reason union (THI-193 §3.3)", () => {
  it("accepts only the fixed terminal-refresh slugs", () => {
    expectTypeOf<ChatgptOauthErrorReason>().toEqualTypeOf<
      "invalid_grant" | "token_expired" | "refresh_token_invalidated" | "refresh_token_reused" | "invalid_client"
    >();
    const reasons: ChatgptOauthErrorReason[] = [
      "invalid_grant",
      "token_expired",
      "refresh_token_invalidated",
      "refresh_token_reused",
      "invalid_client",
    ];
    expectTypeOf(reasons).toEqualTypeOf<ChatgptOauthErrorReason[]>();
  });

  it("a dynamic (provider-echoed) string is a compile error for reason", () => {
    // Provider error text must never flow into the log — only fixed slugs.
    const dynamic: string = "invalid_grant"; // value is irrelevant; type is string
    // @ts-expect-error chatgpt_oauth_error.reason is a literal union — dynamic strings must not typecheck
    logSecurityEvent({ type: "chatgpt_oauth_error", reason: dynamic });
  });
});

describe("chat_usage event fields (THI-180 §3.3 / THI-197)", () => {
  it("carries exactly model/credential_source/rounds/tokens_in/tokens_out/daily_total/budget/usage_source", () => {
    const event: SecurityEvent = {
      type: "chat_usage",
      model: "gpt-4o-mini",
      credential_source: "company",
      rounds: 2,
      tokens_in: 450,
      tokens_out: 120,
      daily_total: 570,
      budget: 2_000_000,
      usage_source: "provider",
    };
    expectTypeOf(event).toEqualTypeOf<{
      type: "chat_usage";
      model: string;
      credential_source: "company" | "user";
      rounds: number;
      tokens_in: number;
      tokens_out: number;
      daily_total: number;
      budget: number;
      usage_source: "provider" | "estimate_fallback";
    }>();
  });

  it("usage_source is a fixed slug union, not free text (rev 2 N1)", () => {
    const dynamic: string = "provider"; // type is string — value irrelevant
    // @ts-expect-error usage_source must be a literal — dynamic strings do not typecheck
    const event: SecurityEvent = { type: "chat_usage", model: "m", credential_source: "company", rounds: 1, tokens_in: 1, tokens_out: 1, daily_total: 1, budget: 1, usage_source: dynamic };
    expectTypeOf(event).toBeObject();
  });

  it("credential_source is a fixed slug union, not free text (THI-197)", () => {
    const dynamic: string = "user"; // type is string — value irrelevant
    // @ts-expect-error credential_source must be a literal — dynamic strings do not typecheck
    const event: SecurityEvent = { type: "chat_usage", model: "m", credential_source: dynamic, rounds: 1, tokens_in: 1, tokens_out: 1, daily_total: 1, budget: 1, usage_source: "provider" };
    expectTypeOf(event).toBeObject();
  });

  it("has no optional extra fields (whitelist is exact)", () => {
    // @ts-expect-error unknown fields (e.g. a future message-content leak) must not typecheck
    const leaky: SecurityEvent = { type: "chat_usage", model: "m", credential_source: "company", rounds: 1, tokens_in: 1, tokens_out: 1, daily_total: 1, budget: 1, usage_source: "provider", content: "user text" };
    expectTypeOf(leaky).toBeObject();
  });
});
