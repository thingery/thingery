// THI-1954 (S2): account.js must register its language-toggle re-render
// through __thingeryI18N.onchange — the documented i18n.js public API. The
// old `.onChange(...)` typo threw a TypeError at module load, which killed
// the rest of the script: checkSession() never ran, so logged-in sellers
// stayed on the signup form. Execution harness mirrors the real-script
// style of tests/chatgpt-view.test.ts (DOM shim + fake fetches), with
// __thingeryI18N present the way the page actually loads it (i18n.js is a
// classic script that always runs first).

import { describe, expect, it, vi, afterEach } from "vitest";

class FakeElement {
  tag: string;
  children: (FakeElement | string)[] = [];
  textContent = "";
  className = "";
  hidden = false;
  value = "";
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  onclick: ((e?: unknown) => unknown) | null = null;
  onsubmit: ((e: unknown) => unknown) | null = null;
  href = "";
  style: Record<string, string> = {};
  constructor(tag: string) { this.tag = tag; }
  focus() {}
  appendChild<T>(node: T): T { this.children.push(node as FakeElement | string); return node; }
  append(...nodes: (FakeElement | string)[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: (FakeElement | string)[]) { this.children = nodes; }
}

/** Loads the real account.js with browser globals stubbed and a live
 *  __thingeryI18N whose onchange records listeners (i18n.js contract). */
async function runAccountPage() {
  const byId = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!byId.has(id)) byId.set(id, new FakeElement("div"));
    return byId.get(id)!;
  };
  const listeners: ((lang: string) => void)[] = [];

  vi.stubGlobal("document", { getElementById: element, createElement: (t: string) => new FakeElement(t) });
  vi.stubGlobal("location", { search: "", pathname: "/login.html", origin: "https://thingery.dev" });
  vi.stubGlobal("history", { replaceState: () => {} });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("__thingeryI18N", {
    lang: () => "en",
    onchange: (cb: (lang: string) => void) => listeners.push(cb),
  });
  vi.stubGlobal("fetch", (url: string, init?: { method?: string }) => {
    if (url === "/api/me") {
      return Promise.resolve({ ok: true, json: async () => ({ seller: { name: "Ada" } }) });
    }
    if (url === "/api/me/llm-credential") {
      return Promise.resolve({ ok: true, json: async () => ({ byo_enabled: true, credential: null }) });
    }
    if (url === "/api/me/chatgpt") {
      if (init?.method === "DELETE") return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ enabled: false, connected: false, fingerprint: null, model: null }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });

  vi.resetModules();
  await import("../public/account.js");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { byId, listeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account.js i18n wiring (THI-1954)", () => {
  it("registers the toggle re-render via onchange without a load-time TypeError", async () => {
    // Before the fix the import itself rejected: __thingeryI18N.onChange is
    // not a function, and checkSession()/showChatgptBanner() below it never
    // ran — the page broke on load whenever i18n.js was present.
    const { byId, listeners } = await runAccountPage();
    expect(listeners).toHaveLength(1); // exactly one registration
    expect(byId.get("welcome")!.textContent).toContain("Ada"); // session restored
  });

  it("re-renders the dynamic sections when the language toggle fires", async () => {
    const { byId, listeners } = await runAccountPage();
    expect(() => listeners[0]("it")).not.toThrow();
    expect(byId.get("welcome")!.textContent).toContain("Ada");
    expect(byId.get("done")!.hidden).toBe(false);
    expect(byId.get("auth")!.hidden).toBe(true);
  });
});
