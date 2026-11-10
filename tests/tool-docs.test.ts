// The docs site's tool reference is generated from the tool registry. This fails when a tool
// changes without regenerating the pages (npm run docs:tools), or when a new tool is not
// assigned to a page. Pure registration test — no DB needed.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectTools, renderToolPages, TOOL_PAGES } from "../scripts/gen-tool-docs.js";

describe("docs site tool reference", () => {
  it("documents every registered tool exactly once", () => {
    const documented = TOOL_PAGES.flatMap((page) => page.tools);
    expect([...documented].sort()).toEqual([...collectTools().keys()].sort());
    expect(new Set(documented).size).toBe(documented.length);
  });

  it("matches the committed pages; run npm run docs:tools after changing a tool", () => {
    for (const [path, expected] of renderToolPages()) {
      expect(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), path).toBe(expected);
    }
  });
});
