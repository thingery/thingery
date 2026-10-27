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
  src = "";
  alt = "";
  loading = "";
  referrerPolicy = "";
  type = "";
  hidden = false;
  dataset: Record<string, string> = {};
  /** THI-308 PR 3 shim extension: event wiring is addEventListener-based —
   *  record registrations so tests can prove listeners exist without any
   *  inline handler attributes. PR 4 adds parentNode/insertBefore/draggable
   *  for the delete + drag-to-reorder thumbnail wiring. */
  listeners: Array<[string, unknown]> = [];
  draggable = false;
  title = "";
  parentNode: FakeElement | null = null;
  classList = {
    add: (c: string) => {},
    remove: (c: string) => {},
    toggle: (_c: string, _on?: boolean) => {},
  };
  constructor(tag: string) {
    this.tag = tag;
  }
  addEventListener(event: string, handler: unknown) {
    this.listeners.push([event, handler]);
  }
  appendChild<T>(node: T): T {
    (node as FakeElement).parentNode = this;
    this.children.push(node as FakeElement | string);
    return node;
  }
  insertBefore<T>(node: T, ref: FakeElement | string): T {
    const i = this.children.indexOf(ref);
    if (i === -1) this.children.push(node as FakeElement | string);
    else this.children.splice(i, 0, node as FakeElement | string);
    (node as FakeElement).parentNode = this;
    return node;
  }
  append(...nodes: (FakeElement | string)[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeElement | string)[]) {
    this.children = nodes;
  }
  remove() {
    this.removed = true;
  }
  removed = false;
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
    // THI-193 PR-4: chat.js also polls /api/me/chatgpt for the plan
    // indicator — answer it with a non-ok response so it stays hidden.
    const fetchWithChatgptStatus = (url: string) =>
      url === "/api/me"
        ? fetch(url)
        : Promise.resolve({ ok: false, json: async () => ({}) });

    new Function("document", "fetch", script)(document, fetchWithChatgptStatus);
    await new Promise((r) => setTimeout(r, 0)); // let the fetch chain settle

    const accountLink = byId.get("account-link")!;
    // THI-186 Phase 1: logged-in users also get a "use your own model" link
    // before the account link — same inert-text construction.
    expect(accountLink.children.length).toBe(6);

    const [lead, name, separator, byoLink, separator2, link] = accountLink.children;
    // Fails against the old code, which set .innerHTML as a string and
    // left no child nodes (and would have parsed the payload as HTML).
    expect(lead).toBe("Logged in as ");
    expect(name).toBe(HOSTILE_NAME); // hostile payload survives verbatim as text
    expect(separator).toBe(" · ");
    expect(byoLink).toBeInstanceOf(FakeElement);
    expect((byoLink as FakeElement).tag).toBe("a");
    expect((byoLink as FakeElement).href).toBe("/login.html");
    expect((byoLink as FakeElement).textContent).toBe("use your own model");
    expect(separator2).toBe(" · ");
    expect(link).toBeInstanceOf(FakeElement);
    expect((link as FakeElement).tag).toBe("a");
    expect((link as FakeElement).href).toBe("/login.html");
    expect((link as FakeElement).textContent).toBe("account");

    // Only the anchors are elements; everything else is a text node, so
    // the display name can never introduce markup.
    const elements = accountLink.children.filter((c) => c instanceof FakeElement);
    expect(elements).toEqual([byoLink, link]);

    const rendered = accountLink.children
      .map((c) => (c instanceof FakeElement ? c.textContent : c))
      .join("");
    expect(rendered).toBe(`Logged in as ${HOSTILE_NAME} · use your own model · account`);
  });
});

describe("photos.js / imaging.js (THI-308 PR 3: CSP-safe capture UI)", () => {
  const readScript = (name: string) => readFileSync(`${websiteDir}/${name}`, "utf8");

  /** DOM shim matching the server-rendered owner panel (src/web-pages.ts):
   *  photo-zone with dataset, the two file inputs, status/strip targets. */
  function captureDom() {
    const byId = new Map<string, FakeElement>();
    const el = (id: string) => {
      if (!byId.has(id)) byId.set(id, new FakeElement("div"));
      return byId.get(id)!;
    };
    const zone = el("photo-zone");
    zone.dataset = { itemId: "itm-1", imageCount: "0", maxImages: "12" };
    const document = {
      getElementById: el,
      createElement: (tag: string) => new FakeElement(tag),
      listeners: [] as Array<[string, unknown]>,
      addEventListener(event: string, handler: unknown) {
        this.listeners.push([event, handler]);
      },
    };
    return { byId, document, zone, take: el("photo-take"), choose: el("photo-choose") };
  }

  it("imaging.js registers its helpers globally without touching the DOM", () => {
    delete (globalThis as { ThingeryImaging?: unknown }).ThingeryImaging;
    new Function(readScript("imaging.js"))();
    const imaging = (globalThis as { ThingeryImaging?: unknown }).ThingeryImaging;
    expect(imaging).toBeTruthy();
    expect((imaging as { initialQuality: () => number }).initialQuality()).toBe(0.8);
  });

  it("photos.js wires the capture UI purely via addEventListener (no inline handlers, no javascript: URIs)", () => {
    const src = readScript("photos.js");
    // CSP hygiene: nothing navigates or executes via a javascript: URI, and
    // (already enforced file-wide above) no HTML-string sinks exist.
    expect(src).not.toMatch(/javascript:/i);
    const { document, take, choose, zone } = captureDom();
    new Function("document", "window", src)(document, { ThingeryImaging: {} });
    // Camera + gallery inputs auto-upload on change (one tap → snap → upload).
    expect(take.listeners.map(([e]) => e)).toContain("change");
    expect(choose.listeners.map(([e]) => e)).toContain("change");
    // Desktop affordances: drop target on the zone, clipboard paste globally.
    expect(zone.listeners.map(([e]) => e)).toEqual(expect.arrayContaining(["dragover", "drop"]));
    expect(document.listeners.map(([e]) => e)).toContain("paste");
  });

  it("photos.js is a no-op when the owner panel is absent (non-owner pages)", () => {
    const byId = new Map<string, FakeElement>();
    const document = {
      getElementById: (id: string) => {
        // photos.js asks for photo-zone first; absent → returns undefined.
        return id === "photo-zone" ? (undefined as unknown as FakeElement) : new FakeElement("div");
      },
      createElement: (tag: string) => new FakeElement(tag),
      listeners: [] as Array<[string, unknown]>,
      addEventListener() {},
    };
    expect(() => new Function("document", "window", readScript("photos.js"))(document, {})).not.toThrow();
    expect(document.listeners).toEqual([]); // no paste listener without the panel
    expect(byId.size).toBe(0);
  });
});

describe("photos.js delete + reorder wiring (THI-308 PR 4)", () => {
  const readScript = () => readFileSync(`${websiteDir}/photos.js`, "utf8");

  const STORED_A = "/img/items/itm-1-aaa.jpg";
  const STORED_B = "/img/items/itm-1-bbb.jpg";
  const EXTERNAL = "https://cdn.example.com/pics/a.jpg";

  /** Owner-panel DOM shim matching src/web-pages.ts, with the PR-4
   *  data-images seed and a recording fetch mock. */
  function managerDom(images: string[], confirmResult = true) {
    const byId = new Map<string, FakeElement>();
    const el = (id: string) => {
      if (!byId.has(id)) byId.set(id, new FakeElement("div"));
      return byId.get(id)!;
    };
    const zone = el("photo-zone");
    zone.dataset = { itemId: "itm-1", imageCount: String(images.length), maxImages: "12", images: JSON.stringify(images) };
    // A live listing renders no pending banner — model the absent element so
    // photos.js starts with banner = null (the shim auto-creates otherwise).
    byId.set("pending-banner", null as unknown as FakeElement);
    // The zone lives inside the owner panel — the recreated banner is
    // inserted before it (same position as the server-rendered one).
    const panel = new FakeElement("div");
    panel.appendChild(zone);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const respond: Array<{ ok: boolean; body: unknown }> = [];
    const fetchMock = (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      const next = respond.shift() ?? { ok: true, body: {} };
      return Promise.resolve({
        ok: next.ok,
        json: async () => next.body,
      });
    };
    const document = {
      getElementById: el,
      createElement: (tag: string) => new FakeElement(tag),
      listeners: [] as Array<[string, unknown]>,
      addEventListener(event: string, handler: unknown) {
        this.listeners.push([event, handler]);
      },
    };
    const win = { ThingeryImaging: null, confirm: () => confirmResult };
    new Function("document", "window", "fetch", readScript())(document, win, fetchMock);
    const settle = () => new Promise((r) => setTimeout(r, 0));
    return { byId, el, zone, calls, respond, settle };
  }

  const thumbs = (strip: FakeElement) => strip.children.filter((c) => c instanceof FakeElement) as FakeElement[];
  const thumbDel = (t: FakeElement) =>
    t.children.find((c) => c instanceof FakeElement && c.tag === "button") as FakeElement;
  const thumbImg = (t: FakeElement) => t.children.find((c) => c instanceof FakeElement && c.tag === "img") as FakeElement;
  const fire = (el: FakeElement, event: string, arg?: unknown) =>
    (el.listeners.find(([e]) => e === event)?.[1] as (a?: unknown) => void)(arg);

  it("rebuilds the strip from data-images: cover badge on the first, × delete + drag wiring on every thumb", () => {
    const { el } = managerDom([STORED_A, STORED_B]);
    const strip = el("photo-strip");
    expect(thumbs(strip)).toHaveLength(2);
    const [first, second] = thumbs(strip);
    expect(first.draggable).toBe(true);
    expect(first.listeners.map(([e]) => e)).toEqual(expect.arrayContaining(["dragstart", "dragover", "drop", "dragend"]));
    // Cover badge only on index 0; every thumb gets a × button + image.
    expect(first.children.some((c) => c instanceof FakeElement && c.className === "cover-badge")).toBe(true);
    expect(second.children.some((c) => c instanceof FakeElement && c.className === "cover-badge")).toBe(false);
    expect(thumbDel(first).textContent).toBe("×");
    expect(thumbDel(second).textContent).toBe("×");
    expect(thumbImg(first).src).toBe(STORED_A);
  });

  it("warns before deleting the last photo and aborts when the seller declines", async () => {
    const { el, calls } = managerDom([STORED_A], false); // confirm → decline
    fire(thumbDel(thumbs(el("photo-strip"))[0]), "click");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0); // no request without confirmation
  });

  it("deletes by stored filename, re-renders from the server array, and deletes external members by full URL", async () => {
    const m = managerDom([STORED_A, EXTERNAL]);
    m.respond.push({ ok: true, body: { images: [EXTERNAL], visible: true } });
    fire(thumbDel(thumbs(m.el("photo-strip"))[0]), "click");
    await m.settle();
    expect(m.calls[0].url).toBe(`/api/items/itm-1/images/${encodeURIComponent("itm-1-aaa.jpg")}`);
    expect(m.calls[0].init.method).toBe("DELETE");
    expect(thumbs(m.el("photo-strip"))).toHaveLength(1);
    expect(thumbImg(thumbs(m.el("photo-strip"))[0]).src).toBe(EXTERNAL);

    // External-URL member: the whole URL is the reference, encoded — and no
    // filename can be smuggled past the server gate this way.
    m.respond.push({ ok: true, body: { images: [], visible: false, warning: "hidden" } });
    fire(thumbDel(thumbs(m.el("photo-strip"))[0]), "click");
    await m.settle();
    expect(m.calls[1].url).toBe(`/api/items/itm-1/images/${encodeURIComponent(EXTERNAL)}`);
    // Last photo gone on a photo_required listing → pending banner returns,
    // inserted before the zone (same position as the server-rendered one).
    const banner = m.zone.parentNode?.children[0] as FakeElement;
    expect(banner.id).toBe("pending-banner");
    expect(banner.textContent).toContain("hidden from search");
    expect(m.zone.parentNode?.children[1]).toBe(m.zone);
  });

  it("drag-to-reorder PUTs the new order and renders the server's array back", async () => {
    const m = managerDom([STORED_A, STORED_B, EXTERNAL]);
    const strip = m.el("photo-strip");
    fire(thumbs(strip)[0], "dragstart");
    fire(thumbs(strip)[2], "drop", { preventDefault() {} });
    await m.settle();
    expect(m.calls[0].url).toBe("/api/items/itm-1/images/order");
    expect(m.calls[0].init.method).toBe("PUT");
    expect(JSON.parse((m.calls[0].init.body as string) ?? "{}")).toEqual({
      images: [STORED_B, EXTERNAL, STORED_A],
    });
    expect(thumbImg(thumbs(strip)[0]).src).toBe(STORED_B); // optimistic order kept
  });

  it("reverts to the server's current set on a 409 conflict", async () => {
    const m = managerDom([STORED_A, STORED_B]);
    const strip = m.el("photo-strip");
    m.respond.push({ ok: false, body: { error: "Photos changed since the page loaded — showing the current set.", images: [STORED_B, STORED_A] } });
    fire(thumbs(strip)[0], "dragstart");
    fire(thumbs(strip)[1], "drop", { preventDefault() {} });
    await m.settle();
    const after = thumbs(strip).map((t) => thumbImg(t).src);
    expect(after).toEqual([STORED_B, STORED_A]); // server order, not the optimistic one
  });
});
