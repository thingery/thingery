#!/usr/bin/env node
/**
 * Merge-gate integrity check for the `main` branch (ADR 0007, Decision 2).
 *
 * Point-in-time reads of branch protection cannot prove the 1-review gate was
 * live at every merge: an owner can flip the requirement off, merge, and flip
 * it back, leaving no trace in the current config. This control reconstructs
 * the gate state at each merge instead:
 *
 *   1. Lists PRs merged to `main` in the check window — since the last
 *      successful run of this workflow (state fallback: last 24h).
 *   2. Counts approvals that were valid at merge time per PR: state APPROVED,
 *      submitted at or before merge time, not superseded by that reviewer's
 *      later review, and attached to the merged head commit.
 *   3. Reads branch protection on `main` and compares it to the ADR 0007
 *      baseline: required_approving_review_count = 1, dismiss_stale_reviews,
 *      require_last_push_approval, enforce_admins — all enabled.
 *   4. Reports zero-valid-approval merges and baseline drift on a dedicated
 *      tracking issue ("Merge-gate integrity alerts"), deduplicated per PR
 *      and per drift fingerprint so repeated runs never double-report.
 *   5. Since ADR 0007 Decision 7 (THI-1641, effective 2026-11-27T00:00:00Z):
 *      a counted `thingery-review-bot` approval must cite the verdict on the
 *      review issue (`Verdict: THI-<n> @ <ISO-8601 UTC>`), the cited
 *      timestamp must not postdate the approval, and every citation in the
 *      body must be parsable (kind `malformed` otherwise — THI-1646 F1: a
 *      regex-valid but unparsable timestamp must never crash the scan).
 *      Violations are reported on the same tracking issue with their own
 *      dedup marker. GitHub-side only: whether the cited verdict actually
 *      exists on the review tracker is an agent-audit control (Decision 7),
 *      not a check this script can make.
 *
 * Uses only the workflow's built-in GITHUB_TOKEN — no secrets, no PATs.
 *
 * Usage:
 *   node scripts/check-merge-gate.mjs [--from ISO --to ISO] [--dry-run]
 *       [--fail-on-findings] [--verbose]
 *
 * Exit codes: 0 ok (findings delivered or none), 1 findings found with
 * --fail-on-findings, 2 operational error (bad args, API failure).
 */

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const REPO = process.env.GITHUB_REPOSITORY ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const BASE_BRANCH = "main";
const WORKFLOW_FILE = "gate-integrity.yml";
const TRACKING_TITLE = "Merge-gate integrity alerts";
const OVERLAP_MS = 10 * 60 * 1000; // re-scan margin between consecutive runs
const FALLBACK_WINDOW_H = 24; // used when no prior successful run exists
const MAX_PAGES = 20;
const BOT_LOGINS = new Set(["github-actions[bot]"]);

// ADR 0007, Decision 7 (THI-1641): bot approvals submitted at or after this
// time must cite the verdict on the review issue; the cited timestamp must
// not postdate the approval. Earlier approvals are grandfathered. Keep in
// sync with the effective time written in docs/adr/0007-merge-gate-review-bot.md
// (Decision 7).
const VERDICT_CITATION_EFFECTIVE_MS = Date.parse("2026-11-27T00:00:00Z");
const BOT_REVIEWER_LOGINS = new Set(["thingery-review-bot", "thingery-review-bot[bot]"]);
const VERDICT_CITATION_RE = /verdict\s*:\s*THI-(\d+)\s*@\s*(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/gi;

// ADR 0007, Decision 2 + unchanged strict settings.
const BASELINE = {
  "required_pull_request_reviews.required_approving_review_count": 1,
  "required_pull_request_reviews.dismiss_stale_reviews": true,
  "required_pull_request_reviews.require_last_push_approval": true,
  "enforce_admins.enabled": true,
};

// ---------------------------------------------------------------- CLI args

function parseArgs(argv) {
  const args = { from: null, to: null, dryRun: false, failOnFindings: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = requireIso(argv[++i], a);
    else if (a === "--to") args.to = requireIso(argv[++i], a);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--fail-on-findings") args.failOnFindings = true;
    else if (a === "--verbose") args.verbose = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.to && !args.from) throw new Error("--to requires --from");
  if (process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1") args.dryRun = true;
  if (!args.from && process.env.GATE_FROM) args.from = requireIso(process.env.GATE_FROM, "--from");
  if (!args.to && process.env.GATE_TO) args.to = requireIso(process.env.GATE_TO, "--to");
  if (args.from && args.to && Date.parse(args.from) >= Date.parse(args.to)) {
    throw new Error("--from must be earlier than --to");
  }
  return args;
}

function requireIso(value, flag) {
  const t = Date.parse(value ?? "");
  if (Number.isNaN(t)) throw new Error(`${flag} needs an ISO 8601 timestamp, got: ${value}`);
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------- GitHub API

function api(path) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  }).then(async (res) => ({ ok: res.ok, status: res.status, json: await res.json().catch(() => null) }));
}

async function paged(path, pick) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await api(`${path}${sep}per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    const items = pick(res.json);
    // A 200 with a malformed body is an operational error, not an empty
    // list: treating it as empty would fabricate "no findings" instead of
    // failing the run.
    if (!Array.isArray(items)) throw new Error(`GET ${path} -> malformed page body (expected an array)`);
    if (!items.length) return out;
    out.push(...items);
    if (items.length < 100) return out;
  }
  console.error(
    `gate-integrity: warning: GET ${path} truncated at MAX_PAGES=${MAX_PAGES} (${out.length} items) — results may be incomplete`,
  );
  return out;
}

// ---------------------------------------------------------------- window

/** Incremental window: since the last successful run of this workflow
 * (minus a re-scan margin); fallback: last FALLBACK_WINDOW_H hours. */
async function resolveWindow(explicitFrom, explicitTo) {
  if (explicitFrom) return { from: explicitFrom, to: explicitTo ?? new Date().toISOString(), source: "explicit" };
  let from = null;
  const res = await api(`/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?status=success&per_page=1`);
  if (res.ok && res.json?.workflow_runs?.length) {
    const started = res.json.workflow_runs[0].run_started_at ?? res.json.workflow_runs[0].created_at;
    const t = Date.parse(started);
    if (!Number.isNaN(t)) from = new Date(t - OVERLAP_MS).toISOString();
  }
  if (!from) from = new Date(Date.now() - FALLBACK_WINDOW_H * 3600 * 1000).toISOString();
  return { from, to: new Date().toISOString(), source: "incremental" };
}

// ---------------------------------------------------------------- merged PRs

async function listMergedPRs(fromMs, toMs) {
  const out = [];
  let truncated = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await api(`/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`GET pulls -> HTTP ${res.status}`);
    // A 200 with a malformed body is an operational error, not an empty list.
    if (!Array.isArray(res.json)) throw new Error("GET pulls -> malformed page body (expected an array)");
    const batch = res.json;
    if (!batch.length) break;
    for (const pr of batch) {
      const merged = pr.merged_at ? Date.parse(pr.merged_at) : NaN;
      if (!Number.isNaN(merged) && merged >= fromMs && merged <= toMs && pr.base?.ref === BASE_BRANCH) out.push(pr);
    }
    // merged_at <= updated_at always holds for merged PRs, so once a whole
    // page is older than the window start, everything further is too.
    const allOld = batch.every((pr) => !pr.updated_at || Date.parse(pr.updated_at) < fromMs);
    if (allOld) break;
    if (page === MAX_PAGES) truncated = true;
  }
  if (truncated) {
    console.error(
      `gate-integrity: warning: pull list truncated at MAX_PAGES=${MAX_PAGES} (${out.length} PRs in window) — results may be incomplete`,
    );
  }
  return out;
}

/** Approvals valid at merge time: per reviewer, their latest pre-merge
 * decisional review (COMMENTED/PENDING are transparent) counts only if it is
 * APPROVED and attached to the merged head commit (or has no commit_id). */
async function countValidApprovals(pr, mergedMs) {
  const reviews = await paged(`/repos/${REPO}/pulls/${pr.number}/reviews`, (j) => j);
  const latest = new Map();
  for (const r of reviews) {
    if (!r.user?.login || !r.submitted_at) continue;
    if (r.state === "PENDING" || r.state === "COMMENTED") continue;
    const t = Date.parse(r.submitted_at);
    if (t > mergedMs) continue;
    const prev = latest.get(r.user.login);
    if (!prev || Date.parse(prev.submitted_at) <= t) latest.set(r.user.login, r);
  }
  return [...latest.values()].filter(
    (r) => r.state === "APPROVED" && (!r.commit_id || !pr.head?.sha || r.commit_id === pr.head.sha),
  );
}

/** ADR 0007, Decision 7 (THI-1641): a counted bot approval is valid only if it
 * cites the verdict on the review issue and the cited verdict timestamp does
 * not postdate the approval. Returns null when the check does not apply (not a
 * bot review, not APPROVED, submitted before the Decision-7 effective time) or
 * when at least one citation is parsable and correctly ordered; otherwise
 * returns a finding descriptor with kind `missing` (no citation in the body),
 * `malformed` (citation matches the pattern but its timestamp is unparsable —
 * reported with the raw captured string; never normalized, never a crash:
 * THI-1646 F1), or `postdates` (parsable citation newer than the approval).
 * Every citation in the body is scanned: one bad line does not defeat a
 * well-formed citation elsewhere. GitHub-side only: whether the cited verdict
 * actually exists on the review tracker is an agent-audit control, not
 * checkable here. */
export function verdictCitationViolation(review) {
  if (!review || review.state !== "APPROVED") return null;
  if (!BOT_REVIEWER_LOGINS.has(review.user?.login ?? "")) return null;
  const submittedMs = Date.parse(review.submitted_at ?? "");
  if (Number.isNaN(submittedMs) || submittedMs < VERDICT_CITATION_EFFECTIVE_MS) return null;
  const matches = [...(review.body ?? "").matchAll(VERDICT_CITATION_RE)];
  if (!matches.length) return { kind: "missing", submitted: review.submitted_at };
  const malformed = [];
  const postdating = [];
  let hasValid = false;
  for (const m of matches) {
    const citedMs = Date.parse(m[2]);
    if (Number.isNaN(citedMs)) malformed.push({ issue: `THI-${m[1]}`, cited: m[2] });
    else if (citedMs > submittedMs) postdating.push({ issue: `THI-${m[1]}`, cited: new Date(citedMs).toISOString() });
    else hasValid = true;
  }
  if (hasValid) return null;
  if (malformed.length) {
    return { kind: "malformed", submitted: review.submitted_at, cited: malformed[0].cited, issue: malformed[0].issue };
  }
  return { kind: "postdates", submitted: review.submitted_at, cited: postdating[0].cited, issue: postdating[0].issue };
}

/** The PR list endpoint returns merged_by: null for merged PRs; the single
 * PR fetch has it. Called only for flagged PRs so windows stay cheap. */
async function enrichMergedBy(number, details) {
  const res = await api(`/repos/${REPO}/pulls/${number}`);
  if (res.ok && res.json?.merged_by?.login) {
    const d = details.find((x) => x.number === number);
    if (d) d.merged_by = res.json.merged_by.login;
  }
}

// ---------------------------------------------------------------- protection

/** Reads branch protection on `main`. Degrades gracefully when the token
 * cannot read it: merge detection still runs, drift check reports why. */
async function readProtection() {
  const res = await api(`/repos/${REPO}/branches/${BASE_BRANCH}/protection`);
  if (res.ok) {
    const p = res.json ?? {};
    const rpr = p.required_pull_request_reviews ?? {};
    return {
      state: "read",
      actual: {
        "required_pull_request_reviews.required_approving_review_count": rpr.required_approving_review_count,
        "required_pull_request_reviews.dismiss_stale_reviews": rpr.dismiss_stale_reviews ?? rpr.dismiss_stale_reviews_enabled,
        "required_pull_request_reviews.require_last_push_approval": rpr.require_last_push_approval ?? rpr.require_last_push_approval_enabled,
        "enforce_admins.enabled": p.enforce_admins?.enabled ?? p.enforce_admins,
      },
    };
  }
  if (res.status === 404) return { state: "unprotected" };
  return { state: "unavailable", detail: `HTTP ${res.status}` };
}

function driftEntries(protection) {
  if (protection.state === "unprotected") {
    return Object.keys(BASELINE).map((field) => ({ field, expected: BASELINE[field], actual: "<branch not protected>" }));
  }
  if (protection.state !== "read") return [];
  return Object.keys(BASELINE)
    .filter((field) => protection.actual[field] !== BASELINE[field])
    .map((field) => ({ field, expected: BASELINE[field], actual: protection.actual[field] }));
}

const fingerprint = (drift) =>
  createHash("sha256")
    .update(JSON.stringify([...drift].sort((a, b) => a.field.localeCompare(b.field))))
    .digest("hex")
    .slice(0, 16);

// ---------------------------------------------------------------- reporting

function printReport(window_, prs, violations, details, protection, drift, args, citations) {
  const lines = [];
  lines.push(`gate-integrity: window ${window_.from} → ${window_.to} (${window_.source})`);
  lines.push(`gate-integrity: scanned ${prs.length} merged PRs on ${BASE_BRANCH}`);
  if (args.verbose) {
    for (const d of details) {
      lines.push(
        `  #${d.number} merged=${d.merged_at} by=${d.merged_by} author=${d.author} valid_approvals=${d.valid}` +
          (d.valid ? ` [${d.validBy.join(", ")}]` : "  <-- FLAGGED"),
      );
    }
  }
  lines.push(
    violations.length
      ? `gate-integrity: FLAGGED ${violations.length} merge(s) with zero valid approvals: ${violations.map((n) => `#${n}`).join(", ")}`
      : "gate-integrity: no zero-valid-approval merges",
  );
  lines.push(
    citations.length
      ? `gate-integrity: FLAGGED ${citations.length} bot approval(s) without valid verdict citation (ADR 0007 Decision 7): ${citations.map((c) => `#${c.number}`).join(", ")}`
      : "gate-integrity: no verdict-citation violations",
  );
  if (protection.state === "read") {
    lines.push(drift.length ? `gate-integrity: branch protection DRIFTED from ADR 0007 baseline` : "gate-integrity: branch protection matches ADR 0007 baseline");
  } else if (protection.state === "unprotected") {
    lines.push("gate-integrity: branch `main` is NOT PROTECTED (baseline drift)");
  } else {
    lines.push(`gate-integrity: branch protection unreadable (${protection.detail}) — drift check skipped`);
  }
  const summary = lines.join("\n");
  console.log(summary);
  const ghSummary = process.env.GITHUB_STEP_SUMMARY;
  if (ghSummary) {
    try {
      appendFileSync(ghSummary, `## Merge-gate integrity check\n\n\`\`\`\n${summary}\n\`\`\`\n`);
    } catch {
      /* summary file is best-effort */
    }
  }
}

function alertBody(window_, prs, violations, details, protection, drift, fp, citations) {
  const runLink =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const out = [];
  out.push("## Merge-gate integrity alert");
  out.push("");
  out.push(`- **Run:** ${new Date().toISOString()}${runLink ? ` ([workflow run](${runLink}))` : ""}`);
  out.push(`- **Window:** ${window_.from} → ${window_.to}`);
  out.push(`- **Merges to \`${BASE_BRANCH}\` scanned:** ${prs.length}`);
  out.push(`- **Merged with zero valid approvals:** ${violations.length}`);
  out.push(
    `- **Branch protection on \`${BASE_BRANCH}\`:** ${
      protection.state === "read"
        ? drift.length
          ? "**DRIFTED from baseline** (see below)"
          : "matches ADR 0007 baseline"
        : protection.state === "unprotected"
          ? "**NOT PROTECTED**"
          : `unreadable (${protection.detail})`
    }`,
  );
  if (violations.length) {
    out.push("");
    out.push(`### Merged to \`${BASE_BRANCH}\` with zero valid approvals`);
    out.push("");
    out.push("| PR | Merged (UTC) | Merged by | Author | Head at merge |");
    out.push("|---|---|---|---|---|");
    for (const d of details.filter((x) => violations.includes(x.number))) {
      out.push(`| #${d.number} | ${d.merged_at} | ${d.merged_by} | ${d.author} | \`${d.head}\` |`);
      out.push(`<!-- gate-violation pr=${d.number} -->`);
    }
    out.push("");
    out.push(
      "A **valid approval** is a review with state `APPROVED`, submitted at or before merge time, not superseded" +
        " by that reviewer's later review, and attached to the merged head commit. A zero-valid-approval merge" +
        " means the 1-review gate (ADR 0007, Decision 2) was **not in effect at merge time** — the branch-protection" +
        " requirement was bypassed, removed, or relaxed for the window. Owners can always do this; this alert makes it" +
        " visible. Remediation per ADR 0007: retroactive review of the merged diffs (protected paths first) and an" +
        " incident record of the flip window (who, why, exact times, PRs merged under it).",
    );
  }
  if (citations.length) {
    out.push("");
    out.push("### Bot approvals without a valid verdict citation (ADR 0007, Decision 7)");
    out.push("");
    out.push("| PR | Approval submitted (UTC) | Cited verdict | Problem |",
    );
    out.push("|---|---|---|---|");
    for (const c of citations) {
      const problem = c.findings
        .map((f) =>
          f.kind === "missing"
            ? "no `Verdict: THI-<n> @ <UTC>` citation in the approval body"
            : f.kind === "malformed"
              ? `cites ${f.issue} @ ${f.cited} — not a parsable timestamp`
              : `cites ${f.issue} @ ${f.cited}, which postdates the approval`,
        )
        .join("; ");
      out.push(
        `| #${c.number} | ${c.findings.map((f) => f.submitted).join(", ")} | ${c.findings.map((f) => f.cited ?? "—").join(", ")} | ${problem} |`,
      );
      out.push(`<!-- gate-verdict-citation pr=${c.number} -->`);
    }
    out.push("");
    out.push(
      "A **valid bot approval** (ADR 0007, Decision 7) cites the verdict on its review issue — " +
        "`Verdict: THI-<n> @ <ISO-8601 UTC>` — with the cited timestamp at or before the approval's `submitted_at`. " +
        "These violations are the signature of a racing duplicate review run (approving before any verdict existed) or, " +
        "worse, an approval with no review behind it. **Treat the approval as suspect: investigate, never auto-trusted.** " +
        "Distinguish a racing duplicate (both records exist, ordering inverted) from a fabricated approval (no verdict " +
        "record anywhere); re-anchor the approval by an explicit investigation record naming both timestamps and the " +
        "verifying agent. Found after merge, the THI-1065 remediation applies: retroactive review of the merged diff and " +
        "an incident record. Alerts deduplicate per PR marker (`gate-verdict-citation pr=<n>`): a remediation that " +
        "changes the violation kind on the same PR will not raise a second alert — re-check a reported PR directly " +
        "when auditing. The detector reads GitHub only — authenticity of the cited verdict on the review tracker is " +
        "an agent-audit control (Decision 7).",
    );
  }
  if (drift.length) {
    out.push("");
    out.push("### Branch protection drift on `main` vs ADR 0007 baseline");
    out.push("");
    out.push("| Field | Baseline | Actual |");
    out.push("|---|---|---|");
    for (const d of drift) out.push(`| \`${d.field}\` | ${d.expected} | ${d.actual} |`);
    out.push("");
    out.push(`<!-- gate-config-drift fingerprint=${fp} -->`);
    out.push("");
    out.push(
      `Restore the ADR 0007 baseline immediately and record the flip window (who, why, exact times,` +
        ` PRs merged under it). Merges made while the gate was relaxed are individually detectable by this control.`,
    );
  }
  return out.join("\n");
}

async function findTrackingIssue() {
  const issues = await paged(`/repos/${REPO}/issues?state=open`, (j) => j);
  const candidates = issues.filter(
    (i) => !i.pull_request && i.title === TRACKING_TITLE && (i.user?.type === "Bot" || BOT_LOGINS.has(i.user?.login)),
  );
  return candidates.sort((a, b) => b.number - a.number)[0] ?? null;
}

/** Markers already reported on the tracking issue — comments AND the issue
 * body itself: the create path writes the first findings batch into the
 * body, so a comment-only scan would re-report it once as a duplicate
 * comment on the next overlapping run. */
async function reportedMarkers(issue) {
  const comments = await paged(`/repos/${REPO}/issues/${issue.number}/comments`, (j) => j);
  const prs = new Set();
  const fingerprints = new Set();
  const citations = new Set();
  for (const text of [issue.body ?? "", ...comments.map((c) => c.body ?? "")]) {
    for (const m of text.matchAll(/gate-violation pr=(\d+)/g)) prs.add(Number(m[1]));
    for (const m of text.matchAll(/gate-config-drift fingerprint=([0-9a-f]+)/g)) fingerprints.add(m[1]);
    for (const m of text.matchAll(/gate-verdict-citation pr=(\d+)/g)) citations.add(Number(m[1]));
  }
  return { prs, fingerprints, citations };
}

async function deliver(window_, prs, violations, details, protection, drift, fp, citations, dryRun) {
  if (dryRun) {
    console.log("gate-integrity: dry run — no issue writes");
    return { reported: false };
  }
  const issue = await findTrackingIssue();
  const markers = issue ? await reportedMarkers(issue) : { prs: new Set(), fingerprints: new Set(), citations: new Set() };
  const newViolations = violations.filter((n) => !markers.prs.has(n));
  const newCitations = citations.filter((c) => !markers.citations.has(c.number));
  const newDrift = drift.length && !markers.fingerprints.has(fp) ? drift : [];
  if (!newViolations.length && !newDrift.length && !newCitations.length) {
    console.log(issue ? `gate-integrity: findings already reported on #${issue.number} — nothing to do` : "gate-integrity: nothing to report");
    return { reported: false };
  }
  const body = alertBody(window_, prs, newViolations, details, protection, newDrift, fp, newCitations);
  if (!issue) {
    const res = await fetch(`${API}/repos/${REPO}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ title: TRACKING_TITLE, body }),
    });
    if (!res.ok) throw new Error(`issue create -> HTTP ${res.status}`);
    const created = await res.json();
    console.log(`gate-integrity: opened tracking issue #${created.number}`);
    return { reported: true, issue: created.number };
  }
  const res = await fetch(`${API}/repos/${REPO}/issues/${issue.number}/comments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`issue comment -> HTTP ${res.status}`);
  console.log(`gate-integrity: appended alert to tracking issue #${issue.number}`);
  return { reported: true, issue: issue.number };
}

// ---------------------------------------------------------------- main

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`gate-integrity: ${err.message}`);
    return 2;
  }
  if (!REPO || !TOKEN) {
    console.error("gate-integrity: GITHUB_REPOSITORY and GITHUB_TOKEN are required");
    return 2;
  }
  try {
    const window_ = await resolveWindow(args.from, args.to);
    const fromMs = Date.parse(window_.from);
    const toMs = Date.parse(window_.to);

    const prs = await listMergedPRs(fromMs, toMs);
    const violations = [];
    const citations = [];
    const details = [];
    for (const pr of prs) {
      const mergedMs = Date.parse(pr.merged_at);
      const valid = await countValidApprovals(pr, mergedMs);
      const citeFindings = valid.map((r) => verdictCitationViolation(r)).filter(Boolean);
      if (citeFindings.length) citations.push({ number: pr.number, findings: citeFindings });
      details.push({
        number: pr.number,
        merged_at: pr.merged_at,
        merged_by: pr.merged_by?.login ?? "?",
        author: pr.user?.login ?? "?",
        head: pr.head?.sha?.slice(0, 12) ?? "?",
        valid: valid.length,
        validBy: valid.map((r) => r.user?.login),
      });
      if (!valid.length) {
        violations.push(pr.number);
        await enrichMergedBy(pr.number, details);
      }
    }
    details.sort((a, b) => a.number - b.number);
    violations.sort((a, b) => a - b);
    citations.sort((a, b) => a.number - b.number);

    const protection = await readProtection();
    const drift = driftEntries(protection);
    const fp = drift.length ? fingerprint(drift) : "";

    printReport(window_, prs, violations, details, protection, drift, args, citations);

    await deliver(window_, prs, violations, details, protection, drift, fp, citations, args.dryRun);

    if (args.failOnFindings && (violations.length || drift.length || citations.length || protection.state !== "read")) return 1;
    return 0;
  } catch (err) {
    console.error(`gate-integrity: operational error: ${err.message}`);
    return 2;
  }
}

// ---------------------------------------------------------------- exports
// Named exports keep the helpers unit-testable; nothing here is imported by app code.
export { parseArgs, resolveWindow, listMergedPRs, countValidApprovals, readProtection, driftEntries, fingerprint, alertBody, reportedMarkers };

const isDirectRun = process.argv[1]?.endsWith("check-merge-gate.mjs");
if (isDirectRun) process.exitCode = await main();
