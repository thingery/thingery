// Unit tests for build metadata (THI-68): version comes from package.json,
// commit/buildTime come from a build-time build-info.json with an explicit
// "unknown" fallback — never a runtime git call.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD, COMMIT, BUILD_TIME, VERSION, readBuildInfo } from "../src/version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgVersion = (JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as {
  version: string;
}).version;

describe("VERSION", () => {
  it("matches package.json", () => {
    expect(VERSION).toBe(pkgVersion);
  });
});

describe("readBuildInfo", () => {
  it("returns the baked commit and buildTime when build-info.json exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "thingery-buildinfo-"));
    try {
      writeFileSync(
        path.join(dir, "build-info.json"),
        JSON.stringify({ commit: "a1b2c3d4e5f6", buildTime: "2026-10-13T12:00:00Z" }),
      );
      expect(readBuildInfo(dir)).toEqual({ commit: "a1b2c3d4e5f6", buildTime: "2026-10-13T12:00:00Z" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to unknown when build-info.json is missing (dev / npm install)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "thingery-buildinfo-"));
    try {
      expect(readBuildInfo(dir)).toEqual({ commit: "unknown", buildTime: "unknown" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to unknown on malformed JSON or non-string fields", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "thingery-buildinfo-"));
    try {
      writeFileSync(path.join(dir, "build-info.json"), "{ not json");
      expect(readBuildInfo(dir)).toEqual({ commit: "unknown", buildTime: "unknown" });

      writeFileSync(path.join(dir, "build-info.json"), JSON.stringify({ commit: 42, buildTime: "" }));
      expect(readBuildInfo(dir)).toEqual({ commit: "unknown", buildTime: "unknown" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("BUILD exports (module dir has no build-info.json in the repo)", () => {
  it("defaults to unknown in dev/test, and always exposes strings", () => {
    expect(typeof COMMIT).toBe("string");
    expect(typeof BUILD_TIME).toBe("string");
    expect(BUILD).toEqual({ commit: COMMIT, buildTime: BUILD_TIME });
  });
});
