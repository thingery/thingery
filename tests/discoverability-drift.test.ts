// THI-842: discoverability drift pins. public/llms.txt and
// public/.well-known/agents.json are hand-maintained — nothing regenerates
// them (`docs:tools` only rebuilds the docs site), so a new MCP tool can ship
// invisible to every discoverability surface. That was THI-814 finding F1
// (draft_listing shipped missing from both; buy_shipping_label and several
// later tools drifted the same way until this test landed). Both files are
// pinned here against the registered tool set (TOOL_NAMES, src/mcp-gate.ts)
// and the auth lanes pinned in src/tools.ts (PROTECTED_TOOLS,
// SESSION_ONLY_TOOLS), same exact-set posture as tests/tool-docs.test.ts and
// tests/protected-tools.test.ts: adding a tool without updating the surfaces
// fails CI, and so does removing a surface line.
//
// Scope: the externally discoverable surface = every registered tool except
// SESSION_ONLY_TOOLS — the first-party account-settings tools register only
// for a thgs_ login-session bearer and are not advertised to external agents
// (the same exclusion tests/mcp-directory-profile.test.ts applies).
//
// llms.txt documents tools across topical sections ("## MCP tools",
// "## Buyer alerts", "## Wanted board", "## Order flow", "## Account"),
// so the pin is file-wide: every discoverable tool exactly once, with an
// auth label matching the src lane — (public) for the anonymous lane,
// (auth)/(auth, buyer)/(seller auth) for the 401-challenge lane.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/mcp-gate.js";
import { PROTECTED_TOOLS, SESSION_ONLY_TOOLS, registerTools } from "../src/tools.js";

const llmsTxt = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
const agentsJson = JSON.parse(
  readFileSync(new URL("../public/.well-known/agents.json", import.meta.url), "utf8"),
) as {
  capabilities: Array<{
    type: string;
    auth: { required_for: string[] };
    public_tools: string[];
    seller_tools: string[];
    required_for: string[];
    order_tools: Record<string, string>;
    buyer_alert_tools: Record<string, string>;
    wanted_tools: Record<string, string>;
    notification_tools: Record<string, string>;
    address_tools: Record<string, string>;
  }>;
};

const sorted = (names: Iterable<string>) => [...names].sort().join("\n");

/** Live registration capture — the tool-annotations test pattern. Keeps the
 *  lanes below honest if the src pins and registerTools ever diverge. */
function registeredTools(): Set<string> {
  const registered = new Set<string>();
  registerTools(
    {
      registerTool(name: string) {
        registered.add(name);
      },
    },
    // A login-session context registers every tool, session-only included.
    { seller: { id: "11111111-1111-4111-8111-111111111111", display_name: "Web User" }, credential: "session" },
  );
  return registered;
}

/** Anonymous lane: registered, not 401-challenged, not session-only. */
const ANONYMOUS_TOOLS = new Set(
  [...TOOL_NAMES].filter((n) => !PROTECTED_TOOLS.has(n) && !SESSION_ONLY_TOOLS.has(n)),
);
/** The 401-challenge (seller/account) lane, pinned in src/tools.ts. */
const SELLER_TOOLS = PROTECTED_TOOLS;
/** Everything an external agent can discover (session-only excluded). */
const DISCOVERABLE_TOOLS = new Set([...TOOL_NAMES].filter((n) => !SESSION_ONLY_TOOLS.has(n)));

/** llms.txt tool bullets: `- `name` (auth label): …` in every section. */
function llmsToolBullets(): Array<{ name: string; label: string }> {
  return [...llmsTxt.matchAll(/^- `([a-z_]+)` \(([^)]*)\):/gm)].map((m) => ({ name: m[1], label: m[2] }));
}

function mcpCapability() {
  const cap = agentsJson.capabilities.find((c) => c.type === "mcp");
  if (!cap) throw new Error("agents.json has no { type: \"mcp\" } capability");
  return cap;
}

describe("registry lanes (src/mcp-gate.ts + src/tools.ts pins)", () => {
  it("live registration matches the TOOL_NAMES pin", () => {
    expect(sorted(registeredTools())).toBe(sorted(TOOL_NAMES));
  });

  it("anonymous/seller/session lanes partition TOOL_NAMES", () => {
    const union = new Set([...ANONYMOUS_TOOLS, ...SELLER_TOOLS, ...SESSION_ONLY_TOOLS]);
    expect(sorted(union)).toBe(sorted(TOOL_NAMES)); // complete, no unknowns
    expect(ANONYMOUS_TOOLS.size + SELLER_TOOLS.size + SESSION_ONLY_TOOLS.size).toBe(union.size); // disjoint
    expect(ANONYMOUS_TOOLS.size).toBeGreaterThan(0);
  });
});

describe("public/llms.txt vs the registered tool set", () => {
  it("documents every discoverable tool exactly once, with no stale entries", () => {
    const names = llmsToolBullets().map((b) => b.name);
    expect(new Set(names).size, "duplicate tool bullet in llms.txt").toBe(names.length);
    const unknown = names.filter((n) => !DISCOVERABLE_TOOLS.has(n));
    expect(unknown, "llms.txt lists tools that are not registered").toEqual([]);
    // Missing coverage fails here with a sorted diff — e.g. a new tool that
    // never got an llms.txt bullet (the THI-814 F1 failure mode).
    expect(sorted(names), "llms.txt tool bullets vs the discoverable registered set").toBe(
      sorted(DISCOVERABLE_TOOLS),
    );
  });

  it("labels auth posture per bullet exactly as pinned in src/tools.ts", () => {
    for (const { name, label } of llmsToolBullets()) {
      if (ANONYMOUS_TOOLS.has(name)) {
        expect(label, `${name} is anonymous in src/tools.ts and must be labelled (public)`).toBe("public");
      } else {
        expect(label, `${name} is 401-challenged in src/tools.ts and must carry an (auth…)/(seller auth) label`).toMatch(
          /^(auth|seller auth)/,
        );
      }
    }
  });

  it("keeps the ## MCP tools section", () => {
    expect(llmsTxt).toMatch(/^## MCP tools$/m);
  });
});

describe("public/.well-known/agents.json vs the registered tool set", () => {
  it("public_tools is exactly the anonymous lane", () => {
    expect(sorted(mcpCapability().public_tools)).toBe(sorted(ANONYMOUS_TOOLS));
  });

  it("required_for is exactly the 401-challenge (seller) lane", () => {
    expect(sorted(mcpCapability().required_for)).toBe(sorted(SELLER_TOOLS));
  });

  it("auth.required_for is exactly the 401-challenge (seller) lane", () => {
    expect(sorted(mcpCapability().auth.required_for)).toBe(sorted(SELLER_TOOLS));
  });

  it("seller_tools is a curated subset of the seller lane, covered by both required_for arrays", () => {
    const cap = mcpCapability();
    expect(new Set(cap.seller_tools).size).toBe(cap.seller_tools.length);
    const strays = cap.seller_tools.filter((n) => !SELLER_TOOLS.has(n));
    expect(strays, "seller_tools entries must be 401-challenged in src/tools.ts").toEqual([]);
    for (const name of cap.seller_tools) {
      expect(cap.required_for, `seller tool ${name} missing from required_for`).toContain(name);
      expect(cap.auth.required_for, `seller tool ${name} missing from auth.required_for`).toContain(name);
    }
  });

  it("group maps describe each discoverable tool once, in the right lane", () => {
    const cap = mcpCapability();
    const groups: Array<[string, string[]]> = [
      ["seller_tools", cap.seller_tools],
      ["order_tools", Object.keys(cap.order_tools)],
      ["buyer_alert_tools", Object.keys(cap.buyer_alert_tools)],
      ["wanted_tools", Object.keys(cap.wanted_tools)],
      ["notification_tools", Object.keys(cap.notification_tools)],
      ["address_tools", Object.keys(cap.address_tools)],
    ];
    for (const [group, names] of groups) {
      for (const name of names) {
        expect(DISCOVERABLE_TOOLS.has(name), `${group} names unregistered tool ${name}`).toBe(true);
        if (group !== "wanted_tools") {
          // wanted_tools mixes public reads with account-gated writes; every
          // other group is account-gated by construction.
          expect(SELLER_TOOLS.has(name), `${group} entry ${name} must be in the seller lane`).toBe(true);
        }
      }
    }
    // Each seller-lane tool is described by exactly one group map: removing
    // its only group entry fails here, double-listing it fails too.
    const seen = new Map<string, string>();
    for (const [group, names] of groups) {
      for (const name of names) {
        if (!SELLER_TOOLS.has(name)) continue;
        expect(seen.has(name), `${name} is described by both ${seen.get(name)} and ${group}`).toBe(false);
        seen.set(name, group);
      }
    }
    const missing = [...SELLER_TOOLS].filter((n) => !seen.has(n));
    expect(missing, "seller-lane tools missing from every agents.json group map").toEqual([]);
    // Public tools may appear in at most one group map (search_wanted and
    // get_wanted live in wanted_tools); public_tools is their lane list.
    const publicSeen = groups.flatMap(([, names]) => names).filter((n) => ANONYMOUS_TOOLS.has(n));
    expect(new Set(publicSeen).size).toBe(publicSeen.length);
  });
});
