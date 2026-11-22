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
// request. Auth still precedes any parse rejection the envelope admits: an
// unauthenticated >256kb draft POST parses under the scoped cap and 401s at
// the route (the THI-1196 regression contract), and the route's own zod caps
// (≤1 photo, ≤5 MB, jpeg/png/webp/gif) plus the per-seller limiter stay the
// real content bound. 8 MiB is the /mcp cap (same envelope math) — not a new
// policy; the two move together by construction.

import express, { type Express } from "express";
import { MCP_MAX_BODY_BYTES } from "./mcp-gate.js";

/** Draft-listing photo envelopes parse under the same cap as /mcp. */
export const DRAFT_LISTING_BODY_LIMIT = MCP_MAX_BODY_BYTES;

/** Global browser-API JSON cap — the pre-THI-1197 256kb default, unchanged. */
export const GLOBAL_JSON_BODY_LIMIT = 256 * 1024;

/** Mounts the JSON parsers in production order: the scoped draft-listing
 *  parser first, then the global parser for everything else. Sits exactly
 *  where index.ts has always put the parser — after the raw-body surfaces
 *  (/mcp, webhooks) and before mountOauthRoutes/mountApiRoutes. */
export function mountBodyParsers(app: Express): void {
  app.post("/api/draft-listing", express.json({ limit: DRAFT_LISTING_BODY_LIMIT }));
  app.use(express.json({ limit: GLOBAL_JSON_BODY_LIMIT }));
}
