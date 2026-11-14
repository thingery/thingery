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
// THI-769 added the `title` strings: the Claude Connectors Directory review
// criteria require annotations.title on every tool, mirrored from the
// tool-level title (spec: THI-769 issue description, rev 248fdf25).
const EXPECTED: Record<
  string,
  { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
> = {
  describe_category: { title: "Describe category", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search_items: { title: "Search second-hand listings", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_item: { title: "Get item details", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  my_listings: { title: "My listings", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_order: { title: "Get order", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Disclosing the address cannot be undone, hence destructiveHint; replays are no-ops.
  share_shipping_address: { title: "Share shipping address", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  my_orders: { title: "My orders", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_payout_setup: { title: "Get payout setup", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  create_listing: { title: "Create a listing", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  add_item_image: { title: "Add item image", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  update_listing: { title: "Update listing", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  create_order: { title: "Create order", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  cancel_order: { title: "Cancel order", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  record_tracking: { title: "Record tracking", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // THI-568 (label-purchase spec): spends platform money, but destroys nothing;
  // a same-args replay on a label_issued order returns the stored label
  // without a second purchase, hence idempotentHint.
  buy_shipping_label: { title: "Buy shipping label", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  confirm_payment: { title: "Confirm payment", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  confirm_receipt: { title: "Confirm receipt", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  open_dispute: { title: "Open dispute", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  release_funds: { title: "Release funds", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // THI-567 (order messaging): sending a message is a plain write (it
  // creates, deletes nothing); list_order_messages is a pure read of the
  // caller's own thread — same posture as my_orders.
  send_order_message: { title: "Send order message", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  list_order_messages: { title: "List order messages", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // THI-360 spec rev 2 PR 2 (buyer alerts): my_intents is a pure read;
  // save/update are plain writes; delete_intent removes the intent and its
  // match records — destructiveHint, same posture as cancel_order.
  save_intent: { title: "Save search intent (buyer alert)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  my_intents: { title: "My saved search intents", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  update_intent: { title: "Mute or unmute a saved intent", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  delete_intent: { title: "Delete a saved intent", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // THI-360 spec rev 2 PR 4: my_matches reads the match inbox but
  // mark_read stamps read_at — not a pure read, so no readOnlyHint; it
  // deletes nothing (retention sweeps own expiry), so no destructiveHint.
  my_matches: { title: "New listing matches (buyer alerts)", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // THI-439 (B4, PR 3): respond_to_wanted mints a real listing (plain
  // write, not destructive — it creates) and links it to the wanted.
  respond_to_wanted: { title: "Respond to a wanted listing", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // Public wanted-board reads: same posture as search_items / get_item.
  search_wanted: { title: "Search wanted posts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_wanted: { title: "Get wanted post", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Buyer-side wanted tools: my_wanted is a pure read; expire_wanted ends a
  // live public post, so it carries destructiveHint like cancel_order.
  create_wanted: { title: "Create wanted post", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  my_wanted: { title: "My wanted posts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  update_wanted: { title: "Update wanted post", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  expire_wanted: { title: "Expire wanted post", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  renew_wanted: { title: "Renew wanted post", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

// Session-only tools (registered for the first-party web session alone, so
// absent from the anonymous registration below and from the plugin portal's
// scan). Revoking ends an app's access: destructive, and a repeat changes
// nothing more.
const SESSION_ONLY_EXPECTED: typeof EXPECTED = {
  list_connected_apps: { title: "List connected apps", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  revoke_connected_app: { title: "Disconnect app", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  get_api_key_info: { title: "Get API key info", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const READ_TOOLS = new Set(Object.entries(EXPECTED).filter(([, a]) => a.readOnlyHint).map(([n]) => n));

interface Captured {
  config: { annotations?: Record<string, boolean | string>; title?: string };
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

  // THI-769: the directory portal flags tools whose annotations lack a
  // title; the annotation string must mirror the tool-level title exactly,
  // and both stay ≤64 chars (Anthropic review criteria).
  it("every tool carries a human title ≤64 chars, mirrored into annotations.title (THI-769)", () => {
    for (const [name, { config }] of registered) {
      expect(typeof config.title, `${name} title`).toBe("string");
      const title = config.title ?? "";
      expect(title.length, `${name} title non-empty`).toBeGreaterThan(0);
      expect(title.length, `${name} title within 64 chars`).toBeLessThanOrEqual(64);
      expect(title, `${name} title matches the frozen table`).toBe(EXPECTED[name].title);
      expect(config.annotations?.title, `${name} annotations.title mirrors the tool title`).toBe(title);
    }
  });
});

describe("session-only tool annotations", () => {
  const sessionRegistered = new Map<string, Captured>();
  registerTools(
    {
      registerTool(name: string, config: Captured["config"]) {
        sessionRegistered.set(name, { config });
      },
    },
    { seller: { id: "11111111-1111-4111-8111-111111111111", display_name: "Web User" }, credential: "session" },
  );

  it("adds exactly the session-only tools to the audited set", () => {
    const extra = [...sessionRegistered.keys()].filter((name) => !(name in EXPECTED));
    expect(extra.sort()).toEqual(Object.keys(SESSION_ONLY_EXPECTED).sort());
  });

  it("annotations and titles match (title mirrored into annotations, ≤64 chars — THI-769)", () => {
    for (const [name, expected] of Object.entries(SESSION_ONLY_EXPECTED)) {
      const config = sessionRegistered.get(name)!.config;
      expect(config.annotations).toEqual(expected);
      expect(config.title, `${name} title matches the frozen table`).toBe(expected.title);
      expect(config.annotations?.title).toBe(config.title);
      expect((config.title ?? "").length).toBeGreaterThan(0);
      expect((config.title ?? "").length).toBeLessThanOrEqual(64);
    }
  });
});
