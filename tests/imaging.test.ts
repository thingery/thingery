// THI-308 PR 3: unit tests for website/imaging.js — the pure client-side
// compression helpers (quality ladder, size thresholds, GIF pass-through,
// downscale math). imaging.js is a plain browser script; we execute the real
// source and exercise its exported helpers, no DOM needed (compressImage's
// canvas path is exercised in browsers; its pass-through/decode-failure
// fallbacks are testable here because they short-circuit before any DOM use).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const imagingSrc = readFileSync(fileURLToPath(new URL("../website/imaging.js", import.meta.url)), "utf8");
new Function(imagingSrc)();
const imaging = (globalThis as { ThingeryImaging: Record<string, (...args: unknown[]) => unknown> }).ThingeryImaging;

const KB = 1024;
const gif = { type: "image/gif", name: "dance.gif" };
const jpeg = { type: "image/jpeg", name: "snap.jpg" };

describe("imaging.js quality ladder", () => {
  it("starts at q0.8 and steps down 0.8 → 0.6 → 0.45 → floor", () => {
    expect(imaging.QUALITY_LADDER).toEqual([0.8, 0.6, 0.45]);
    expect(imaging.initialQuality()).toBe(0.8);
    expect(imaging.nextQuality(0.8)).toBe(0.6);
    expect(imaging.nextQuality(0.6)).toBe(0.45);
    expect(imaging.nextQuality(0.45)).toBeNull();
    expect(imaging.nextQuality(0.33)).toBeNull(); // unknown quality → floor
  });
});

describe("imaging.js size thresholds", () => {
  it("flags blobs strictly over the ~500 KB budget", () => {
    expect(imaging.SIZE_BUDGET_BYTES).toBe(500 * KB);
    expect(imaging.isOverBudget({ size: 500 * KB })).toBe(false);
    expect(imaging.isOverBudget({ size: 500 * KB + 1 })).toBe(true);
  });
});

describe("imaging.js targetDimensions", () => {
  it("downscales to ≤1600 px long edge, aspect preserved, portrait and landscape", () => {
    expect(imaging.targetDimensions(3200, 2400)).toEqual({ width: 1600, height: 1200 });
    expect(imaging.targetDimensions(2400, 3200)).toEqual({ width: 1200, height: 1600 });
  });
  it("never upscales and leaves already-small images untouched", () => {
    expect(imaging.targetDimensions(1600, 900)).toEqual({ width: 1600, height: 900 });
    expect(imaging.targetDimensions(800, 600)).toEqual({ width: 800, height: 600 });
  });
  it("returns null for invalid dimensions", () => {
    expect(imaging.targetDimensions(0, 100)).toBeNull();
    expect(imaging.targetDimensions(-5, 100)).toBeNull();
    expect(imaging.targetDimensions(NaN, 100)).toBeNull();
  });
});

describe("imaging.js shouldPassThrough", () => {
  it("passes GIFs through untouched (server stores stills)", () => {
    expect(imaging.shouldPassThrough(gif)).toBe(true);
    expect(imaging.shouldPassThrough({ type: "", name: "LOOP.GIF" })).toBe(true); // name fallback
    expect(imaging.shouldPassThrough(jpeg)).toBe(false);
    expect(imaging.shouldPassThrough({ type: "image/png", name: "p.png" })).toBe(false);
  });
});

describe("imaging.js compressImage fallbacks", () => {
  afterEach(() => {
    delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  });

  it("returns GIF files untouched without attempting a decode", async () => {
    const result = await imaging.compressImage(gif);
    expect(result).toBe(gif); // same object — bytes never touched client-side
  });

  it("returns the original file when decoding fails (the server stays the enforcer)", async () => {
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = vi.fn(() =>
      Promise.reject(new Error("decode unsupported")),
    );
    const result = await imaging.compressImage(jpeg);
    expect(result).toBe(jpeg);
  });
});
