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
  type SecurityEvent,
  type SecurityEventReason,
  type SecurityEventRoute,
} from "../src/security-events.js";

describe("SecurityEvent route/reason literal unions (THI-133)", () => {
  it("route accepts only the fixed literals", () => {
    expectTypeOf<SecurityEventRoute>().toEqualTypeOf<"/api/signup" | "/api/login" | "/mcp">();
    const routes: SecurityEventRoute[] = ["/api/signup", "/api/login", "/mcp"];
    expectTypeOf(routes).toEqualTypeOf<SecurityEventRoute[]>();
  });

  it("reason accepts only the fixed slugs", () => {
    expectTypeOf<SecurityEventReason>().toEqualTypeOf<
      "unsupported_media_type" | "empty" | "too_large" | "not_owned"
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
