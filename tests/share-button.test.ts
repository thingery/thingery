// THI-396: share.js — one-tap share/copy of the canonical listing URL.
// Executes the real script against a minimal DOM shim (same pattern as the
// photos.js tests in website-security.test.ts). website-security.test.ts
// separately scans every website/*.js file for HTML-string sinks, so this
// suite only proves behavior: share-sheet, clipboard, and legacy paths.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const websiteDir = fileURLToPath(new URL("../website", import.meta.url));
const src = readFileSync(`${websiteDir}/share.js`, "utf8");

class FakeElement {
  tag: string;
  textContent = "🔗 Share";
  value = "";
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  listeners: Array<[string, unknown]> = [];
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(_name: string, _value: string) {}
  appendChild<T>(node: T): T {
    this.children.push(node as FakeElement);
    (node as FakeElement).parentNode = this;
    return node;
  }
  children: FakeElement[] = [];
  removed = false;
  remove() {
    this.removed = true;
  }
  select() {}
  addEventListener(event: string, handler: unknown) {
    this.listeners.push([event, handler]);
  }
}

/** Runs share.js with the button present; returns the button + document. */
function boot(navigator: unknown) {
  const btn = new FakeElement("button");
  btn.dataset = { shareUrl: "https://thingery.dev/item/itm-1", shareTitle: "Sony A6400" };
  const document = {
    title: "Thingery",
    getElementById: (id: string) => (id === "share-btn" ? btn : undefined),
    createElement: (tag: string) => new FakeElement(tag),
    body: new FakeElement("body"),
    execCommand: vi.fn(() => true),
  };
  const location = { href: "https://thingery.dev/browse" };
  new Function("document", "navigator", "location", src)(document, navigator, location);
  return { btn, document };
}

const click = async (btn: FakeElement): Promise<void> => {
  const handler = btn.listeners.find(([event]) => event === "click")?.[1] as () => Promise<void>;
  await handler();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("share.js (THI-396)", () => {
  it("wires the button via addEventListener (no inline handlers, no javascript: URIs)", () => {
    expect(src).not.toMatch(/javascript:/i);
    const { btn } = boot(undefined);
    expect(btn.listeners.map(([event]) => event)).toEqual(["click"]);
  });

  it("is a no-op when the button is absent (sold listings, other pages)", () => {
    const document = {
      title: "Thingery",
      getElementById: () => undefined,
      createElement: (tag: string) => new FakeElement(tag),
      body: new FakeElement("body"),
      execCommand: () => true,
    };
    expect(() => new Function("document", "navigator", "location", src)(document, {}, {})).not.toThrow();
  });

  it("uses the Web Share API with the canonical URL and title, ignoring dismissal", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const { btn } = boot({ share });
    await click(btn);
    expect(share).toHaveBeenCalledWith({
      title: "Sony A6400",
      url: "https://thingery.dev/item/itm-1",
    });
    expect(btn.textContent).toBe("🔗 Share"); // no flash after the OS sheet
    // A dismissed share sheet (rejection) must not surface an error.
    share.mockRejectedValueOnce(new Error("AbortError"));
    await expect(click(btn)).resolves.toBeUndefined();
  });

  it("copies to the clipboard when share is unavailable, then resets the label", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { btn } = boot({ clipboard: { writeText } });
    await click(btn);
    expect(writeText).toHaveBeenCalledWith("https://thingery.dev/item/itm-1");
    expect(btn.textContent).toBe("✅ Link copied");
    vi.advanceTimersByTime(2500);
    expect(btn.textContent).toBe("🔗 Share");
  });

  it("falls back to the off-screen textarea + execCommand legacy path", async () => {
    const { btn, document } = boot({});
    await click(btn);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    const ta = document.body.children[0] as FakeElement;
    expect(ta.tag).toBe("textarea");
    expect(ta.value).toBe("https://thingery.dev/item/itm-1");
    expect(ta.removed).toBe(true); // cleaned up after copying
    expect(btn.textContent).toBe("✅ Link copied");
  });

  it("falls back to the page URL when data attributes are missing", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const btn = new FakeElement("button");
    btn.dataset = {};
    const document = {
      title: "Thingery",
      getElementById: (id: string) => (id === "share-btn" ? btn : undefined),
      createElement: (tag: string) => new FakeElement(tag),
      body: new FakeElement("body"),
      execCommand: vi.fn(() => true),
    };
    new Function("document", "navigator", "location", src)(document, { clipboard: { writeText } }, {
      href: "https://thingery.dev/browse",
    });
    await click(btn);
    expect(writeText).toHaveBeenCalledWith("https://thingery.dev/browse");
  });
});
