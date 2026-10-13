// Baseline security headers applied to every HTTP response (upstream #9).
// Kept in one module so the policy is reviewable and testable as a unit.
import type { RequestHandler } from "express";

// CSP notes (keep in sync with docs/security.md §4):
// - `script-src 'self'` only: every executable script lives in a static file
//   under `website/`. No 'unsafe-inline' — item pages render seller-controlled
//   content, and inline script must never become executable there.
// - `style-src` keeps 'unsafe-inline': pages use <style> blocks and inline
//   style="" attributes. Accepted tradeoff for the baseline (style injection
//   is a far weaker primitive than script injection); nonces/hashes later.
// - `img-src https:` — item images include external URLs provided by sellers
//   (plus same-origin `/img/...` uploads). `data:` is not used by the UI today.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // TLS terminates at the reverse proxy (Caddy on the flagship), so HSTS is
  // set here in-app. 180 days, no preload yet — extend deliberately.
  res.setHeader("Strict-Transport-Security", "max-age=15552000");
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  next();
};
