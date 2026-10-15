// THI-193 PR-4 (spec §7): the ChatGPT-plan settings slot on the account
// page, the callback banners, the first-connect modal, and the chat-page
// "Using ChatGPT plan" indicator. Pure helpers run DOM-less (account-view
// test style); the real account.js/chat.js are executed against a DOM shim
// with fake fetches (website-security test style) to prove the wiring —
// slot gating on `enabled`, connected rendering, banner states, modal-once,
// and the disconnect DELETE.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHATGPT_MODAL_DISMISSED_KEY,
  chatgptBanner,
  chatgptModalDismissed,
  chatgptSlotVisible,
  chatgptStatusText,
  rememberChatgptModal,
} from "../website/chatgpt-view.js";

const websiteDir = fileURLToPath(new URL("../website", import.meta.url));

// --- pure helpers -----------------------------------------------------------

describe("chatgpt view helpers (THI-193 PR-4)", () => {
  it("gates the slot strictly on enabled:true (flag off ⇒ no UI)", () => {
    expect(chatgptSlotVisible({ enabled: true, connected: false })).toBe(true);
    expect(chatgptSlotVisible({ enabled: false, connected: false })).toBe(false);
    expect(chatgptSlotVisible(null)).toBe(false); // 404/flag-off fetch shape
    expect(chatgptSlotVisible({ connected: true })).toBe(false); // enabled missing
  });

  it("renders the connected state with fingerprint and model", () => {
    const text = chatgptStatusText({ enabled: true, connected: true, fingerprint: "a1b2c3", model: "gpt-5.2" });
    expect(text).toContain("Using ChatGPT plan");
    expect(text).toContain("fingerprint a1b2c3");
    expect(text).toContain("model gpt-5.2");
    // Degraded shapes still read sensibly (metadata may be null server-side).
    expect(chatgptStatusText({ connected: true, fingerprint: null, model: null })).toBe("Using ChatGPT plan.");
  });

  it("maps every callback slug to friendly fixed copy, unknown slugs to nothing", () => {
    expect(chatgptBanner("connected")).toEqual({ tone: "ok", text: expect.stringContaining("ChatGPT connected") });
    expect(chatgptBanner("declined")!.text).toContain("cancelled");
    expect(chatgptBanner("plan_not_enabled")!.text).toContain("approve plan usage");
    expect(chatgptBanner("error")!.text).toContain("Something went wrong");
    // No provider text or token material in any copy, and nothing reflects
    // arbitrary query input.
    for (const slug of ["connected", "declined", "plan_not_enabled", "error"]) {
      expect(chatgptBanner(slug)!.text).not.toMatch(/eyJ|access_token|refresh_token|Bearer|invalid_grant/);
    }
    expect(chatgptBanner("anything-else")).toBeNull();
    expect(chatgptBanner("access_token=xyz")).toBeNull();
  });

  it("shows the first-connect modal once, remembered in local storage", () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    };
    expect(chatgptModalDismissed(fake)).toBe(false);
    rememberChatgptModal(fake);
    expect(chatgptModalDismissed(fake)).toBe(true);
    expect(storage.get(CHATGPT_MODAL_DISMISSED_KEY)).toBe("1");
    // Unreadable storage (private mode) means "not dismissed" — safe side.
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(chatgptModalDismissed(throwing)).toBe(false);
    expect(() => rememberChatgptModal(throwing)).not.toThrow();
  });
});

// --- real-script execution against a DOM shim --------------------------------

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

interface ChatgptEnv {
  seller?: { name: string } | null;
  chatgptStatus?: number; // fetch status for /api/me/chatgpt (default 200)
  chatgptBody?: unknown;
  deleteBody?: unknown; // DELETE /api/me/chatgpt response (default { ok: true })
  search?: string;
  storage?: Map<string, string>;
  confirm?: () => boolean;
  deletes: { url: string; method: string }[];
  replacedUrls: string[];
}

/** Loads the real account.js module with browser globals stubbed. */
async function runAccountJs(env: ChatgptEnv) {
  const byId = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!byId.has(id)) byId.set(id, new FakeElement("div"));
    return byId.get(id)!;
  };
  const storage = env.storage ?? new Map<string, string>();
  const replacedUrls: string[] = [];
  const deletes = env.deletes;

  vi.stubGlobal("document", { getElementById: element, createElement: (t: string) => new FakeElement(t) });
  vi.stubGlobal("location", { search: env.search ?? "", pathname: "/login.html", origin: "https://thingery.dev" });
  vi.stubGlobal("history", { replaceState: (_: unknown, __: unknown, url: string) => void replacedUrls.push(String(url)) });
  vi.stubGlobal("localStorage", { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
  vi.stubGlobal("confirm", env.confirm ?? (() => true));
  vi.stubGlobal("fetch", (url: string, init?: { method?: string }) => {
    if (url === "/api/me") {
      return Promise.resolve({ ok: true, json: async () => ({ seller: env.seller === undefined ? { name: "Ada" } : env.seller }) });
    }
    if (url === "/api/me/llm-credential") {
      return Promise.resolve({ ok: true, json: async () => ({ byo_enabled: true, credential: null }) });
    }
    if (url === "/api/me/chatgpt") {
      if (init?.method === "DELETE") {
        deletes.push({ url, method: "DELETE" });
        return Promise.resolve({ ok: true, status: 200, json: async () => env.deleteBody ?? { ok: true } });
      }
      const status = env.chatgptStatus ?? 200;
      return Promise.resolve({ ok: status === 200, status, json: async () => (status === 200 ? env.chatgptBody : { error: "Not found." }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });

  vi.resetModules();
  await import("../website/account.js");
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { byId, element, storage, replacedUrls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Absent from the lazy map means the script never touched it — i.e. it
 * stayed hidden (the zero-footprint posture when the flag is off). */
const staysHidden = (byId: Map<string, FakeElement>, id: string) => byId.get(id)?.hidden ?? true;

describe("account.js ChatGPT slot (THI-193 PR-4)", () => {
  it("keeps the slot hidden when the flag is off (404) or enabled:false", async () => {
    const flagOff = await runAccountJs({ chatgptStatus: 404 });
    expect(staysHidden(flagOff.byId, "chatgpt")).toBe(true); // never rendered

    const disabled = await runAccountJs({
      chatgptBody: { enabled: false, connected: false, fingerprint: null, model: null },
    });
    expect(disabled.byId.get("chatgpt")?.hidden ?? true).toBe(true);
  });

  it("renders the disconnected state with the approved Continue with ChatGPT button", async () => {
    const { byId } = await runAccountJs({
      chatgptBody: { enabled: true, connected: false, fingerprint: null, model: null },
    });
    expect(byId.get("chatgpt")!.hidden).toBe(false);
    expect(byId.get("chatgpt-connect")!.hidden).toBe(false);
    expect(byId.get("chatgpt-disconnect")!.hidden).toBe(true);
    expect(byId.get("chatgpt-usage")!.hidden).toBe(true);
    expect(byId.get("chatgpt-status")!.textContent).toContain("Not connected");
  });

  it("renders the connected state: fingerprint, model, usage copy, disconnect", async () => {
    const { byId } = await runAccountJs({
      chatgptBody: { enabled: true, connected: true, fingerprint: "a1b2c3", model: "gpt-5.2" },
    });
    expect(byId.get("chatgpt-connect")!.hidden).toBe(true);
    expect(byId.get("chatgpt-disconnect")!.hidden).toBe(false);
    expect(byId.get("chatgpt-usage")!.hidden).toBe(false);
    expect(byId.get("chatgpt-status")!.textContent).toContain("fingerprint a1b2c3");
    expect(byId.get("chatgpt-status")!.textContent).toContain("model gpt-5.2");
  });

  it("shows the first-connect modal exactly once (dismissal remembered locally)", async () => {
    const first = await runAccountJs({
      chatgptBody: { enabled: true, connected: true, fingerprint: "a1b2c3", model: "gpt-5.2" },
    });
    expect(first.byId.get("chatgpt-modal-overlay")!.hidden).toBe(false);
    first.byId.get("chatgpt-modal-ok")!.onclick!();
    expect(first.byId.get("chatgpt-modal-overlay")!.hidden).toBe(true);
    expect(first.storage.get(CHATGPT_MODAL_DISMISSED_KEY)).toBe("1");

    // Fresh page load with the dismissal remembered: no modal.
    const second = await runAccountJs({
      chatgptBody: { enabled: true, connected: true, fingerprint: "a1b2c3", model: "gpt-5.2" },
      storage: first.storage,
    });
    expect(staysHidden(second.byId, "chatgpt-modal-overlay")).toBe(true);
  });

  it("disconnect (after confirm) hits DELETE /api/me/chatgpt and re-renders", async () => {
    const deletes: { url: string; method: string }[] = [];
    const { byId } = await runAccountJs({
      chatgptBody: { enabled: true, connected: true, fingerprint: "a1b2c3", model: "gpt-5.2" },
      confirm: () => true,
      deletes,
    });
    await byId.get("chatgpt-disconnect")!.onclick!();
    expect(deletes).toEqual([{ url: "/api/me/chatgpt", method: "DELETE" }]);
    expect(byId.get("chatgpt-status")!.textContent).toContain("Not connected");
    expect(byId.get("chatgpt-disconnect")!.hidden).toBe(true);
  });

  it("surfaces the revocation-unconfirmed hint when the server flags it", async () => {
    const deletes: { url: string; method: string }[] = [];
    const { byId } = await runAccountJs({
      chatgptBody: { enabled: true, connected: true, fingerprint: "a1b2c3", model: "gpt-5.2" },
      confirm: () => true,
      deletes,
      deleteBody: { ok: true, revocation_unconfirmed: true },
    });
    await byId.get("chatgpt-disconnect")!.onclick!();
    expect(byId.get("chatgpt-error")!.textContent).toContain("ChatGPT → Settings → Connections");
  });

  it("does not DELETE when the user cancels the confirm", async () => {
    const deletes: { url: string; method: string }[] = [];
    const { byId } = await runAccountJs({
      chatgptBody: { enabled: true, connected: true, fingerprint: "a1b2c3", model: "gpt-5.2" },
      confirm: () => false,
      deletes,
    });
    await byId.get("chatgpt-disconnect")!.onclick!();
    expect(deletes).toEqual([]);
  });

  it("renders each ?chatgpt= banner state with fixed copy and cleans the URL", async () => {
    const connected = await runAccountJs({ search: "?chatgpt=connected", seller: null });
    const banner = connected.byId.get("chatgpt-banner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("ChatGPT connected");
    expect(banner.className).toBe("");
    expect(connected.replacedUrls).toEqual(["/login.html"]);

    const declined = await runAccountJs({ search: "?chatgpt=declined", seller: null });
    expect(declined.byId.get("chatgpt-banner")!.textContent).toContain("cancelled");
    expect(declined.byId.get("chatgpt-banner")!.className).toBe("error");

    const plan = await runAccountJs({ search: "?chatgpt=plan_not_enabled", seller: null });
    expect(plan.byId.get("chatgpt-banner")!.textContent).toContain("approve plan usage");

    const error = await runAccountJs({ search: "?chatgpt=error", seller: null });
    expect(error.byId.get("chatgpt-banner")!.textContent).toContain("Something went wrong");

    // Unknown/hostile slugs render nothing and never reflect query text.
    const hostile = await runAccountJs({ search: "?chatgpt=%3Cscript%3Ealert(1)%3C%2Fscript%3E", seller: null });
    expect(staysHidden(hostile.byId, "chatgpt-banner")).toBe(true);

    // Other params survive the URL cleanup.
    const withNext = await runAccountJs({ search: "?chatgpt=connected&next=%2Fbrowse", seller: null });
    expect(withNext.replacedUrls).toEqual(["/login.html?next=%2Fbrowse"]);
  });
});

describe("chat.js plan indicator (THI-193 PR-4)", () => {
  const runChatJs = async (planBody: unknown, planOk: boolean) => {
    const byId = new Map<string, FakeElement>();
    const document = {
      getElementById: (id: string) => {
        if (!byId.has(id)) byId.set(id, new FakeElement("div"));
        return byId.get(id)!;
      },
      createElement: (tag: string) => new FakeElement(tag),
    };
    const fetch = (url: string) => {
      if (url === "/api/me") return Promise.resolve({ ok: true, json: async () => ({ seller: { name: "Ada" } }) });
      return Promise.resolve({ ok: planOk, json: async () => planBody });
    };
    const script = readFileSync(`${websiteDir}/chat.js`, "utf8");
    new Function("document", "fetch", script)(document, fetch);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return byId;
  };

  it("shows the static indicator when the status endpoint reports connected", async () => {
    const byId = await runChatJs({ enabled: true, connected: true }, true);
    expect(byId.get("plan-indicator")!.hidden).toBe(false);
  });

  it("stays hidden when the flag is off, disconnected, or the fetch fails", async () => {
    expect(staysHidden(await runChatJs({ error: "Not found." }, false), "plan-indicator")).toBe(true);
    expect(staysHidden(await runChatJs({ enabled: true, connected: false }, true), "plan-indicator")).toBe(true);
    expect(staysHidden(await runChatJs({ enabled: false, connected: true }, true), "plan-indicator")).toBe(true);
  });
});

// --- static markup: approved button format, official asset, usage links ------

describe("ChatGPT slot markup (THI-193 PR-4)", () => {
  it("login.html ships the slot hidden by default with the approved button and links", () => {
    const html = readFileSync(`${websiteDir}/login.html`, "utf8");
    expect(html).toContain('<section id="chatgpt" hidden>');
    // Approved "Continue with ChatGPT" format: official logo asset + label,
    // linking to the connect route (no hand-rolled logo).
    expect(html).toContain('href="/api/me/chatgpt/connect"');
    expect(html).toContain('src="/assets/chatgpt-logo-white.svg"');
    expect(html).toContain("Continue with ChatGPT");
    // Usage copy links to ChatGPT usage settings (UX guidelines).
    expect(html).toContain('href="https://chatgpt.com/settings/usage"');
    expect(html).toContain("usage limits apply");
    // First-connect modal copy per the guidelines.
    expect(html).toContain("You're using your ChatGPT plan");
    expect(html).toContain("Got it");
    // The overlay is display:flex, so it needs an explicit [hidden] guard —
    // otherwise the modal would render on every page load.
    expect(html).toContain("#chatgpt-modal-overlay[hidden] { display: none; }");
  });

  it("chat.html ships the hidden Using ChatGPT plan indicator with a Manage usage link", () => {
    const html = readFileSync(`${websiteDir}/chat.html`, "utf8");
    expect(html).toMatch(/id="plan-indicator"[^>]*hidden/);
    expect(html).toContain("Using ChatGPT plan");
    expect(html).toContain("Manage usage");
    expect(html).toContain('href="https://chatgpt.com/settings/usage"');
  });

  it("uses the official ChatGPT logo asset (sign-in brand guidelines), not a hand-rolled one", () => {
    const svg = readFileSync(`${websiteDir}/assets/chatgpt-logo-white.svg`, "utf8");
    // Marker from OpenAI's published asset (developers.openai.com
    // /assets/siwc/sign-in-buttons/chatgpt-logo-white.svg), copied verbatim.
    expect(svg).toContain('id="ChatGPT logo');
    expect(svg).toContain('fill="white"');
    expect(svg).toMatch(/^<svg/);
  });
});
