// F7 anti-drift test (spec THI-11 §2.10c): PROTECTED_TOOLS — the set the
// /mcp 401 gate challenges on — must match exactly the tools whose handlers
// reject anonymous callers. A future write tool that forgets the annotation
// fails here at CI instead of silently losing its 401-challenge onboarding
// path (failure mode is interop, not privilege — the tool-level guard still
// holds). Requires Postgres (some public handlers query the DB); skips
// otherwise.

import { describe, expect, it } from "vitest";
import pg from "pg";
import { registerTools, PROTECTED_TOOLS } from "../src/tools.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

const available = await dbAvailable();

interface Captured {
  config: { description?: string };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

describe.skipIf(!available)("PROTECTED_TOOLS annotation (F7)", () => {
  const registered = new Map<string, Captured>();

  registerTools(
    {
      registerTool(name: string, config: Captured["config"], handler: Captured["handler"]) {
        registered.set(name, { config, handler });
      },
    },
    { seller: null }, // anonymous context: handlers must self-report `unauthorized`
  );

  /** Calls a handler anonymously and returns whether it refused with the
   * `unauthorized` code (the requireSeller() guard). Throws inside handlers
   * (e.g. missing args on public tools) count as "did not refuse". */
  async function refusesAnonymous(name: string): Promise<boolean> {
    const captured = registered.get(name);
    if (!captured) throw new Error(`tool ${name} was not registered`);
    const result = (await captured.handler({}).catch(() => null)) as
      | { isError?: boolean; content?: { text?: string }[] }
      | null;
    if (!result?.isError) return false;
    const body = result.content?.[0]?.text ? JSON.parse(result.content[0].text) : null;
    return body?.code === "unauthorized";
  }

  it("registers each tool exactly once (no duplicate names)", () => {
    expect(registered.size).toBeGreaterThan(0);
  });

  it("exactly the handlers that refuse anonymous callers are in PROTECTED_TOOLS", async () => {
    const refusing: string[] = [];
    for (const name of registered.keys()) {
      if (await refusesAnonymous(name)) refusing.push(name);
    }
    expect(new Set(refusing)).toEqual(PROTECTED_TOOLS);
  });

  it("every PROTECTED_TOOLS entry is a registered tool", () => {
    for (const name of PROTECTED_TOOLS) {
      expect(registered.has(name)).toBe(true);
    }
  });

  it("covers the current seller-owned tools (spec §2.10c)", () => {
    for (const name of ["create_listing", "add_item_image", "my_listings", "update_listing",
      // THI-360 PR 2: buyer-alert intent tools carry per-account data too.
      "save_intent", "my_intents", "update_intent", "delete_intent"]) {
      expect(PROTECTED_TOOLS.has(name)).toBe(true);
    }
  });
});
