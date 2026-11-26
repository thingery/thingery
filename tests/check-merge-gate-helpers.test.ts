// Unit tests for the merge-gate integrity detector's general helpers
// (ADR 0007, Decision 2): parseArgs, countValidApprovals, reportedMarkers.
// Follow-up from security review THI-1646 on PR #408 (THI-1654): the F1
// regression file covers verdictCitationViolation only; this file pins the
// named edge cases of the approval-counting rule — superseded reviews,
// commit_id attachment, PENDING/COMMENTED transparency, the pre-merge
// cutoff, and equal-timestamp tie-breaking — plus body-vs-comment dedup in
// reportedMarkers and CLI/env arg parsing. GitHub access is stubbed at the
// global fetch seam; no DB, no network.

import { afterEach, describe, expect, it, vi } from "vitest";
import { countValidApprovals, parseArgs, reportedMarkers } from "../scripts/check-merge-gate.mjs";

const HEAD_SHA = "9ba70f5abcdef1234567890abcdef1234567890";
const MERGE_MS = Date.parse("2026-11-27T13:00:00Z");

const review = (overrides: Record<string, unknown> = {}) => ({
  user: { login: "alice" },
  state: "APPROVED",
  submitted_at: "2026-11-27T12:00:00Z",
  commit_id: HEAD_SHA,
  ...overrides,
});

const pr = (overrides: Record<string, unknown> = {}) => ({
  number: 1,
  head: { sha: HEAD_SHA },
  ...overrides,
});

/** Stub the paged() fetch seam: every page returns the given list (< 100
 * items, so pagination stops after page 1). Records requested URLs. */
function stubPages(list: unknown[]) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => list };
    }),
  );
  return urls;
}

const logins = (valid: { user?: { login?: string } }[]) => valid.map((r) => r.user?.login);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// --------------------------------------------------------------- parseArgs

describe("parseArgs — defaults and flags", () => {
  it("returns all-default args for an empty argv", () => {
    expect(parseArgs([])).toEqual({
      from: null,
      to: null,
      dryRun: false,
      failOnFindings: false,
      verbose: false,
    });
  });

  it("parses and normalizes --from/--to to UTC ISO 8601", () => {
    const args = parseArgs(["--from", "2026-11-27T12:00:00+02:00", "--to", "2026-11-27T13:00:00Z"]);
    expect(args.from).toBe("2026-11-27T10:00:00.000Z");
    expect(args.to).toBe("2026-11-27T13:00:00.000Z");
  });

  it("parses the boolean flags", () => {
    const args = parseArgs(["--dry-run", "--fail-on-findings", "--verbose"]);
    expect(args.dryRun).toBe(true);
    expect(args.failOnFindings).toBe(true);
    expect(args.verbose).toBe(true);
  });

  it("rejects unknown arguments", () => {
    expect(() => parseArgs(["--dryrun"])).toThrow(/unknown argument: --dryrun/);
  });

  it("rejects --to without --from", () => {
    expect(() => parseArgs(["--to", "2026-11-27T13:00:00Z"])).toThrow(/--to requires --from/);
  });

  it("rejects --from not earlier than --to", () => {
    expect(() =>
      parseArgs(["--from", "2026-11-27T13:00:00Z", "--to", "2026-11-27T13:00:00Z"]),
    ).toThrow(/--from must be earlier than --to/);
    // Inverted order must fail too, not silently swap.
    expect(() =>
      parseArgs(["--from", "2026-11-27T14:00:00Z", "--to", "2026-11-27T13:00:00Z"]),
    ).toThrow(/--from must be earlier than --to/);
  });

  it("rejects a non-ISO value, naming the flag", () => {
    expect(() => parseArgs(["--from", "yesterday"])).toThrow(/--from needs an ISO 8601 timestamp/);
  });

  it("rejects a missing value after the flag (argv ends)", () => {
    expect(() => parseArgs(["--from"])).toThrow(/--from needs an ISO 8601 timestamp/);
  });
});

describe("parseArgs — environment fallbacks", () => {
  it("DRY_RUN=true forces a dry run", () => {
    vi.stubEnv("DRY_RUN", "true");
    expect(parseArgs([]).dryRun).toBe(true);
    vi.stubEnv("DRY_RUN", "1");
    expect(parseArgs([]).dryRun).toBe(true);
    // Any other value is ignored.
    vi.stubEnv("DRY_RUN", "0");
    expect(parseArgs([]).dryRun).toBe(false);
  });

  it("GATE_FROM/GATE_TO fill unset flags but never override explicit ones", () => {
    vi.stubEnv("GATE_FROM", "2026-11-26T00:00:00Z");
    vi.stubEnv("GATE_TO", "2026-11-27T00:00:00Z");
    expect(parseArgs([]).from).toBe("2026-11-26T00:00:00.000Z");
    expect(parseArgs([]).to).toBe("2026-11-27T00:00:00.000Z");
    // Explicit flag wins over env.
    expect(parseArgs(["--from", "2026-11-20T00:00:00Z"]).from).toBe("2026-11-20T00:00:00.000Z");
  });

  it("validates env-provided values like flag values", () => {
    vi.stubEnv("GATE_FROM", "not-a-timestamp");
    expect(() => parseArgs([])).toThrow(/--from needs an ISO 8601 timestamp/);
  });
});

// ----------------------------------------------------- countValidApprovals

describe("countValidApprovals — basics", () => {
  it("counts one pre-merge approval attached to the merged head", async () => {
    stubPages([review()]);
    const valid = await countValidApprovals(pr(), MERGE_MS);
    expect(logins(valid)).toEqual(["alice"]);
  });

  it("counts one valid approval per reviewer (latest decision wins per reviewer)", async () => {
    stubPages([
      review({ user: { login: "alice" } }),
      review({ user: { login: "bob" }, submitted_at: "2026-11-27T12:30:00Z" }),
    ]);
    expect(logins(await countValidApprovals(pr(), MERGE_MS))).toEqual(["alice", "bob"]);
  });

  it("skips reviews without a login or a submitted_at (they count and supersede nothing)", async () => {
    stubPages([
      review({ user: undefined }), // no login: invisible to the rule
      review({ submitted_at: undefined }), // no timestamp: invisible too
      review({ user: { login: "bob" }, submitted_at: "2026-11-27T12:30:00Z" }),
    ]);
    expect(logins(await countValidApprovals(pr(), MERGE_MS))).toEqual(["bob"]);
  });
});

describe("countValidApprovals — superseded reviews", () => {
  it("a later CHANGES_REQUESTED supersedes the reviewer's earlier approval", async () => {
    stubPages([
      review({ submitted_at: "2026-11-27T11:00:00Z" }),
      review({ state: "CHANGES_REQUESTED", submitted_at: "2026-11-27T12:00:00Z" }),
    ]);
    expect(await countValidApprovals(pr(), MERGE_MS)).toEqual([]);
  });

  it("a re-approval after CHANGES_REQUESTED is valid again", async () => {
    stubPages([
      review({ submitted_at: "2026-11-27T11:00:00Z" }),
      review({ state: "CHANGES_REQUESTED", submitted_at: "2026-11-27T12:00:00Z" }),
      review({ submitted_at: "2026-11-27T12:30:00Z" }),
    ]);
    expect(logins(await countValidApprovals(pr(), MERGE_MS))).toEqual(["alice"]);
  });

  it("supersession is per reviewer: bob's approval survives alice's dismissal", async () => {
    stubPages([
      review({ user: { login: "alice" }, submitted_at: "2026-11-27T11:00:00Z" }),
      review({ user: { login: "alice" }, state: "CHANGES_REQUESTED", submitted_at: "2026-11-27T12:00:00Z" }),
      review({ user: { login: "bob" }, submitted_at: "2026-11-27T12:30:00Z" }),
    ]);
    expect(logins(await countValidApprovals(pr(), MERGE_MS))).toEqual(["bob"]);
  });
});

describe("countValidApprovals — commit_id attachment", () => {
  it("rejects an approval attached to a different commit than the merged head", async () => {
    stubPages([review({ commit_id: "0000000oldcommit000000000000000000000000000" })]);
    expect(await countValidApprovals(pr(), MERGE_MS)).toEqual([]);
  });

  it("accepts an approval without commit_id (older API shapes: attachment unknown, not disproven)", async () => {
    stubPages([review({ commit_id: undefined })]);
    expect(logins(await countValidApprovals(pr(), MERGE_MS))).toEqual(["alice"]);
  });

  it("ignores commit_id entirely when the PR head sha is unavailable", async () => {
    stubPages([review({ commit_id: "0000000unrelated00000000000000000000000000000" })]);
    expect(logins(await countValidApprovals(pr({ head: undefined }), MERGE_MS))).toEqual(["alice"]);
  });
});

describe("countValidApprovals — PENDING/COMMENTED transparency", () => {
  it("a COMMENTED review does not supersede the reviewer's earlier approval", async () => {
    stubPages([
      review({ submitted_at: "2026-11-27T11:00:00Z" }),
      review({ state: "COMMENTED", submitted_at: "2026-11-27T12:00:00Z" }),
    ]);
    expect(logins(await countValidApprovals(pr(), MERGE_MS))).toEqual(["alice"]);
  });

  it("a PENDING review does not supersede the reviewer's earlier approval", async () => {
    stubPages([
      review({ submitted_at: "2026-11-27T11:00:00Z" }),
      review({ state: "PENDING", submitted_at: "2026-11-27T12:00:00Z" }),
    ]);
    expect(logins(await countValidApprovals(pr(), MERGE_MS))).toEqual(["alice"]);
  });

  it("a reviewer with only COMMENTED/PENDING reviews is not counted", async () => {
    stubPages([
      review({ state: "COMMENTED", submitted_at: "2026-11-27T11:00:00Z" }),
      review({ state: "PENDING", submitted_at: "2026-11-27T12:00:00Z" }),
    ]);
    expect(await countValidApprovals(pr(), MERGE_MS)).toEqual([]);
  });
});

describe("countValidApprovals — pre-merge cutoff", () => {
  it("ignores an approval submitted after the merge (boundary is inclusive)", async () => {
    stubPages([review({ submitted_at: "2026-11-27T13:00:01Z" })]);
    expect(await countValidApprovals(pr(), MERGE_MS)).toEqual([]);

    // Exactly at merge time counts: t > mergedMs is the exclusion rule.
    stubPages([review({ submitted_at: "2026-11-27T13:00:00Z" })]);
    expect(logins(await countValidApprovals(pr(), MERGE_MS))).toEqual(["alice"]);
  });

  it("a post-merge CHANGES_REQUESTED cannot retroactively invalidate a pre-merge approval", async () => {
    stubPages([
      review({ submitted_at: "2026-11-27T12:00:00Z" }),
      review({ state: "CHANGES_REQUESTED", submitted_at: "2026-11-27T13:00:01Z" }),
    ]);
    expect(logins(await countValidApprovals(pr(), MERGE_MS))).toEqual(["alice"]);
  });
});

describe("countValidApprovals — equal-timestamp tie-breaking", () => {
  const T = "2026-11-27T12:00:00Z";

  it("with identical submitted_at, the later entry in the list wins (dismissal after approval)", async () => {
    stubPages([
      review({ submitted_at: T }),
      review({ state: "CHANGES_REQUESTED", submitted_at: T }),
    ]);
    expect(await countValidApprovals(pr(), MERGE_MS)).toEqual([]);
  });

  it("with identical submitted_at, a later re-approval wins (approval after dismissal)", async () => {
    stubPages([
      review({ state: "CHANGES_REQUESTED", submitted_at: T }),
      review({ submitted_at: T }),
    ]);
    expect(logins(await countValidApprovals(pr(), MERGE_MS))).toEqual(["alice"]);
  });
});

// -------------------------------------------------------- reportedMarkers

describe("reportedMarkers — parsing", () => {
  it("returns empty sets for a null body and no comments", async () => {
    stubPages([]);
    const markers = await reportedMarkers({ number: 7, body: null });
    expect(markers.prs.size).toBe(0);
    expect(markers.fingerprints.size).toBe(0);
  });

  it("parses violation PR numbers and drift fingerprints from the issue body", async () => {
    stubPages([]);
    const markers = await reportedMarkers({
      number: 7,
      body: "<!-- gate-violation pr=408 -->\n<!-- gate-config-drift fingerprint=0123abcd -->",
    });
    expect([...markers.prs]).toEqual([408]);
    expect([...markers.fingerprints]).toEqual(["0123abcd"]);
  });

  it("parses markers across multiple comments", async () => {
    stubPages([
      { body: "<!-- gate-violation pr=401 -->" },
      { body: "<!-- gate-violation pr=402 -->\n<!-- gate-config-drift fingerprint=deadbeef -->" },
    ]);
    const markers = await reportedMarkers({ number: 7, body: "tracking issue body, no markers" });
    expect([...markers.prs].sort((a, b) => a - b)).toEqual([401, 402]);
    expect([...markers.fingerprints]).toEqual(["deadbeef"]);
  });

  it("does not match malformed markers: non-numeric PRs, non-hex fingerprints, or missing values", async () => {
    stubPages([
      { body: "gate-violation pr=abc; gate-violation pr=; gate-config-drift fingerprint=XYZZY; plain text" },
    ]);
    const markers = await reportedMarkers({ number: 7, body: null });
    expect(markers.prs.size).toBe(0);
    expect(markers.fingerprints.size).toBe(0);
  });

  it("skips comments with a null body", async () => {
    stubPages([{ body: null }, { body: "<!-- gate-violation pr=405 -->" }]);
    const markers = await reportedMarkers({ number: 7, body: null });
    expect([...markers.prs]).toEqual([405]);
  });
});

describe("reportedMarkers — body-vs-comment dedup", () => {
  it("a PR already reported in the body is deduplicated against the same PR in a comment", async () => {
    // Historical bug (comment-only scan): the create path writes the first
    // findings batch into the body, so the next overlapping run re-reported
    // it once as a duplicate comment. The marker set must unify both.
    stubPages([{ body: "<!-- gate-violation pr=408 -->" }]);
    const markers = await reportedMarkers({
      number: 7,
      body: "## Merge-gate integrity alert\n<!-- gate-violation pr=408 -->",
    });
    expect(markers.prs.size).toBe(1);
    expect(markers.prs.has(408)).toBe(true);
  });

  it("a fingerprint already reported in the body is deduplicated against the same fingerprint in a comment", async () => {
    stubPages([{ body: "<!-- gate-config-drift fingerprint=0123abcd -->" }]);
    const markers = await reportedMarkers({
      number: 7,
      body: "<!-- gate-config-drift fingerprint=0123abcd -->",
    });
    expect(markers.fingerprints.size).toBe(1);
    expect(markers.fingerprints.has("0123abcd")).toBe(true);
  });

  it("distinct markers from body and comments accumulate separately", async () => {
    stubPages([{ body: "<!-- gate-violation pr=409 -->" }]);
    const markers = await reportedMarkers({ number: 7, body: "<!-- gate-violation pr=408 -->" });
    expect(markers.prs.size).toBe(2);
  });
});
