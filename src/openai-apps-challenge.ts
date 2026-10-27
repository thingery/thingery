// OpenAI plugin directory domain verification (THI-296 AC1, board ask THI-187):
// the portal fetches GET /.well-known/openai-apps-challenge and compares the
// body to the challenge token it issued for thingery.dev. Plain text only —
// no JSON wrapper (the portal expects the bare token).
//
// Behavior:
// - OPENAI_APPS_CHALLENGE_TOKEN set → 200 text/plain, body exactly the env
//   value (no trimming, no transformation).
// - unset/empty → 503: the route is present but the challenge is not
//   configured, which gives the portal an explicit retryable state instead
//   of a misleading empty 200 (or a 404 that looks like the route is gone).
//
// Security notes (spec THI-296 §AC1): the token is public-by-design (OpenAI
// fetches it to prove domain control), so it carries no confidentiality
// requirement; it is still never logged. The endpoint is a single env read —
// no DB, no auth (by design), no rate-limit surface worth its cost.
// Cache-Control: no-store so a post-redeploy token change is never served
// stale by any intermediary (Caddy proxies but does not cache; the header
// keeps shared caches honest too).

import type { Express } from "express";

export function mountOpenaiAppsChallenge(app: Express): void {
  app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    const token = process.env.OPENAI_APPS_CHALLENGE_TOKEN;
    if (!token) {
      res
        .status(503)
        .type("text/plain")
        .set("Cache-Control", "no-store")
        .send("challenge token not configured");
      return;
    }
    res.status(200).type("text/plain").set("Cache-Control", "no-store").send(token);
  });
}
