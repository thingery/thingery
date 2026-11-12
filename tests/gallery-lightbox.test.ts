// gallery.js wiring tests (THI-678, fixes THI-677): the item-page lightbox
// is a CSP-safe static script (no inline handlers — tests/website-security
// .test.ts already scans public/*.js for HTML-string sinks file-wide), so
// the interactions are verified here against a minimal DOM shim shaped
// exactly like the markup itemPage() renders (src/web-pages.ts):
// #item-gallery [hero(data-idx=0) > img, strip > thumb(data-idx=i) > img]
// and #item-lightbox [.lb-close/.lb-prev/.lb-img/.lb-next/.lb-count].
// Acceptance (issue THI-678): open on any photo, prev/next with wrap-around,
// close via button / Esc / backdrop, counter "2 / 5", single-photo pages
// hide the arrows, zero-photo pages ship no gallery script at all.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const galleryJs = readFileSync(
  fileURLToPath(new URL("../public/gallery.js", import.meta.url)),
  "utf8",
);

/** Minimal element shim: attribute map, class set, listener registry, focus
 *  tracking, and a class/tag querySelector covering what gallery.js uses. */
class El {
  tag: string;
  attrs: Record<string, string> = {};
  classes = new Set<string>();
  listeners: Record<string, Array<(event: unknown) => void>> = {};
  hidden = false;
  textContent = "";
  focusCalls = 0;
  children: El[] = [];
  constructor(tag: string, cls = "") {
    this.tag = tag;
    if (cls) {
      this.attrs["class"] = cls;
      this.classes.add(cls);
    }
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  removeAttribute(name: string) {
    delete this.attrs[name];
  }
  addEventListener(event: string, handler: (event: unknown) => void) {
    (this.listeners[event] ??= []).push(handler);
  }
  /** Dispatch: click(ev?) / key(ev) — handlers run in registration order. */
  dispatch(event: string, ev: Record<string, unknown> = {}) {
    for (const handler of this.listeners[event] ?? []) handler(ev);
  }
  focus() {
    this.focusCalls++;
  }
  get classList() {
    const self = this;
    return {
      add: (c: string) => self.classes.add(c),
      remove: (c: string) => self.classes.delete(c),
      contains: (c: string) => self.classes.has(c),
    };
  }
  matches(selector: string): boolean {
    if (selector.startsWith(".")) return this.classes.has(selector.slice(1));
    if (selector.startsWith("[")) {
      const attr = selector.slice(1, -1); // "[data-idx]" → presence check
      return attr in this.attrs;
    }
    return this.tag === selector;
  }
  querySelector(selector: string): El | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deep = child.querySelector(selector);
      if (deep) return deep;
    }
    return null;
  }
  querySelectorAll(selector: string): El[] {
    const found: El[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
}

/** Builds the item-page DOM (3 photos) and runs gallery.js against it. */
function mount(photoCount = 3) {
  const urls = Array.from({ length: photoCount }, (_, i) => `/img/items/photo-${i + 1}.jpg`);
  const triggers: El[] = [];
  const gallery = new El("div", "item-gallery");
  const hero = new El("button", "gallery-hero");
  hero.setAttribute("data-idx", "0");
  const heroImg = new El("img");
  heroImg.setAttribute("src", urls[0]);
  heroImg.setAttribute("alt", "A camera");
  hero.children.push(heroImg);
  gallery.children.push(hero);
  triggers.push(hero);
  if (photoCount > 1) {
    const strip = new El("div", "gallery-strip");
    for (let i = 1; i < photoCount; i++) {
      const thumb = new El("button", "gallery-thumb");
      thumb.setAttribute("data-idx", String(i));
      const img = new El("img");
      img.setAttribute("src", urls[i]);
      img.setAttribute("alt", "A camera");
      thumb.children.push(img);
      strip.children.push(thumb);
      triggers.push(thumb);
    }
    gallery.children.push(strip);
  }

  const mk = (cls: string, tag = "button") => new El(tag, cls);
  const closeBtn = mk("lb-close");
  const prevBtn = mk("lb-prev");
  const nextBtn = mk("lb-next");
  const lbImg = mk("lb-img", "img");
  const count = mk("lb-count", "p");
  const lightbox = new El("div", "lightbox");
  lightbox.hidden = true; // server renders the dialog hidden until opened
  lightbox.children.push(closeBtn, prevBtn, lbImg, nextBtn, count);

  const byId = new Map<string, El>([
    ["item-gallery", gallery],
    ["item-lightbox", lightbox],
  ]);
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    addEventListener(event: string, handler: (event: unknown) => void) {
      (doc.listeners[event] ??= []).push(handler);
    },
    listeners: {} as Record<string, Array<(event: unknown) => void>>,
    body: new El("body"),
    activeElement: null as El | null,
  };

  new Function("document", galleryJs)(doc);
  return { doc, gallery, lightbox, triggers, closeBtn, prevBtn, nextBtn, lbImg, count, urls };
}

describe("gallery.js lightbox wiring (THI-678)", () => {
  it("contains no javascript: URIs (CSP hygiene, mirrors the photos.js rule)", () => {
    expect(galleryJs).not.toMatch(/javascript:/i);
  });

  it("is a no-op when the page renders no lightbox (zero-photo pages)", () => {
    const listeners: Array<[string, unknown]> = [];
    const doc = {
      getElementById: () => null,
      addEventListener: (event: string, handler: unknown) => listeners.push([event, handler]),
      listeners: {},
      body: new El("body"),
      activeElement: null,
    };
    expect(() => new Function("document", galleryJs)(doc)).not.toThrow();
    expect(listeners).toEqual([]); // no keydown listener without a lightbox
  });

  it("opens on any thumbnail: shows that photo, the counter, locks scroll, focuses close", () => {
    const { doc, triggers, lightbox, lbImg, count, closeBtn } = mount();
    triggers[1].dispatch("click"); // strip thumbnail → photo 2 of 3
    expect(lightbox.hidden).toBe(false);
    expect(lbImg.getAttribute("src")).toBe("/img/items/photo-2.jpg");
    expect(lbImg.getAttribute("alt")).toBe("A camera");
    expect(count.textContent).toBe("2 / 3");
    expect(doc.body.classList.contains("lb-lock")).toBe(true);
    expect(closeBtn.focusCalls).toBe(1);
  });

  it("steps prev/next with wrap-around and mirrors the position onto the strip", () => {
    const { triggers, nextBtn, prevBtn, count } = mount();
    triggers[0].dispatch("click");
    expect(count.textContent).toBe("1 / 3");
    expect(triggers[0].getAttribute("aria-current")).toBe("true");
    nextBtn.dispatch("click");
    expect(count.textContent).toBe("2 / 3");
    expect(triggers[1].getAttribute("aria-current")).toBe("true");
    nextBtn.dispatch("click");
    expect(count.textContent).toBe("3 / 3");
    nextBtn.dispatch("click"); // wraps
    expect(count.textContent).toBe("1 / 3");
    prevBtn.dispatch("click"); // wraps back
    expect(count.textContent).toBe("3 / 3");
  });

  it("closes via the button: hides, unlocks scroll, drops the bitmap, restores focus", () => {
    const { doc, triggers, lightbox, lbImg, closeBtn } = mount();
    doc.activeElement = triggers[1];
    triggers[1].dispatch("click");
    closeBtn.dispatch("click");
    expect(lightbox.hidden).toBe(true);
    expect(doc.body.classList.contains("lb-lock")).toBe(false);
    expect(lbImg.getAttribute("src")).toBeNull(); // removeAttribute, not src=""
    expect(triggers[1].focusCalls).toBe(1); // focus returns to the opener
  });

  it("closes on Escape and steps on arrow keys (document keydown)", () => {
    const { doc, triggers, lightbox, count } = mount();
    // Keydown before opening is ignored.
    doc.listeners.keydown.forEach((h) => h({ key: "ArrowRight" }));
    expect(lightbox.hidden).toBe(true);
    triggers[0].dispatch("click");
    doc.listeners.keydown.forEach((h) => h({ key: "ArrowRight" }));
    expect(count.textContent).toBe("2 / 3");
    doc.listeners.keydown.forEach((h) => h({ key: "ArrowLeft" }));
    expect(count.textContent).toBe("1 / 3");
    doc.listeners.keydown.forEach((h) => h({ key: "Escape" }));
    expect(lightbox.hidden).toBe(true);
  });

  it("closes on a backdrop click but not when the photo itself is clicked", () => {
    const { lightbox, lbImg } = mount();
    // Simulate the open state, then click the overlay itself vs the image.
    lightbox.hidden = false;
    lightbox.dispatch("click", { target: lightbox });
    expect(lightbox.hidden).toBe(true); // backdrop closed it
    lightbox.hidden = false;
    lightbox.dispatch("click", { target: lbImg });
    expect(lightbox.hidden).toBe(false); // photo click stays open
  });

  it("hides the prev/next arrows on single-photo items", () => {
    const { triggers, nextBtn, prevBtn, count } = mount(1);
    triggers[0].dispatch("click");
    expect(count.textContent).toBe("1 / 1");
    expect(prevBtn.hidden).toBe(true);
    expect(nextBtn.hidden).toBe(true);
  });
});
