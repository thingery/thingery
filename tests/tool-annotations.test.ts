// THI-296 AC5 anti-drift test: MCP tool annotations must match the audited
// behavior table (spec doc `spec-mcp-tool-annotations` on THI-296, Security
// verdict THI-297 — release_funds destructiveHint=true is its required
// change). OpenAI's plugin portal imports these hints at Scan Tools; any
// future tool or annotation drift must fail CI here rather than reach the
// registry with mismatched metadata. Pure registration test — no DB needed.

import { describe, expect, it } from "vitest";
import { registerTools } from "../src/tools.js";

// Frozen expected map — update this table ONLY via a reviewed spec change,
// never casually: it is the machine-readable copy of the audit table.
const EXPECTED: Record<
  string,
  { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
> = {
  describe_category: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search_items: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_item: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  my_listings: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_order: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_payout_setup: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  create_listing: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  add_item_image: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  update_listing: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  create_order: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  cancel_order: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  record_tracking: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  confirm_payment: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  confirm_receipt: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  open_dispute: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  release_funds: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

const READ_TOOLS = new Set(Object.entries(EXPECTED).filter(([, a]) => a.readOnlyHint).map(([n]) => n));

interface Captured {
  config: { annotations?: Record<string, boolean>; title?: string };
}

const registered = new Map<string, Captured>();
registerTools(
  {
    registerTool(name: string, config: Captured["config"]) {
      registered.set(name, { config });
    },
  },
  { seller: null },
);

describe("MCP tool annotations (THI-296 AC5 audit table)", () => {
  it("registers exactly the audited tool set", () => {
    expect([...registered.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("every tool carries all four annotation hints (no silent defaults)", () => {
    for (const [name, { config }] of registered) {
      const a = config.annotations;
      expect(a, `${name} must carry annotations`).toBeDefined();
      for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof a![key], `${name}.${key} must be an explicit boolean`).toBe("boolean");
      }
    }
  });

  it("annotations match the frozen expected map (anti-drift)", () => {
    for (const [name, { config }] of registered) {
      expect(config.annotations).toEqual(EXPECTED[name]);
    }
  });

  it("consistency: readOnlyHint true only inside the audited read set", () => {
    for (const [name, { config }] of registered) {
      if (config.annotations?.readOnlyHint) {
        expect(READ_TOOLS.has(name), `${name} is readOnlyHint but not in the audited read set`).toBe(true);
      }
    }
  });

  it("every tool carries a human title", () => {
    for (const [name, { config }] of registered) {
      expect(typeof config.title, `${name} title`).toBe("string");
      expect((config.title ?? "").length, `${name} title non-empty`).toBeGreaterThan(0);
    }
  });
});
