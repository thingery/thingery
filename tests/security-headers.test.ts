// Baseline security headers + JSON-LD output encoding (upstream #9).
// Regression tests: these fail against the pre-PR code, which set no
// security headers, left `x-powered-by` on, and embedded JSON.stringify
// output directly in <script> data blocks.
import type { Server } from "node:http";
import express from "express";
import { afterAll, describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, securityHeaders } from "../src/security-headers.js";
import { safeJsonLd } from "../src/web-pages.js";

describe("security headers middleware", () => {
  let server: Server | undefined;
  afterAll(() => {
    server?.close();
  });

  it("sets baseline headers on every response", async () => {
    const app = express();
    app.disable("x-powered-by");
    app.use(securityHeaders);
    app.get("/probe", (_req, res) => res.json({ ok: true }));
    app.get("/boom", (_req, res) => res.status(500).end());
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const { port } = server.address() as { port: number };

    for (const path of ["/probe", "/boom", "/definitely-missing-404"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.headers.get("x-powered-by"), `${path}: x-powered-by must be absent`).toBeNull();
      expect(res.headers.get("x-content-type-options"), `${path}: nosniff`).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), `${path}: referrer-policy`).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(res.headers.get("strict-transport-security"), `${path}: HSTS`).toBe("max-age=15552000");
      // Express's finalhandler overrides CSP on its own 404 page with the
      // stricter "default-src 'none'" — acceptable (static text). Assert the
      // full policy on handled responses.
      const expectedCsp = path === "/definitely-missing-404" ? "default-src 'none'" : CONTENT_SECURITY_POLICY;
      expect(res.headers.get("content-security-policy"), `${path}: CSP`).toBe(expectedCsp);
    }
  });

  it("CSP forbids inline script but allows seller-supplied https images", () => {
    // script-src must be 'self' only — item pages render seller-controlled
    // content, so executable inline script would be an XSS amplifier.
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    // img-src: same-origin uploads + external seller image URLs.
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' https:");
    // Clickjacking / plugin / base-tag injection covered.
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'self'");
  });
});

describe("safeJsonLd output encoding (stored XSS regression)", () => {
  it("neutralizes </script> breakout in seller-controlled values", () => {
    const payload = {
      description: '</script><script>alert("xss")</script>',
      name: "benign </title> item",
    };
    const rendered = safeJsonLd(payload);
    // No raw "</script>" may survive inside the JSON data block.
    expect(rendered).not.toContain("</script>");
    // The escaped form must still be valid JSON that round-trips exactly.
    expect(JSON.parse(rendered)).toEqual(payload);
  });

  it("leaves normal listing data byte-identical to JSON.stringify", () => {
    const payload = { name: "Diplomat pen", description: "good condition", price: "120.00" };
    expect(safeJsonLd(payload)).toBe(JSON.stringify(payload));
  });
});
