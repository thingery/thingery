// THI-141 — meta-test guarding the .test-d.ts typecheck wiring against
// fail-open drift (Security finding N1 from the THI-138 review of PR #75).
//
// vitest's `typecheck.include` globs tests/**/*.test-d.ts, while the tsconfig
// it typechecks with (tsconfig.typecheck.json) deliberately lists only the
// tsc-clean test files (the main tsconfig excludes tests/, and globbing all of
// tests/ there would drag ~20 pre-existing type errors into the gate). A
// .test-d.ts file matched by the vitest glob but missing from that tsconfig is
// never seen by tsc, and runtime `expectTypeOf` is a no-op without a
// typechecker — so the file "passes" vacuously and a type pin can be added and
// believed to hold while enforcing nothing.
//
// This test fails loudly the moment that happens. The long-term fix is
// migrating the remaining tests/ files to typecheck-clean and globbing both
// sides; this guard stays correct after that migration because tsconfig
// patterns are matched, not compared literally.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import vitestConfig from "../vitest.config";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal glob → RegExp for tsconfig/vitest include patterns (`*`, `**`). */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&") // escape regex specials except *
    .replace(/\*\*\//g, "(?:.*/)?") // **/ matches zero or more directories
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*"); // a single * must not cross directory boundaries
  return new RegExp(`^${source}$`);
}

function matchesPattern(file: string, pattern: string): boolean {
  if (!pattern.includes("*")) return file === pattern;
  return globToRegExp(pattern).test(file);
}

/** All .test-d.ts files under tests/, as repo-relative POSIX paths. */
function listTestDFilesOnDisk(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test-d.ts"))
        found.push(path.relative(repoRoot, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(repoRoot, "tests"));
  return found.sort();
}

/** include + files entries of the tsconfig vitest typechecks with (JSONC-tolerant). */
function tsconfigPatterns(tsconfigPath: string): string[] {
  const raw = readFileSync(path.resolve(repoRoot, tsconfigPath), "utf8")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line)) // strip full-line comments
    .join("\n");
  const parsed: { include?: string[]; files?: string[] } = JSON.parse(raw);
  return [...(parsed.include ?? []), ...(parsed.files ?? [])];
}

describe("typecheck wiring (THI-141)", () => {
  const typecheck = vitestConfig.test?.typecheck;

  it("vitest typecheck mode is enabled for .test-d.ts files", () => {
    // If typecheck is disabled, every expectTypeOf pin becomes a runtime no-op.
    expect(typecheck?.enabled, "vitest typecheck.enabled must stay true").toBe(true);
  });

  it("every .test-d.ts on disk is typechecked — no vacuous passes", () => {
    // Sanity-anchor the walk: prove we resolved the repo root, not some
    // unrelated directory whose empty tests/ would make this test vacuous.
    expect(existsSync(path.join(repoRoot, "package.json")), `repoRoot resolved to ${repoRoot}`).toBe(true);

    const onDisk = listTestDFilesOnDisk();

    // Guard 1: the vitest typecheck glob must still collect every file on disk.
    const vitestInclude = typecheck?.include ?? [];
    const notCollected = onDisk.filter(
      (file) => !vitestInclude.some((pattern) => matchesPattern(file, pattern)),
    );
    expect(
      notCollected,
      `${notCollected.join(", ")} — matched by no vitest typecheck.include pattern. ` +
        "Update typecheck.include in vitest.config.ts so vitest's typechecker sees the file.",
    ).toEqual([]);

    // Guard 2: the scoped tsconfig must list (or glob) every file on disk.
    // A file the vitest glob collects but tsc never typechecks runs as a
    // vacuous pass: runtime expectTypeOf is a no-op without a typechecker.
    const tsconfigPath = typecheck?.tsconfig ?? "tsconfig.json";
    const listed = tsconfigPatterns(tsconfigPath);
    const unlisted = onDisk.filter(
      (file) => !listed.some((pattern) => matchesPattern(file, pattern)),
    );
    expect(
      unlisted,
      `${unlisted.join(", ")} — on disk but not covered by ${tsconfigPath}. ` +
        "vitest typecheck.include collects it, yet tsc never sees it, so its expectTypeOf " +
        "pins pass vacuously (runtime no-op) and enforce nothing. Add the file to the " +
        `"include" array in ${tsconfigPath} (or glob it once tests/ is typecheck-clean).`,
    ).toEqual([]);
  });
});
