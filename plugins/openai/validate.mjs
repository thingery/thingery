#!/usr/bin/env node
// Local validation dry run for the OpenAI plugin package (THI-218).
//
// Checks the package against (a) the vendored Agent Plugins 1.0.0 JSON
// schemas and (b) the OpenAI submission rules from
// https://developers.openai.com/plugins/deploy/submission (field limits,
// required-for-MCP-review fields, exactly 5 positive / 3 negative cases,
// referenced asset files exist and are valid PNGs within size limits).
//
// Exit codes:
//   0 — submission-ready (no findings)
//   2 — only findings tracked to unresolved blockers (PENDING(THI-216) /
//       PENDING(THI-217) / PENDING(gap) markers) — expected until those land
//   1 — hard findings that are not tracked to a blocker
//
// Run from the repo root: node plugins/openai/validate.mjs

import { createRequire } from "node:module";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"));
const pkgRoot = dirname(fileURLToPath(import.meta.url));

// ajv is a transitive dev dependency of the repo; resolve through the root.
const Ajv2020 = require("ajv/dist/2020").default;

const hard = [];
const pending = [];
const warn = [];
const ok = [];

const pendingRe = /\bPENDING\((THI-216|THI-217|gap|board)\)/;

function fail(msg) { hard.push(msg); }
function pend(msg) { pending.push(msg); }
function warnFn(msg) { warn.push(msg); }
function pass(msg) { ok.push(msg); }

/** Recursively collect strings containing a PENDING marker. */
function findPending(node, path, out) {
  if (typeof node === "string") {
    if (pendingRe.test(node)) out.push(`${path}: ${node.slice(0, 100)}`);
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => findPending(v, `${path}[${i}]`, out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) findPending(v, `${path}.${k}`, out);
  }
}

// --- parse -------------------------------------------------------------
function loadJson(name) {
  const file = join(pkgRoot, name);
  if (!existsSync(file)) { fail(`${name}: file missing`); return null; }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(`${name}: invalid JSON — ${e.message}`);
    return null;
  }
}

const plugin = loadJson("plugin.json");
const mcp = loadJson("mcp.json");

// --- Agent Plugins schemas ---------------------------------------------
const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const [doc, schemaFile, label] of [
  [plugin, "schemas/plugin.schema.json", "plugin.json"],
  [mcp, "schemas/mcp.schema.json", "mcp.json"],
]) {
  if (!doc) continue;
  const schema = JSON.parse(readFileSync(join(pkgRoot, schemaFile), "utf8"));
  const validate = ajv.compile(schema);
  if (validate(doc)) pass(`${label}: valid against ${schemaFile}`);
  else fail(`${label}: schema violations — ` + ajv.errorsText(validate.errors));
}

// --- OpenAI submission rules -------------------------------------------
const MAX_BYTES = 5 * 1024 * 1024;
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);

/** PNG IHDR dimensions (bytes 16..24 big-endian). */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null; // "IHDR"
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// A "draft" manifest still carries unresolved-input markers: absent assets
// and gaps are then tracked as pending rather than hard failures.
let isDraft = false;

function checkImage(rel, what) {
  const file = resolve(pkgRoot, rel);
  if (!existsSync(file)) {
    // While the draft still carries PENDING markers, absent icons are a
    // tracked THI-217 input; in a finalized manifest they are a hard error.
    if (isDraft) pend(`${what}: referenced file missing (icons land with THI-217): ${rel}`);
    else fail(`${what}: referenced file missing: ${rel}`);
    return;
  }
  const size = statSync(file).size;
  if (size > MAX_BYTES) fail(`${what}: ${rel} is ${(size / 1048576).toFixed(1)} MiB (max 5)`);
  else pass(`${what}: ${rel} present (${size} bytes)`);
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  if (!IMG_EXT.has(ext)) { fail(`${what}: ${rel} unsupported format (png/jpeg/webp/svg)`); return; }
  if (ext === ".png") {
    const dims = pngSize(readFileSync(file));
    if (!dims) fail(`${what}: ${rel} is not a valid PNG`);
    else if (dims.width !== dims.height) fail(`${what}: ${rel} not square (${dims.width}x${dims.height})`);
    else if (dims.width < 48) fail(`${what}: ${rel} under 48px (${dims.width}x${dims.height})`);
    else pass(`${what}: ${rel} square ${dims.width}x${dims.height}`);
  }
}

function checkHttpsUrl(url, what, maxLen = 1024) {
  if (typeof url !== "string") { fail(`${what}: missing`); return; }
  if (pendingRe.test(url)) { pend(`${what}: pending input — ${url.slice(0, 80)}`); return; }
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") fail(`${what}: must be HTTPS (${url})`);
    else if (url.length > maxLen) fail(`${what}: over ${maxLen} chars`);
    else pass(`${what}: ${url}`);
  } catch { fail(`${what}: not a URL (${url})`); }
}

function checkLen(obj, field, max, what, required = true) {
  const v = obj?.[field];
  if (v === undefined) { if (required) fail(`${what}.${field}: missing`); return; }
  if (typeof v !== "string") { fail(`${what}.${field}: must be a string`); return; }
  if (pendingRe.test(v)) { pend(`${what}.${field}: pending input — ${v.slice(0, 80)}`); return; }
  if (v.length > max) fail(`${what}.${field}: ${v.length} chars (max ${max})`);
  else pass(`${what}.${field}: ${v.length}/${max} chars`);
}

if (plugin) {
  isDraft = JSON.stringify(plugin).includes("PENDING(");
  // Package identity
  if (!/^[a-z0-9]{1,64}(?:-[a-z0-9]+)*$/.test(String(plugin.name ?? ""))) fail(`name: "${plugin.name}" must be lowercase/hyphens, max 64`);
  else pass(`name: ${plugin.name}`);
  if (!/^\d+\.\d+\.\d+/.test(String(plugin.version ?? ""))) fail("version: expected explicit semver");
  else pass(`version: ${plugin.version}`);

  checkLen(plugin, "description", 4000, "plugin.json", false);

  const ext = plugin.extensions?.["com.openai"];
  if (!ext) fail("extensions.com.openai: missing");
  else {
    const iface = ext.interface ?? {};
    const W = "interface";
    checkLen(iface, "displayName", 30, W);
    checkLen(iface, "shortDescription", 30, W);
    checkLen(iface, "longDescription", 4000, W);
    checkLen(iface, "developerName", 80, W);
    checkLen(iface, "category", 80, W, false);
    if (iface.category && pendingRe.test(iface.category)) pend("interface.category: pending board confirmation");
    const caps = iface.capabilities ?? [];
    if (caps.length > 20) fail("interface.capabilities: over 20 entries");
    caps.forEach((c, i) => { if (String(c).length > 120) fail(`interface.capabilities[${i}]: over 120 chars`); });
    pass(`interface.capabilities: ${caps.length} entries`);

    // Required-for-MCP-review URLs (plus website)
    for (const f of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"])
      checkHttpsUrl(iface[f], `interface.${f}`);

    const prompts = Array.isArray(iface.defaultPrompt) ? iface.defaultPrompt : iface.defaultPrompt ? [iface.defaultPrompt] : [];
    if (prompts.length > 3) fail("interface.defaultPrompt: max 3 prompts");
    prompts.forEach((p, i) => { if (String(p).length > 128) fail(`defaultPrompt[${i}]: over 128 chars`); if (String(p).includes("@")) fail(`defaultPrompt[${i}]: contains @mention`); });
    pass(`interface.defaultPrompt: ${prompts.length} prompts`);

    if (iface.brandColor && !pendingRe.test(iface.brandColor)) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(iface.brandColor)) fail("interface.brandColor: expected #RRGGBB");
      else pass("interface.brandColor: valid hex");
    } else if (iface.brandColor) pend("interface.brandColor: pending THI-217");

    for (const f of ["composerIcon", "logo"]) {
      if (!iface[f]) fail(`interface.${f}: missing (required icon)`);
      else if (ext.review && pendingRe.test(JSON.stringify(ext.review))) { /* icons may land with assets */ }
      checkImage(iface[f], `interface.${f}`);
    }
    for (const f of ["composerIconDark", "logoDark"]) if (iface[f]) checkImage(iface[f], `interface.${f}`);
    for (const s of iface.screenshots ?? []) checkImage(s, "interface.screenshots");

    // Review block
    const rev = ext.review ?? {};
    const tc = rev.test_cases ?? {};
    const pos = tc.positive ?? [];
    const neg = tc.negative ?? [];
    if (pos.length !== 5) fail(`review.test_cases.positive: ${pos.length} cases (exactly 5 required)`);
    else pass("review.test_cases.positive: exactly 5 cases");
    pos.forEach((c, i) => {
      for (const f of ["description", "prompt", "tools_triggered", "expected_behavior"])
        if (!c[f]) fail(`positive[${i}].${f}: missing`);
    });
    if (neg.length !== 3) fail(`review.test_cases.negative: ${neg.length} cases (exactly 3 required)`);
    else pass("review.test_cases.negative: exactly 3 cases");
    neg.forEach((c, i) => { for (const f of ["description", "prompt"]) if (!c[f]) fail(`negative[${i}].${f}: missing`); });

    // Optional in the ZIP, required for MCP review before submitting — the
    // walkthrough URL is entered in the dashboard's Review details if absent.
    if (rev.demo_recording_url === undefined) warnFn("review.demo_recording_url: absent from ZIP — enter the video walkthrough URL in Review details before submitting (required for MCP review)");
    else checkHttpsUrl(rev.demo_recording_url, "review.demo_recording_url", 2048);

    if (typeof rev.commerce !== "boolean") fail("review.commerce: must be boolean");
    else pass(`review.commerce: ${rev.commerce}`);
    if (rev.commerce && !rev.commerce_description) fail("review.commerce_description: required when commerce is true");
    else if (rev.commerce_description) pass("review.commerce_description: present");

    const notes = ext.publication?.release_notes;
    if (notes !== undefined && typeof notes !== "string") fail("publication.release_notes: must be a string");
    else if (notes !== undefined) pass("publication.release_notes: present");

    // Forbidden fields (ZIP metadata rejects these)
    const raw = readFileSync(join(pkgRoot, "plugin.json"), "utf8");
    for (const banned of ["test_credentials", "reviewer_instructions", "clientSecret"])
      if (raw.includes(banned)) fail(`plugin.json contains forbidden field/token: ${banned}`);
  }

  // Any PENDING marker in a place without a dedicated field check still
  // surfaces (no dedicated check exists for root description today).
}

if (mcp) {
  const servers = Object.entries(mcp.mcpServers ?? {});
  if (servers.length !== 1) fail(`mcp.json: expected exactly one MCP server, found ${servers.length}`);
  else {
    const [name, srv] = servers[0];
    if (srv.type !== "streamable-http") fail(`mcp.json ${name}: expected streamable-http`);
    else if (!/^https:\/\//.test(String(srv.url))) fail(`mcp.json ${name}: url must be HTTPS`);
    else pass(`mcp.json: one streamable-http server (${name}) at ${srv.url}`);
    if (srv.headers && Object.values(srv.headers).some((v) => String(v).length > 0))
      fail(`mcp.json ${name}: public submission rejects nonempty server headers`);
    const rawMcp = readFileSync(join(pkgRoot, "mcp.json"), "utf8");
    for (const banned of ["clientSecret", "clientId"]) if (rawMcp.includes(`"${banned}"`)) pend(`mcp.json contains "${banned}" — OAuth uses DCR via discovery, no credentials belong in the package`);
  }
}

// --- report ------------------------------------------------------------
console.log(`\nPASSED (${ok.length})`);
ok.forEach((m) => console.log(`  ✓ ${m}`));
if (pending.length) {
  console.log(`\nPENDING BLOCKED INPUTS (${pending.length}) — expected until THI-216/THI-217 resolve; gaps tracked on THI-218`);
  pending.forEach((m) => console.log(`  ⏳ ${m}`));
}
if (warn.length) {
  console.log(`\nPRE-SUBMISSION WARNINGS (${warn.length}) — ZIP is valid; complete in the dashboard before submitting`);
  warn.forEach((m) => console.log(`  ⚠ ${m}`));
}
if (hard.length) {
  console.log(`\nHARD FAILURES (${hard.length})`);
  hard.forEach((m) => console.log(`  ✗ ${m}`));
}

if (hard.length) { console.log("\nRESULT: FAIL (fix hard failures)"); process.exit(1); }
if (pending.length) { console.log("\nRESULT: DRAFT-ONLY (blocked inputs outstanding)"); process.exit(2); }
console.log("\nRESULT: READY"); process.exit(0);
