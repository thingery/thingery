// Unit tests for the gate-integrity detector's verdict-citation rule
// (ADR 0007, Decision 7 — THI-1641). Regression coverage for security review
// THI-1646 F1: a citation whose timestamp is regex-valid but unparsable must
// produce a `malformed` finding — never a thrown RangeError — and must not
// defeat a well-formed citation elsewhere in the body. Pure function tests:
// no GitHub access, no DB.

import { describe, expect, it } from "vitest";
import { alertBody, verdictCitationViolation } from "../scripts/check-merge-gate.mjs";

const botApproval = (overrides: Record<string, unknown> = {}) => ({
  state: "APPROVED",
  user: { login: "thingery-review-bot" },
  submitted_at: "2026-11-27T12:00:00Z",
  body: "Approved. Head 9ba70f5 pinned. Verdict: THI-1634 @ 2026-11-27T11:00:00Z",
  ...overrides,
});

describe("verdictCitationViolation — applicability", () => {
  it("returns null for a valid, correctly ordered citation", () => {
    expect(verdictCitationViolation(botApproval())).toBeNull();
  });

  it("accepts citations with fractional seconds", () => {
    expect(
      verdictCitationViolation(botApproval({ body: "Verdict: THI-1634 @ 2026-11-27T11:00:00.123Z" })),
    ).toBeNull();
  });

  it("ignores non-bot reviewers", () => {
    expect(verdictCitationViolation(botApproval({ user: { login: "some-human" }, body: "no citation" }))).toBeNull();
  });

  it("ignores COMMENTED reviews", () => {
    expect(verdictCitationViolation(botApproval({ state: "COMMENTED" }))).toBeNull();
  });

  it("grandfathers approvals submitted before the effective time", () => {
    expect(
      verdictCitationViolation(botApproval({ submitted_at: "2026-11-26T23:59:59.999Z", body: "no citation" })),
    ).toBeNull();
  });

  it("applies the rule at the boundary instant itself (inclusive)", () => {
    expect(
      verdictCitationViolation(
        botApproval({ submitted_at: "2026-11-27T00:00:00.000Z", body: "Verdict: THI-1634 @ 2026-11-26T23:00:00Z" }),
      ),
    ).toBeNull();
    expect(
      verdictCitationViolation(
        botApproval({ submitted_at: "2026-11-27T00:00:00.000Z", body: "no citation" }),
      )?.kind,
    ).toBe("missing");
  });
});

describe("verdictCitationViolation — finding kinds", () => {
  it("flags a body with no citation as missing", () => {
    expect(verdictCitationViolation(botApproval({ body: "LGTM" }))).toEqual({
      kind: "missing",
      submitted: "2026-11-27T12:00:00Z",
    });
  });

  it("flags a citation that postdates the approval, normalizing the timestamp", () => {
    expect(
      verdictCitationViolation(botApproval({ body: "Verdict: THI-1634 @ 2026-11-27T13:00:00Z" })),
    ).toEqual({
      kind: "postdates",
      submitted: "2026-11-27T12:00:00Z",
      cited: "2026-11-27T13:00:00.000Z",
      issue: "THI-1634",
    });
  });

  it("flags an out-of-range citation as malformed without throwing (THI-1646 F1 regression)", () => {
    // Old code called new Date(NaN).toISOString() here and threw RangeError,
    // blinding the whole scheduled scan for every window containing the PR.
    expect(() =>
      verdictCitationViolation(botApproval({ body: "Verdict: THI-123 @ 2026-13-99T99:99:99Z" })),
    ).not.toThrow();
    expect(verdictCitationViolation(botApproval({ body: "Verdict: THI-123 @ 2026-13-99T99:99:99Z" }))).toEqual({
      kind: "malformed",
      submitted: "2026-11-27T12:00:00Z",
      cited: "2026-13-99T99:99:99Z",
      issue: "THI-123",
    });
  });

  it("flags a truncated citation that satisfies the regex char class as malformed (THI-1646 F1 regression)", () => {
    expect(() =>
      verdictCitationViolation(botApproval({ body: "Verdict: THI-123 @ 2026-11-28T.Z" })),
    ).not.toThrow();
    expect(verdictCitationViolation(botApproval({ body: "Verdict: THI-123 @ 2026-11-28T.Z" }))?.kind).toBe(
      "malformed",
    );
  });

  it("a malformed citation does not defeat a well-formed one elsewhere in the body", () => {
    const body = "Verdict: THI-123 @ 2026-13-99T99:99:99Z\nVerdict: THI-1634 @ 2026-11-27T11:00:00Z";
    expect(verdictCitationViolation(botApproval({ body }))).toBeNull();
  });
});

describe("alertBody — malformed findings render without throwing", () => {
  it("renders the raw timestamp for a malformed citation and states the dedup scope", () => {
    const body = alertBody(
      { from: "2026-11-27T00:00:00Z", to: "2026-11-27T06:00:00Z", source: "explicit" },
      [],
      [],
      [],
      { state: "read", actual: {} },
      [],
      "",
      [
        {
          number: 401,
          findings: [
            { kind: "malformed", submitted: "2026-11-27T12:00:00Z", cited: "2026-13-99T99:99:99Z", issue: "THI-123" },
          ],
        },
      ],
    );
    expect(body).toContain("not a parsable timestamp");
    expect(body).toContain("2026-13-99T99:99:99Z");
    expect(body).toContain("gate-verdict-citation pr=401");
    expect(body).toContain("will not raise a second alert");
  });
});
