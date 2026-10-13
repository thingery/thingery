import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const websiteDir = fileURLToPath(new URL("../website", import.meta.url));

/**
 * Regression tests for THI security issue gh#8 (self-XSS in chat account link).
 *
 * website/ pages are static HTML loaded from external scripts (CSP from
 * the baseline security headers PR; no inline executable scripts) and no
 * framework; the only safe way to render server data in them is via text
 * nodes (textContent / createElement / replaceChildren). These tests fail
 * if any page or script reintroduces an HTML-string sink — the sink moved
 * from chat.html to chat.js when the script was externalized, so both
 * file kinds are scanned — and they execute the real chat.js with a
 * hostile display name to prove it renders inert text.
 */

// Minimal DOM shim: enough for the chat page's top-level script.
class FakeElement {
  tag: string;
  children: (FakeElement | string)[] = [];
  textContent = "";
  className = "";
  value = "";
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  onsubmit: unknown = null;
  href = "";
  constructor(tag: string) {
    this.tag = tag;
  }
  appendChild<T>(node: T): T {
    this.children.push(node as FakeElement | string);
    return node;
  }
  append(...nodes: (FakeElement | string)[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeElement | string)[]) {
    this.children = nodes;
  }
}

describe("website/ HTML sinks", () => {
  it("html and js files contain no innerHTML/outerHTML/insertAdjacentHTML/document.write usage", () => {
    const files = readdirSync(websiteDir).filter(
      (f) => f.endsWith(".html") || f.endsWith(".js"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(`${websiteDir}/${file}`, "utf8");
      // Fails on the pre-fix account-link sink (gh#8), which lived in
      // chat.html before the CSP externalization and in chat.js after.
      expect(
        source,
        `${file} must not assign HTML via .innerHTML/.outerHTML, insertAdjacentHTML, or document.write`,
      ).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
    }
  });

  it("html files contain no inline executable scripts (CSP requires external scripts)", () => {
    const htmlFiles = readdirSync(websiteDir).filter((f) => f.endsWith(".html"));
    expect(htmlFiles.length).toBeGreaterThan(0);
    for (const file of htmlFiles) {
      const html = readFileSync(`${websiteDir}/${file}`, "utf8");
      const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
      for (const tag of scriptTags) {
        const hasSrc = /\bsrc\s*=/.test(tag);
        const typeMatch = tag.match(/\btype\s*=\s*["']?([^"'\s>]+)/);
        const type = typeMatch?.[1] ?? "";
        // Non-JS data blocks (e.g. application/ld+json) are not executed
        // and are allowed by the CSP; everything else must be external.
        const isDataBlock = type !== "" && !/javascript|module|^text\/javascript$/i.test(type);
        const inline = !hasSrc && !isDataBlock;
        expect(
          inline,
          `${file}: inline executable script ${tag} violates the CSP (script-src 'self'); move it to an external file`,
        ).toBe(false);
      }
    }
  });
});

describe("chat.js account link (gh#8)", () => {
  const HOSTILE_NAME = 'Mallory <img src=x onerror=alert(1)> ">&<script>';

  it("renders the display name as inert text with a working /login.html link", async () => {
    const script = readFileSync(`${websiteDir}/chat.js`, "utf8");

    const byId = new Map<string, FakeElement>();
    const document = {
      getElementById: (id: string) => {
        if (!byId.has(id)) byId.set(id, new FakeElement("div"));
        return byId.get(id)!;
      },
      createElement: (tag: string) => new FakeElement(tag),
    };
    const fetch = (url: string) => {
      expect(url).toBe("/api/me");
      return Promise.resolve({
        ok: true,
        json: async () => ({ seller: { name: HOSTILE_NAME } }),
      });
    };

    new Function("document", "fetch", script)(document, fetch);
    await new Promise((r) => setTimeout(r, 0)); // let the fetch chain settle

    const accountLink = byId.get("account-link")!;
    expect(accountLink.children.length).toBe(4);

    const [lead, name, separator, link] = accountLink.children;
    // Fails against the old code, which set .innerHTML as a string and
    // left no child nodes (and would have parsed the payload as HTML).
    expect(lead).toBe("Logged in as ");
    expect(name).toBe(HOSTILE_NAME); // hostile payload survives verbatim as text
    expect(separator).toBe(" · ");
    expect(link).toBeInstanceOf(FakeElement);
    expect((link as FakeElement).tag).toBe("a");
    expect((link as FakeElement).href).toBe("/login.html");
    expect((link as FakeElement).textContent).toBe("account");

    // Only the anchor is an element; everything else is a text node, so
    // the display name can never introduce markup.
    const elements = accountLink.children.filter((c) => c instanceof FakeElement);
    expect(elements).toEqual([link]);

    const rendered = accountLink.children
      .map((c) => (c instanceof FakeElement ? c.textContent : c))
      .join("");
    expect(rendered).toBe(`Logged in as ${HOSTILE_NAME} · account`);
  });
});
