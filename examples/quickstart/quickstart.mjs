#!/usr/bin/env node
/**
 * Thingery MCP quickstart — one file, zero dependencies, Node 18+.
 *
 * What it does, against the hosted MCP server at https://thingery.dev/mcp
 * (point MCP_URL at your self-hosted instance to run the same flow there):
 *
 *   1. describe_category  — read the 'sneakers' schema (public, no key)
 *   2. search_items       — anonymous search for sneakers (public, no key)
 *   3. create_listing     — publish a demo listing (needs an API key)
 *   4. add_item_image     — attach a generated photo; the first photo
 *                           publishes the pending listing
 *   5. get_item           — read it back (public)
 *   6. fetch(item.url)    — confirm the public web page renders
 *   7. update_listing     — set status 'deleted' so the demo listing is
 *                           removed again (pass --keep to keep it)
 *
 * Usage:
 *   THINGERY_API_KEY=thg_YOUR_KEY node quickstart.mjs [--keep]
 *
 * Without a key the script runs steps 1–2 and then explains how to get one.
 * Never commit your API key; treat it like a password.
 */

import zlib from "node:zlib";

const MCP_URL = (process.env.MCP_URL ?? "https://thingery.dev/mcp").replace(/\/$/, "");
const API_KEY = process.env.THINGERY_API_KEY ?? "";
const KEEP = process.argv.includes("--keep");

// ---------------------------------------------------------------------------
// Minimal MCP plumbing: JSON-RPC 2.0 over the Streamable HTTP transport.
// Responses may arrive as application/json or as Server-Sent Events —
// the JSON-RPC result is on the `data:` line. The server is stateless
// (POST only), so every request stands alone; no initialize handshake.
// ---------------------------------------------------------------------------

let nextId = 1;

function parseResponse(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed); // plain JSON
  let parsed = null; // SSE: one JSON object per `data:` line
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data: ")) parsed = JSON.parse(line.slice(6));
  }
  if (!parsed) throw new Error(`Unparseable response: ${body.slice(0, 200)}`);
  return parsed;
}

async function rpc(method, params, { auth = false } = {}) {
  const headers = {
    "content-type": "application/json",
    // this Accept header is required by the MCP Streamable HTTP transport
    accept: "application/json, text/event-stream",
    ...(auth ? { authorization: `Bearer ${API_KEY}` } : {}),
  };
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${method}: ${body.slice(0, 300)}`);
  const message = parseResponse(body);
  if (message.error) throw new Error(`${method} failed: ${JSON.stringify(message.error)}`);
  return message.result;
}

/** Call one MCP tool; tool results are JSON on content[0].text. */
async function callTool(name, args, { auth = false } = {}) {
  const result = await rpc("tools/call", { name, arguments: args }, { auth });
  const data = JSON.parse(result.content[0].text);
  if (data.error) throw new Error(`${name} returned an error: ${data.error}`);
  return data;
}

// ---------------------------------------------------------------------------
// A generated placeholder photo. add_item_image wants image bytes as base64;
// we encode a tiny solid-colour PNG in-process so the example needs no assets.
// ---------------------------------------------------------------------------

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function placeholderPng(w = 64, h = 64, [r, g, b] = [226, 232, 240]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]); // filter 0 + RGB
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array(h).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

const say = (s) => console.log(s);

async function main() {
  say(`Thingery MCP quickstart — server: ${MCP_URL}\n`);

  // 1. Schema discovery (public)
  const { category, note } = await callTool("describe_category", { category: "sneakers" });
  say(`1. describe_category('sneakers') → declared attribute keys: ` +
      category.attribute_definitions.map((d) => d.key).join(", "));
  say(`   (${note.split(".")[0]}.)\n`);

  // 2. Anonymous search (public)
  const { count, results } = await callTool("search_items", { q: "sneakers", limit: 3 });
  say(`2. search_items(q='sneakers') → ${count} result(s)`);
  for (const r of results) say(`   - ${r.title} — ${r.price.amount} ${r.price.currency} (${r.id})`);
  say("");

  // Steps 3+ need a seller credential
  if (!API_KEY) {
    say("No THINGERY_API_KEY set — stopping after the public steps above.");
    say("To publish a listing:");
    say("  1. Create a free account at https://thingery.dev/login.html (email + password).");
    say("  2. Copy the API key shown once after signup (or rotate one later in Account).");
    say("  3. Run again: THINGERY_API_KEY=thg_YOUR_KEY node quickstart.mjs");
    return;
  }

  // 3. Create a listing (seller) — photoless creates stay pending by design
  const created = await callTool("create_listing", {
    title: "Thingery quickstart demo sneaker (EU 42)",
    description: "Demo listing created by examples/quickstart in the thingery repo — deleted again by the same run.",
    category: "sneakers",
    condition: "good",
    price_cents: 5000,
    currency: "EUR",
    attributes: { size_eu: 42, colorway: "white/vast grey" },
  }, { auth: true });
  const item = created.item;
  say(`3. create_listing → ${item.id}`);
  say(`   visible: ${created.visible} (photo_required: ${created.photo_required}) — ` +
      `listings are hidden until the first photo is added`);
  say(`   item page: ${item.url}\n`);

  // 4. Attach a photo — the first photo publishes a pending listing
  const image = placeholderPng();
  const added = await callTool("add_item_image", {
    item_id: item.id,
    image_base64: image.toString("base64"),
    media_type: "image/png",
  }, { auth: true });
  say(`4. add_item_image → image at ${added.image_url}`);
  say(`   visible now: ${added.visible} — the listing is live in search\n`);

  // 5. Read it back anonymously
  const got = await callTool("get_item", { id: item.id });
  say(`5. get_item → needs_photo: ${got.item.needs_photo}, url: ${got.item.url}\n`);

  // 6. The public web page (plain HTTP, no MCP involved)
  const page = await fetch(got.item.url);
  say(`6. fetch(${got.item.url}) → HTTP ${page.status} ${page.ok ? "(public page renders)" : "(unexpected)"}\n`);

  // 7. Clean up the demo listing unless asked to keep it
  if (KEEP) {
    say(`7. kept the listing (--keep) — find it at ${got.item.url}`);
  } else {
    const updated = await callTool("update_listing", { id: item.id, status: "deleted" }, { auth: true });
    say(`7. update_listing(status='deleted') → listing status: ${updated.item.status} (removed from search)`);
  }
  say("\nDone. Full workflow reference: docs/integrations.md · framework examples: examples/integrations/");
}

main().catch((e) => {
  console.error(`Failed: ${e.message}`);
  console.error("Troubleshooting: docs/integrations.md#troubleshooting");
  process.exit(1);
});
