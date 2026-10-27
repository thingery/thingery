#!/usr/bin/env node
// THI-393 search relevance suite runner.
//
// Runs scripts/search-relevance/suite.json against a Thingery MCP endpoint
// (default: prod https://thingery.dev/mcp) and prints a graded relevance
// report. Pure Node >= 20, no dependencies. Exit code is always 0 — this is
// a measurement tool, not a CI gate.
//
// Usage:
//   node scripts/search-relevance/run.mjs [--mcp-url URL] [--json out.json]
//
// Scoring model (see README.md for rationale):
//   - Judged queries: per-query score = nDCG@5, gains 2^grade-1 (7/3/1).
//   - No-inventory queries (expected: []): score 1 iff zero results, else 0.
//   - Baseline relevance score = mean per-query score * 100.
//   - hit@k / MRR count grade >= 2 results only.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const suite = JSON.parse(readFileSync(join(here, "suite.json"), "utf8"));

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const MCP_URL = flag("--mcp-url") ?? process.env.THINGERY_MCP_URL ?? "https://thingery.dev/mcp";
const JSON_OUT = flag("--json");
const DELAY_MS = 350; // anon MCP bucket is 30 req/min per IP — stay well under

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Minimal MCP Streamable-HTTP client (SSE-framed JSON-RPC responses) ---
async function rpc(id, method, params, session) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") ?? 5) * 1000;
    await sleep(wait);
    return rpc(id, method, params, session);
  }
  const sid = res.headers.get("mcp-session-id");
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`unexpected MCP response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  return { msg: JSON.parse(line.slice(6)), session: sid ?? session };
}

async function callSearch(args) {
  const init = await rpc(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thi393-relevance-suite", version: "1.0" },
  });
  if (init.msg.error) throw new Error(`initialize failed: ${JSON.stringify(init.msg.error)}`);
  const session = init.session;
  await rpc(2, "notifications/initialized", {}, session);
  const out = await rpc(3, "tools/call", { name: "search_items", arguments: args }, session);
  if (out.msg.error) throw new Error(`tools/call failed: ${JSON.stringify(out.msg.error)}`);
  const text = out.msg.result?.content?.[0]?.text;
  if (!text) throw new Error(`no content in tool result: ${JSON.stringify(out.msg.result)}`);
  return JSON.parse(text);
}

// --- Grading ---
const gain = (grade) => 2 ** grade - 1; // 3->7, 2->3, 1->1
const dcgAt = (grades, k) =>
  grades.slice(0, k).reduce((s, g, i) => s + gain(g) / Math.log2(i + 2), 0);

function gradeQuery(query, results) {
  const byId = new Map(query.expected.map((e) => [e.id, e.grade]));
  const returnedIds = results.map((r) => r.id);
  const grades = returnedIds.map((id) => byId.get(id) ?? 0); // unknown corpus item or graded-0 => 0
  const unjudged = returnedIds.filter((id) => !suite.corpus[id]).length;

  if (query.expected.length === 0) {
    // No-inventory probe: correct answer is zero results.
    return {
      id: query.id,
      group: query.group,
      type: query.type,
      noInventory: true,
      returned: returnedIds.length,
      score: returnedIds.length === 0 ? 1 : 0,
      hit1: null, hit3: null, hit5: null, rr: null, ndcg: null,
      noise: returnedIds.length,
      unjudged,
      returnedIds,
    };
  }

  const ideal = query.expected.map((e) => e.grade).sort((a, b) => b - a);
  const ndcg = dcgAt(grades, 5) / dcgAt(ideal, 5);
  const firstRelevant = returnedIds.findIndex((id) => (byId.get(id) ?? 0) >= 2);
  const inTop = (k) => grades.slice(0, k).some((g) => g >= 2);
  const noise = returnedIds.filter((id) => (byId.get(id) ?? 0) === 0 && suite.corpus[id]).length;

  return {
    id: query.id,
    group: query.group,
    type: query.type,
    noInventory: false,
    returned: returnedIds.length,
    score: Number.isFinite(ndcg) ? ndcg : 0,
    hit1: inTop(1), hit3: inTop(3), hit5: inTop(5),
    rr: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
    ndcg,
    noise,
    unjudged,
    returnedIds,
  };
}

// --- Run ---
const runs = [];
let semanticScores = 0;
for (const query of suite.queries) {
  const payload = await callSearch(query.args);
  const results = payload.results ?? [];
  if (results.some((r) => typeof r.score === "number" && r.score > 0.15)) semanticScores++;
  runs.push({ query, payload, graded: gradeQuery(query, results) });
  await sleep(DELAY_MS);
}

const judged = runs.filter((r) => !r.graded.noInventory);
const probes = runs.filter((r) => r.graded.noInventory);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (xs) => (xs.length ? (xs.filter(Boolean).length / xs.length) * 100 : null);

const summary = {
  mcpUrl: MCP_URL,
  snapshotDate: suite.snapshot_date,
  ranAt: new Date().toISOString(),
  queries: runs.length,
  searchMode: semanticScores > 0 ? "semantic (cosine scores observed)" : "keyword fallback (all scores 0)",
  baselineRelevanceScore: Math.round(mean(runs.map((r) => r.graded.score)) * 1000) / 10,
  judgedQueries: judged.length,
  hit1Pct: pct(judged.map((r) => r.graded.hit1)),
  hit3Pct: pct(judged.map((r) => r.graded.hit3)),
  hit5Pct: pct(judged.map((r) => r.graded.hit5)),
  mrr: Math.round(mean(judged.map((r) => r.graded.rr)) * 1000) / 1000,
  ndcg5Mean: Math.round(mean(judged.map((r) => r.graded.ndcg)) * 1000) / 1000,
  noInventoryProbes: probes.length,
  noInventoryCorrectPct: pct(probes.map((r) => r.graded.score === 1)),
  noiseResultsTotal: runs.reduce((s, r) => s + r.graded.noise, 0),
  unjudgedResultsTotal: runs.reduce((s, r) => s + r.graded.unjudged, 0),
};

const detail = runs.map((r) => ({
  id: r.query.id,
  group: r.query.group,
  type: r.query.type,
  args: r.query.args,
  intent: r.query.intent,
  returned: r.graded.returned,
  score: Math.round(r.graded.score * 1000) / 1000,
  noise: r.graded.noise,
  returnedTitles: r.graded.returnedIds.map((id) => suite.corpus[id]?.title ?? `unjudged:${id.slice(0, 8)}`),
}));

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ summary, detail, runs: runs.map(({ graded }) => graded) }, null, 2));
}

// --- Markdown report ---
const short = (id) => id.slice(0, 8);
const fmt = (x) => (x === null || x === undefined ? "—" : x);
console.log(`# Search relevance report — ${suite.queries.length} buyer queries`);
console.log();
console.log(`- Endpoint: \`${MCP_URL}\``);
console.log(`- Ran: ${summary.ranAt} (suite snapshot ${suite.snapshot_date})`);
console.log(`- Search mode observed: **${summary.searchMode}**`);
console.log();
console.log(`## Baseline`);
console.log();
console.log(`- **Baseline relevance score: ${summary.baselineRelevanceScore}/100** (mean per-query score; judged = nDCG@5, no-inventory = 1 iff zero results)`);
console.log(`- Judged queries (${judged.length}): hit@1 ${fmt(summary.hit1Pct)}% · hit@3 ${fmt(summary.hit3Pct)}% · hit@5 ${fmt(summary.hit5Pct)}% · MRR ${fmt(summary.mrr)} · nDCG@5 ${fmt(summary.ndcg5Mean)}`);
console.log(`- No-inventory probes (${probes.length}): ${fmt(summary.noInventoryCorrectPct)}% correctly empty`);
console.log(`- Noise (known-irrelevant results served): ${summary.noiseResultsTotal}; unjudged (corpus drift): ${summary.unjudgedResultsTotal}`);
console.log();
console.log(`## Per-query`);
console.log();
console.log(`| id | type | query | returned | score | noise | top results |`);
console.log(`|----|------|-------|---------:|------:|-------------|`);
for (const r of runs) {
  const q = r.query.args.q ?? `(category=${r.query.args.category ?? "—"}${r.query.args.condition ? ", " + r.query.args.condition : ""})`;
  const top = r.graded.returnedIds.slice(0, 3).map(short).join(", ") || "∅";
  console.log(`| ${r.query.id} | ${r.query.type} | ${q.replace(/\|/g, "\\|")} | ${r.graded.returned} | ${Math.round(r.graded.score * 100) / 100} | ${r.graded.noise} | ${top} |`);
}
console.log();
if (JSON_OUT) console.log(`Full machine-readable results: ${JSON_OUT}`);
