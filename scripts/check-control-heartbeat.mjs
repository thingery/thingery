#!/usr/bin/env node
/**
 * Dead-man's switch for the scheduled merge-gate integrity control (ADR 0007).
 *
 * The gate-integrity workflow is itself a control, and it can die silently:
 * an invalid workflow file (bad YAML, unknown permission scope) fails as a
 * startup failure with zero jobs and emits no notification. That is exactly
 * how the detector sat dead on `main` unnoticed (THI-1065, Nov 2026). This
 * check lives in a separate workflow file on purpose — a parse defect in
 * gate-integrity.yml kills that file's own triggers, not this one — and
 * periodically takes the control's pulse:
 *
 *   1. Lists recent runs of the control workflow (gate-integrity.yml).
 *   2. Healthy = at least one *successful* run within MAX_AGE minutes
 *      (default 90 = three 30-minute schedule periods, robust to runner
 *      queue delay). Covers missed schedules, broken files, and failing runs
 *      with a single signal.
 *   3. If the pulse is missing, files an alert on the "Merge-gate integrity
 *      alerts" tracking issue, deduplicated to at most one alert per UTC day
 *      per condition via a fingerprint marker in the issue body/comments.
 *
 * The watchdog cannot detect its own death. The remaining layers are the
 * actionlint CI job (lints workflow files on PRs and pushes to main) and the
 * periodic repo health sweep. Uses only the workflow's built-in GITHUB_TOKEN
 * — no secrets, no PATs.
 *
 * Usage:
 *   node scripts/check-control-heartbeat.mjs [--dry-run] [--max-age-min N]
 *       [--fail-on-findings] [--verbose]
 *
 * Exit codes: 0 healthy, 1 pulse missing with --fail-on-findings,
 * 2 operational error (bad args, API failure).
 */

import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const REPO = process.env.GITHUB_REPOSITORY ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const WORKFLOW_FILE = process.env.CONTROL_WORKFLOW ?? "gate-integrity.yml";
const TRACKING_TITLE = "Merge-gate integrity alerts";
const DEFAULT_MAX_AGE_MIN = 90; // 3 schedule periods of the control (30 min)
const MAX_PAGES = 5; // per_page=100 → 500 runs of history is plenty
const BOT_LOGINS = new Set(["github-actions[bot]"]);
const RUNS_SHOWN = 5; // context rows in the report/alert

// ---------------------------------------------------------------- CLI args

function parseArgs(argv) {
  const args = { dryRun: false, maxAgeMin: DEFAULT_MAX_AGE_MIN, failOnFindings: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--max-age-min") args.maxAgeMin = requirePositiveInt(argv[++i], a);
    else if (a === "--fail-on-findings") args.failOnFindings = true;
    else if (a === "--verbose") args.verbose = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1") args.dryRun = true;
  if (process.env.HEARTBEAT_MAX_AGE_MIN) args.maxAgeMin = requirePositiveInt(process.env.HEARTBEAT_MAX_AGE_MIN, "HEARTBEAT_MAX_AGE_MIN");
  return args;
}

function requirePositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} needs a positive integer, got: ${value}`);
  return n;
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
    // list: treating it as empty would fabricate "healthy" instead of
    // failing the run.
    if (!Array.isArray(items)) throw new Error(`GET ${path} -> malformed page body (expected an array)`);
    if (!items.length) return out;
    out.push(...items);
    if (items.length < 100) return out;
  }
  console.error(
    `control-heartbeat: warning: GET ${path} truncated at MAX_PAGES=${MAX_PAGES} (${out.length} items) — results may be incomplete`,
  );
  return out;
}

// ---------------------------------------------------------------- pulse

async function readPulse() {
  const runs = await paged(`/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs`, (j) => j.workflow_runs);
  const completed = runs.filter((r) => r.status === "completed");
  const success = completed.filter((r) => r.conclusion === "success");
  const lastSuccess = success[0] ?? null; // API returns most recent first
  const lastSuccessAgeMin = lastSuccess ? (Date.now() - Date.parse(lastSuccess.created_at)) / 60000 : null;
  return { runs, completed, lastSuccess, lastSuccessAgeMin };
}

function pulseVerdict(pulse, maxAgeMin) {
  if (!pulse.lastSuccess) return { healthy: false, reason: `no successful run of ${WORKFLOW_FILE} in the last ${pulse.completed.length} completed runs` };
  if (pulse.lastSuccessAgeMin > maxAgeMin) {
    return { healthy: false, reason: `last successful run was ${Math.round(pulse.lastSuccessAgeMin)} min ago (threshold ${maxAgeMin} min)` };
  }
  return { healthy: true, reason: `last successful run ${Math.round(pulse.lastSuccessAgeMin)} min ago` };
}

function runRow(r) {
  return `| ${r.id} | ${r.event} | ${r.conclusion} | ${r.created_at} | \`${String(r.head_sha ?? "").slice(0, 8)}\` |`;
}

// ---------------------------------------------------------------- reporting

function printReport(pulse, verdict, args) {
  const lines = [];
  lines.push(`control-heartbeat: control workflow ${WORKFLOW_FILE}`);
  lines.push(`control-heartbeat: completed runs scanned: ${pulse.completed.length}`);
  lines.push(
    pulse.lastSuccess
      ? `control-heartbeat: last success ${pulse.lastSuccess.created_at} (${pulse.lastSuccess.id})`
      : "control-heartbeat: no successful run found",
  );
  lines.push(
    verdict.healthy
      ? `control-heartbeat: healthy — ${verdict.reason}`
      : `control-heartbeat: PULSE MISSING — ${verdict.reason}`,
  );
  if (args.verbose) {
    lines.push("  recent completed runs:");
    for (const r of pulse.completed.slice(0, RUNS_SHOWN)) lines.push(`  ${runRow(r)}`);
  }
  const summary = lines.join("\n");
  console.log(summary);
  const ghSummary = process.env.GITHUB_STEP_SUMMARY;
  if (ghSummary) {
    try {
      appendFileSync(ghSummary, `## Control heartbeat (${WORKFLOW_FILE})\n\n\`\`\`\n${summary}\n\`\`\`\n`);
    } catch {
      /* summary file is best-effort */
    }
  }
}

const fingerprint = (utcDay) =>
  createHash("sha256")
    .update(`control-heartbeat:no-success:${WORKFLOW_FILE}:${utcDay}`)
    .digest("hex")
    .slice(0, 16);

function alertBody(pulse, verdict, fp, maxAgeMin) {
  const runLink =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const out = [];
  out.push("## Control heartbeat alert");
  out.push("");
  out.push(`- **Run:** ${new Date().toISOString()}${runLink ? ` ([workflow run](${runLink}))` : ""}`);
  out.push(`- **Control workflow:** \`.github/workflows/${WORKFLOW_FILE}\` (ADR 0007 detection control)`);
  out.push(`- **Verdict:** **PULSE MISSING** — ${verdict.reason}`);
  out.push(`- **Threshold:** one successful run within ${maxAgeMin} min (three schedule periods)`);
  if (pulse.completed.length) {
    out.push("");
    out.push("### Recent completed runs");
    out.push("");
    out.push("| Run | Event | Conclusion | Created (UTC) | Head |");
    out.push("|---|---|---|---|---|");
    for (const r of pulse.completed.slice(0, RUNS_SHOWN)) out.push(runRow(r));
    out.push("");
    out.push(
      "A `failure` with zero executed jobs is the startup-failure signature: the workflow file itself" +
        " is invalid (bad YAML or an unknown permission scope) and GitHub emits no notification for it." +
        " Fix the workflow file (actionlint catches this class before merge), re-run, and confirm a" +
        " successful scheduled run appears within 30 minutes.",
    );
  } else {
    out.push("");
    out.push(
      "No completed runs exist for the control workflow at all — it has never executed. Check that" +
        " the workflow file is valid and the schedule/push triggers can fire.",
    );
  }
  out.push("");
  out.push(`<!-- control-heartbeat fingerprint=${fp} -->`);
  return out.join("\n");
}

async function findTrackingIssue() {
  const issues = await paged(`/repos/${REPO}/issues?state=open`, (j) => j);
  const candidates = issues.filter(
    (i) => !i.pull_request && i.title === TRACKING_TITLE && (i.user?.type === "Bot" || BOT_LOGINS.has(i.user?.login)),
  );
  return candidates.sort((a, b) => b.number - a.number)[0] ?? null;
}

/** Fingerprint markers already reported on the tracking issue — comments AND
 * the issue body itself: the create path writes the first alert into the
 * body, so a comment-only scan would re-report it once as a duplicate
 * comment on the next run. */
async function reportedFingerprints(issue) {
  const comments = await paged(`/repos/${REPO}/issues/${issue.number}/comments`, (j) => j);
  const fingerprints = new Set();
  for (const text of [issue.body ?? "", ...comments.map((c) => c.body ?? "")]) {
    for (const m of text.matchAll(/control-heartbeat fingerprint=([0-9a-f]+)/g)) fingerprints.add(m[1]);
  }
  return fingerprints;
}

async function deliver(pulse, verdict, maxAgeMin, dryRun) {
  if (dryRun) {
    console.log("control-heartbeat: dry run — no issue writes");
    return { reported: false };
  }
  const utcDay = new Date().toISOString().slice(0, 10);
  const fp = fingerprint(utcDay);
  const issue = await findTrackingIssue();
  const seen = issue ? await reportedFingerprints(issue) : new Set();
  if (seen.has(fp)) {
    console.log(issue ? `control-heartbeat: today's pulse alert already reported on #${issue.number} — nothing to do` : "control-heartbeat: nothing to report");
    return { reported: false };
  }
  const body = alertBody(pulse, verdict, fp, maxAgeMin);
  if (!issue) {
    const res = await fetch(`${API}/repos/${REPO}/issues`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ title: TRACKING_TITLE, body }),
    });
    if (!res.ok) throw new Error(`issue create -> HTTP ${res.status}`);
    const created = await res.json();
    console.log(`control-heartbeat: opened tracking issue #${created.number}`);
    return { reported: true, issue: created.number };
  }
  const res = await fetch(`${API}/repos/${REPO}/issues/${issue.number}/comments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`issue comment -> HTTP ${res.status}`);
  console.log(`control-heartbeat: appended alert to tracking issue #${issue.number}`);
  return { reported: true, issue: issue.number };
}

// ---------------------------------------------------------------- main

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`control-heartbeat: ${err.message}`);
    return 2;
  }
  if (!REPO || !TOKEN) {
    console.error("control-heartbeat: GITHUB_REPOSITORY and GITHUB_TOKEN are required");
    return 2;
  }
  try {
    const pulse = await readPulse(args.maxAgeMin);
    const verdict = pulseVerdict(pulse, args.maxAgeMin);
    printReport(pulse, verdict, args);
    if (!verdict.healthy) {
      const { reported } = await deliver(pulse, verdict, args.maxAgeMin, args.dryRun);
      if (args.failOnFindings && reported) return 1;
    }
    return 0;
  } catch (err) {
    console.error(`control-heartbeat: operational error: ${err.message}`);
    return 2;
  }
}

// ---------------------------------------------------------------- exports
// Named exports keep the helpers unit-testable; nothing here is imported by app code.
export { parseArgs, readPulse, pulseVerdict, fingerprint, alertBody, findTrackingIssue, reportedFingerprints };

const isDirectRun = process.argv[1]?.endsWith("check-control-heartbeat.mjs");
if (isDirectRun) process.exitCode = await main();
