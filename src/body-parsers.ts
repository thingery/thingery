// Browser-API body parsers (THI-1197, THI-1196 Security finding F1).
//
// Extracted from src/index.ts so the mount order is shared verbatim by the
// HTTP tests — one source of truth, same rationale as the mcp-gate.ts
// extraction. The 413-on-every-photo-draft bug shipped because the route
// tests built their own app with a smaller parser, so production mount
// drift was invisible to CI.
//
// POST /api/draft-listing carries a base64 photo: a 5 MB image ≈ 6.7 MB as
// base64+JSON, far above the global 256kb parser — which answered 413 before
// the route ever ran. The scoped large-body parser below mounts BEFORE the
// global one, mirroring the before-the-global-parser pattern the /mcp and
// webhook mounts already use. body-parser's `req._body` flag makes the later
// global parser skip already-parsed requests, so exactly one parser runs per
// request. 8 MiB is the /mcp cap (same envelope math) — not a new policy;
// the two move together by construction.
//
// THI-1360 (THI-1197 residual, OWASP API #4 — Unrestricted Resource
// Consumption): the scoped parser made this route the widest ANONYMOUS parse
// surface (8 MiB buffer + JSON.parse per request before auth — the /mcp
// pre-auth buckets do not mount here, and the per-seller limiter is
// post-auth). The anon gate below restores the /mcp MCP_ANON_MAX_BYTES
// posture: an anonymous request that declares more than 256kb never makes us
// pay the parse — 401 before the body is read, exactly like /mcp's
// anonymous-large rejection. Auth still precedes any parse rejection the
// envelope admits: the THI-1196 F1 contract (unauthenticated in-envelope
// >256kb draft POST → 401, never 413) holds — now answered at the gate
// instead of parse-then-route — and a session-authenticated request keeps
// the full 8 MiB envelope. The route's own zod caps (≤1 photo, ≤5 MB,
// jpeg/png/webp/gif) plus the per-seller limiter stay the real content bound.

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { sellerFromSession } from "./auth.js";
import { MCP_ANON_MAX_BYTES, MCP_MAX_BODY_BYTES } from "./mcp-gate.js";

/** Draft-listing photo envelopes parse under the same cap as /mcp. */
export const DRAFT_LISTING_BODY_LIMIT = MCP_MAX_BODY_BYTES;

/** Global browser-API JSON cap — the pre-THI-1197 256kb default, unchanged. */
export const GLOBAL_JSON_BODY_LIMIT = 256 * 1024;

/** THI-1360: pre-auth cost bound on POST /api/draft-listing.
 *
 * Anonymous callers declaring an in-envelope (>256 KiB, ≤8 MiB) body get 401
 * before the body is read — the /mcp MCP_ANON_MAX_BYTES pattern (no
 * legitimate anonymous draft is ever this large: photo drafts are the
 * authenticated web-UI flow, and an unauthenticated draft 401s at the route
 * anyway, so the response is identical, just ~8 MiB of parse cost cheaper).
 * Deliberate details:
 *
 * - Declared length ≤256 KiB → straight through: no extra work, no behavior
 *   change (the gate must not add a DB roundtrip to the common small case).
 * - Declared length >8 MiB → straight through: the scoped parser still 413s
 *   without reading, so the loud DoS bound and its pinned regression stay.
 * - Gate auth == route auth: `sellerFromSession` (session cookie only, no
 *   thgs_ bearer), the exact check the route runs — the gate can never admit
 *   a credential class the route would reject. Cookie-less requests resolve
 *   anonymous with zero DB work; a cookie plus a large declared body costs
 *   one indexed SELECT (the same one the route runs post-parse, and authed
 *   photo drafts are rate-limited 10/h/seller).
 * - A DB error surfaces via next(err) → the /api terminal error middleware's
 *   generic 500, the same failure mode the route itself has — never a silent
 *   anonymous downgrade, and never the parse.
 *
 * Residual (accepted, same bound as pre-fix): a chunked request with NO
 * Content-Length skips the gate and still parses under the 8 MiB cap before
 * the route's 401 — bounded by the cap, and no worse than the status quo.
 * Closing it needs a pre-auth per-IP bucket (the issue's option 1); ticketed
 * separately if the traffic shape ever shows up.
 */
export async function draftListingAnonBodyGate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const declared = Number(req.headers["content-length"]);
    // Small (or undeclared) bodies and over-cap bodies pass through: the
    // scoped parser is the authority there (256 KiB behavior unchanged,
    // >8 MiB still 413s before reading).
    if (!Number.isFinite(declared) || declared <= MCP_ANON_MAX_BYTES || declared > DRAFT_LISTING_BODY_LIMIT) {
      next();
      return;
    }
    // In-envelope large body: only a resolved session may spend the parse.
    const seller = await sellerFromSession(req);
    if (!seller) {
      res.status(401).json({ error: "Sign in to draft a listing." });
      return;
    }
    next();
  } catch (e) {
    next(e);
  }
}

/** Mounts the JSON parsers in production order: the anonymous-body gate and
 *  the scoped draft-listing parser first, then the global parser for
 *  everything else. Sits exactly where index.ts has always put the parser —
 *  after the raw-body surfaces (/mcp, webhooks) and before
 *  mountOauthRoutes/mountApiRoutes. */
export function mountBodyParsers(app: Express): void {
  app.post("/api/draft-listing", draftListingAnonBodyGate);
  app.post("/api/draft-listing", express.json({ limit: DRAFT_LISTING_BODY_LIMIT }));
  app.use(express.json({ limit: GLOBAL_JSON_BODY_LIMIT }));
}
