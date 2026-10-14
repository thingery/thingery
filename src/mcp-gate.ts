// The /mcp route with the method-aware 401 gate (spec THI-11 §2.10).
//
// Extracted from index.ts so the gate is mounted identically in production
// and in the HTTP integration tests. Auth policy lives ONLY here: public
// reads stay anonymous (Thingery principle), but an OAuth-capable host only
// starts the browser flow when the server answers 401 — so anonymous calls
// to PROTECTED_TOOLS (and present-but-invalid credentials) get a proper
// RFC 6750 + RFC 9728 Bearer challenge instead of a silent downgrade or a
// confusing tool-level error.

import express, { type Request, type Response, type Router } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateRequest } from "./auth.js";
import { buildServer } from "./server.js";
import { issuerFromRequest } from "./oauth.js";
import { logSecurityEvent } from "./security-events.js";
import { PROTECTED_TOOLS } from "./tools.js";
import type { RateLimiter } from "./rate-limit.js";

/** Single body cap for every /mcp request (spec §2.10c, F4): the tool being
 * called is unknowable before parsing, and a ~6.7 MB base64 body for a 5 MB
 * image is the largest legitimate request. */
export const MCP_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Anonymous cutoff (F4 DoS tightening): no legitimate anonymous request is
 * ever this large (large bodies are protected-tool calls, which 401 anyway),
 * so anonymous callers never make us pay the parse cost on a big payload. */
export const MCP_ANON_MAX_BYTES = 256 * 1024;

function bearerChallenge(issuer: string, invalidToken: boolean): string {
  const meta = `resource_metadata="${issuer}/.well-known/oauth-protected-resource"`;
  return invalidToken ? `Bearer error="invalid_token", ${meta}` : `Bearer ${meta}`;
}

function unauthorized(res: Response, issuer: string, invalidToken: boolean): void {
  res
    .status(401)
    .set("WWW-Authenticate", bearerChallenge(issuer, invalidToken))
    .json({ error: invalidToken ? "invalid_token" : "authentication required" });
}

/** Buffers the raw body up to `cap` bytes; responds 413 and returns null above it. */
async function readBodyWithCap(req: Request, res: Response, cap: number): Promise<Buffer | null> {
  const tooLarge = (): null => {
    res.status(413).json({ error: "payload too large", limit_bytes: cap });
    return null;
  };
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > cap) return tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > cap) return tooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Whether a parsed JSON-RPC payload (single or batch) calls a protected tool. */
export function jsonRpcRequiresSeller(body: unknown): boolean {
  const one = (msg: unknown): boolean => {
    if (typeof msg !== "object" || msg === null) return false;
    const m = msg as { method?: unknown; params?: { name?: unknown } | null };
    return (
      m.method === "tools/call" &&
      typeof m.params === "object" &&
      m.params !== null &&
      typeof m.params.name === "string" &&
      PROTECTED_TOOLS.has(m.params.name)
    );
  };
  return Array.isArray(body) ? body.some(one) : one(body);
}

export interface McpLimiters {
  authedLimiter: RateLimiter;
  anonLimiter: RateLimiter;
}

/** Mounts POST/GET/DELETE /mcp. Must run before any body-parsing middleware. */
export function mcpRoutes(limiters: McpLimiters): Router {
  const router = express.Router();

  router.post("/mcp", async (req, res) => {
    // Fail securely (THI-27 review): every await in this handler can reject —
    // authenticateRequest on a DB outage, the raw-request async iteration on a
    // client abort mid-upload. Express 4 does NOT forward async rejections to
    // an error handler, and Node >= 15 crashes the process on unhandled
    // rejections — one aborted socket or one Postgres blip would otherwise
    // take down the whole service. Unexpected failures degrade to 503
    // (retry-later), never a silent anonymous downgrade and never a crash.
    try {
      const auth = await authenticateRequest(req);

      // Rate limits first (§2.12): same buckets as today; the limiter key is the
      // resolved seller, so OAuth-authed requests land in the authed bucket.
      const limiter = auth.seller ? limiters.authedLimiter : limiters.anonLimiter;
      const limitKey = auth.seller ? `key:${auth.seller.id}` : `ip:${req.ip ?? "unknown"}`;
      if (!limiter.allow(limitKey)) {
        // THI-112 (H4.2): 429s on the MCP surface are security events — a
        // flood here is the primary abuse signal this deployment has.
        logSecurityEvent({ type: "rate_limit", route: "/mcp" }, { sellerId: auth.seller?.id, ip: req.ip ?? "unknown" });
        res.status(429).json({ error: "rate limited", retry_after_ms: 60_000 });
        return;
      }

      // §2.10b: a presented-but-invalid credential (unknown thg_ key,
      // expired/revoked/unknown thgo_ token, unrecognized format) fails 401 with
      // a challenge — never a silent downgrade to anonymous. A host whose token
      // expired must be TOLD so it can refresh.
      if (auth.failure === "invalid_token") {
        unauthorized(res, issuerFromRequest(req), true);
        return;
      }

      // §2.10c + F4: one 8 MB cap, buffer once, parse once, then hand the
      // parsed body to the transport (handleRequest's documented pre-parsed
      // body parameter — no stream replay, no double-consume).
      const raw = await readBodyWithCap(req, res, MCP_MAX_BODY_BYTES);
      if (raw === null) return;

      // Anonymous + large (F4): no legitimate anonymous request is ever this
      // large (large bodies are protected-tool calls, which 401 anyway) —
      // reject BEFORE paying the 8 MB JSON.parse cost, and un-parsed.
      if (!auth.seller && raw.length > MCP_ANON_MAX_BYTES) {
        unauthorized(res, issuerFromRequest(req), false);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        // Unparseable → the same parse error the transport itself would return.
        res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }

      if (!auth.seller && jsonRpcRequiresSeller(parsed)) {
        // No credentials presented → plain challenge (no error code) so the
        // host starts OAuth discovery / the browser onboarding flow.
        unauthorized(res, issuerFromRequest(req), false);
        return;
      }

      try {
        const server = buildServer({ seller: auth.seller });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch (e) {
        if (!res.headersSent) {
          res.status(500).json({ error: `MCP handling failed: ${(e as Error).message}` });
        } else {
          res.destroy();
        }
      }
    } catch (e) {
      if (!res.headersSent) {
        res.status(503).json({ error: "temporarily unavailable" });
      } else {
        // Response already started (e.g. SSE stream) and the request died —
        // nothing safe to append; drop the connection.
        res.destroy();
      }
      if (!(e instanceof Error && (e.message === "aborted" || (e as Error & { code?: string }).code === "ECONNRESET"))) {
        console.error("mcp-gate: request failed:", e);
      }
    }
  });

  // Stateless HTTP transport: only POST is supported.
  router.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed. Use POST with JSON-RPC. Stateles HTTP transport." });
  });
  router.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed. Stateless HTTP transport." });
  });

  return router;
}
