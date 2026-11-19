// THI-958 — type-level assertions for the MCP handler-args boundary.
//
// Every registerTool handler receives the zod-parsed output of its own
// inputSchema (ParsedToolArgs<S> via ToolRegistrar in src/tools.ts): handler
// arg types are DERIVED from the schema, so a field rename or a retyped
// schema field that a handler doesn't follow is a compile error instead of a
// silent runtime `undefined` (the THI-953 bug class: a bare snake_case →
// camelCase cast compiled fine while shipping zip: undefined to EasyPost).
// This file runs under vitest typecheck mode (vitest.config.ts →
// tsconfig.typecheck.json); weakening ParsedToolArgs, loosening the
// ToolRegistrar handler parameter, or casting back over the boundary turns
// each `@ts-expect-error` into an "Unused '@ts-expect-error' directive"
// failure. Imports are type-only: no server code runs here.

import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { ParsedToolArgs, ToolRegistrar } from "../src/tools.js";
import type { withToolResultLogging } from "../src/analytics.js";

const toolResult = { content: [{ type: "text" as const, text: "{}" }] };

describe("Handler args derive from the tool's zod input shape (THI-958)", () => {
  it("ParsedToolArgs is one z.output per schema key", () => {
    const fromAddressShape = {
      name: z.string(),
      postal_code: z.string(),
    };
    expectTypeOf<ParsedToolArgs<typeof fromAddressShape>>().toEqualTypeOf<{
      name: string;
      postal_code: string;
    }>();
  });

  it("schema defaults apply (non-optional output); optionals stay undefined-able", () => {
    const shape = {
      limit: z.number().int().default(10),
      q: z.string().optional(),
    };
    expectTypeOf<ParsedToolArgs<typeof shape>>().toEqualTypeOf<{
      limit: number;
      q: string | undefined;
    }>();
  });

  it("a handler reading a field its schema does not define is a compile error", () => {
    const shape = { name: z.string(), postal_code: z.string() };
    const registrar: ToolRegistrar = {
      registerTool() {
        return undefined;
      },
    };
    registrar.registerTool("buy_shipping_label", { inputSchema: shape }, async (args) => {
      expectTypeOf(args).toEqualTypeOf<{ name: string; postal_code: string }>();
      // @ts-expect-error THI-953 bug class: 'zip' is not a schema field
      args.zip;
      return toolResult;
    });
  });

  it("a wrong-typed read of a real schema field is a compile error", () => {
    const shape = { postal_code: z.string() };
    const registrar: ToolRegistrar = {
      registerTool() {
        return undefined;
      },
    };
    registrar.registerTool("buy_shipping_label", { inputSchema: shape }, async (args) => {
      const needsNumber = (zip: number) => zip;
      // @ts-expect-error postal_code parses to string, not number
      needsNumber(args.postal_code);
      return toolResult;
    });
  });

  it("a handler still reading a renamed schema field fails at the registrar boundary", () => {
    // postal_code was renamed to zip; a handler annotated for the old field
    // name no longer typechecks (parameter contravariance) instead of
    // silently receiving `zip: undefined` at runtime.
    const shape = { zip: z.string() };
    const staleHandler = async (_args: { postal_code: string }) => toolResult;
    const registrar: ToolRegistrar = {
      registerTool() {
        return undefined;
      },
    };
    registrar.registerTool(
      "buy_shipping_label",
      { inputSchema: shape },
      // @ts-expect-error schema/handler drift is compiler-caught (THI-958)
      staleHandler,
    );
  });

  it("the analytics proxy preserves the typed boundary", () => {
    expectTypeOf<ReturnType<typeof withToolResultLogging>>().toExtend<ToolRegistrar>();
  });
});
