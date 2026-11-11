// Render tests for the OAuth consent and connected-apps pages that need no
// database: brand copy, escaping of attacker-suppliable DCR text, the form
// fields the POST handlers re-validate, and the CSP-compatible markup.

import { describe, expect, it } from "vitest";
import { appsPageHtml, consentPageHtml } from "../src/oauth.js";

const query = {
  client_id: "thgc_render",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  response_type: "code",
  scope: "mcp",
  state: "st<ate>",
  code_challenge: "c".repeat(43),
  code_challenge_method: "S256",
  resource: undefined,
};

function consent(overrides: Partial<Parameters<typeof consentPageHtml>[0]> = {}): string {
  return consentPageHtml({
    clientName: "Claude",
    clientUri: null,
    accountLabel: "seller@example.com",
    query,
    csrf: "csrf-token",
    nonce: "nonce-value",
    ...overrides,
  });
}

function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[m[1] as string] = m[2] as string;
  }
  return fields;
}

describe("consent page", () => {
  it("asks the question from the board, with the account and the permission list", () => {
    const html = consent();
    expect(html).toContain("<h1>Let Claude use your account?</h1>");
    expect(html).toContain("Signed in as <strong>seller@example.com</strong>.");
    expect(html).toContain('<a href="/login.html">Not you?</a>');
    expect(html).toContain("<h2>It will act as you</h2>");
    expect(html).toContain("<li>Read and change your listings</li><li>Read and manage your orders</li>");
    expect(html).toContain("Only allow apps you trust.");
    expect(html).toContain("You can disconnect it any time");
  });

  it("names the host the validated redirect URI sends the user back to", () => {
    expect(consent()).toContain('<p class="ticket">Sends you back to claude.ai</p>');
    const loopback = consent({ query: { ...query, redirect_uri: "http://localhost:51717/callback" } });
    expect(loopback).toContain("Sends you back to localhost:51717");
  });

  it("keeps Deny first in the markup so Enter never grants access", () => {
    const html = consent();
    expect(html.indexOf('value="deny"')).toBeLessThan(html.indexOf('value="allow"'));
    expect(html).toContain(`<button type="submit" name="action" value="deny">Don't allow</button>`);
    expect(html).toContain('<button type="submit" name="action" value="allow" class="primary">Allow</button>');
  });

  it("posts the same authorize fields, CSRF and nonce back to /oauth/authorize", () => {
    const html = consent();
    expect(html.match(/<form /g)).toHaveLength(1);
    expect(html).toContain('<form method="post" action="/oauth/authorize">');
    expect(hiddenFields(html)).toEqual({
      client_id: "thgc_render",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      response_type: "code",
      scope: "mcp",
      state: "st&lt;ate&gt;",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      csrf: "csrf-token",
      nonce: "nonce-value",
    });
  });

  it("escapes the client name and client_uri everywhere, and never links the client_uri", () => {
    const html = consent({
      clientName: '<script>alert("x")</script>',
      clientUri: 'https://evil.example/"><img src=x>',
      accountLabel: "<b>me</b>",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>me</b>");
    expect(html).toContain("<h1>Let &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; use your account?</h1>");
    expect(html).toContain("says it is from https://evil.example/&quot;&gt;&lt;img src=x&gt;");
    expect(html).not.toMatch(/<a[^>]*evil\.example/);
  });

  it("omits the provenance line when the client registered no client_uri", () => {
    expect(consent()).not.toContain("says it is from");
  });

  it("uses no inline style attribute or script, so the hash-only CSP holds", () => {
    const html = consent();
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toContain("<script");
    expect(html.match(/<style>/g)).toHaveLength(1);
  });

  it("supports dark mode with the brand's dark colour roles", () => {
    const html = consent();
    expect(html).toContain("@media (prefers-color-scheme:dark)");
    expect(html).toContain("--page:#14151A");
  });
});

describe("connected apps page", () => {
  const grant = {
    id: "8f9e0c4e-0000-4000-8000-000000000001",
    client_name: "Apps Client <test>",
    created_at: new Date("2026-11-03T10:00:00Z"),
    last_used_at: null,
    csrf: "revoke-csrf",
  };

  it("lists each app with its dates and a Disconnect form posting the grant and CSRF", () => {
    const html = appsPageHtml([grant, { ...grant, id: "g2", client_name: "Cursor", last_used_at: new Date("2026-11-09T23:59:00Z") }], false);
    expect(html).toContain("<h1>Connected apps.</h1>");
    expect(html).toContain("These apps can act as you. Disconnect one and it loses access right away.");
    expect(html).toContain("<h2>Apps Client &lt;test&gt;</h2>");
    expect(html).not.toContain("<test>");
    expect(html).toContain("Connected 3 Nov 2026 · Never used");
    expect(html).toContain("Connected 3 Nov 2026 · Used 9 Nov 2026");
    expect(html.match(/<form method="post" action="\/apps\/revoke">/g)).toHaveLength(2);
    expect(html).toContain(`<input type="hidden" name="grant_id" value="${grant.id}">`);
    expect(html).toContain('<input type="hidden" name="csrf" value="revoke-csrf">');
    expect(html.match(/>Disconnect<\/button>/g)).toHaveLength(2);
    expect(html).not.toMatch(/\sstyle="/);
  });

  it("confirms a disconnect and links back to the account", () => {
    const html = appsPageHtml([], true);
    expect(html).toContain('<p class="notice" role="status">App disconnected. It no longer has access.</p>');
    expect(html).toContain('<a class="back" href="/login.html">Your account</a>');
    expect(html).toContain("No apps are connected.");
  });
});
