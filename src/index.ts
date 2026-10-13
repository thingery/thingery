#!/usr/bin/env node
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { sellerFromApiKey } from "./auth.js";
import { mcpRoutes } from "./mcp-gate.js";
import { mountOauthRoutes } from "./oauth.js";
import { startOauthSweepTimer } from "./oauth-sweep.js";
import { RateLimiter } from "./rate-limit.js";
import { pool } from "./db.js";
import { mountApiRoutes } from "./routes.js";
import { stripeWebhookRouter } from "./webhooks-stripe.js";
import { carrierWebhookRouter } from "./webhooks-carrier.js";
import { logConfigBootReport } from "./config.js";
import { browsePage, itemPage } from "./web-pages.js";
import { uploadsDir } from "./images.js";
import { securityHeaders } from "./security-headers.js";
import { VERSION } from "./version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);

/**
 * Two ways to run Thingery:
 *   TRANSPORT=http   (default) — express server: /mcp (Streamable HTTP), website, healthz
 *   TRANSPORT=stdio  — local MCP server over stdin/stdout, for `npx thingery` and
 *                     MCP clients that spawn servers (Claude Desktop, etc.).
 *                     Seller auth in stdio mode comes from the THINGERY_API_KEY env var.
 */
async function runStdio(): Promise<void> {
  const apiKey = process.env.THINGERY_API_KEY;
  const seller = apiKey ? await sellerFromApiKey(apiKey).catch(() => null) : null;
  if (apiKey && !seller) {
    console.error("Warning: THINGERY_API_KEY set but not found in the database — write tools disabled.");
  }
  const server = buildServer({ seller });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Thingery MCP server running on stdio (${seller ? `seller: ${seller.display_name}` : "read-only"})`);
}

function runHttp(): void {
  // Authenticated sellers get a generous bucket; anonymous callers a smaller one.
  const authedLimiter = new RateLimiter(120, 60_000);
  const anonLimiter = new RateLimiter(30, 60_000);

  const app = express();

  // Baseline security headers on every response, before any route (upstream #9).
  app.disable("x-powered-by");
  app.use(securityHeaders);

  // F1 (spec THI-11 §4.1, hard prerequisite for every per-IP limit): Caddy is
  // the single trusted proxy hop. Without this, req.ip is always the Caddy
  // container address and all per-IP buckets collapse into global ones.
  // Side effects (intended): the anon /mcp and /api/signup buckets become
  // truly per-IP. Self-hosters exposing the app directly are unaffected —
  // req.ip stays the socket peer. Client-injected XFF entries are ignored
  // (only the trusted hop's appended entry counts); regression-tested.
  app.set("trust proxy", 1);

  // /mcp with the method-aware 401 gate (spec THI-11 §2.10): dual-token
  // auth (thg_ API key | thgo_ OAuth token), 401 challenge for anonymous
  // protected-tool calls and present-but-invalid credentials, one 8 MB body
  // cap, parsed body handed to the transport. Mounts before any
  // body-parsing middleware — the gate consumes the raw stream itself.
  app.use(mcpRoutes({ authedLimiter, anonLimiter }));

  // Stripe webhook (spec THI-3 §4.3): raw-body mount BEFORE the global JSON
  // parser — signatures are computed over raw bytes. Fail-closed 503 stub
  // until STRIPE_WEBHOOK_SECRET is set (F1); see config boot report.
  const cfg = logConfigBootReport();
  app.use(stripeWebhookRouter(cfg));

  // Carrier webhook (spec THI-3 §4.3/§5): same raw-body-before-JSON
  // constraint; fail-closed 503 stub until EASYPOST_WEBHOOK_SECRET is set.
  app.use(carrierWebhookRouter(cfg));

  // Browser API (accounts + chat). /mcp above consumes the raw body stream,
  // so the JSON parser starts here and never touches MCP traffic.
  app.use(express.json({ limit: "256kb" }));
  mountOauthRoutes(app); // OAuth discovery + DCR (spec THI-11 §4.1) — after the JSON parser, like /api
  // /api router + its app-level terminal JSON error middleware (spec THI-58
  // PR-1): mount position unchanged, right where the router sat before.
  mountApiRoutes(app);

  app.get("/healthz", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, service: "thingery", version: VERSION });
    } catch {
      res.status(503).json({ ok: false, db: "unreachable" });
    }
  });

  app.get("/item/:id", itemPage);
  app.get("/browse", browsePage);

  // Uploaded item images (files under UPLOADS_DIR, served at /img/...)
  app.use("/img", express.static(uploadsDir(), { maxAge: "30d", immutable: true }));

  // Static website + discovery files (llms.txt, robots.txt, .well-known/)
  const websiteDir = path.resolve(__dirname, "..", "website");
  app.use(express.static(websiteDir, { extensions: ["html"] }));

  app.listen(PORT, () => {
    // OAuth retention sweeps (spec THI-11 §4.5): boot run + hourly, unref'd.
    startOauthSweepTimer();
    console.log(`Thingery MCP server listening on http://localhost:${PORT}`);
    console.log(`  MCP endpoint:     http://localhost:${PORT}/mcp`);
    console.log(`  Health check:     http://localhost:${PORT}/healthz`);
    console.log(`  Embeddings:       ${process.env.EMBED_API_KEY ? "enabled" : "keyword-only mode"}`);
  });
}

if (process.env.TRANSPORT === "stdio") {
  await runStdio();
} else {
  runHttp();
}
