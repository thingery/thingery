// ISO 3166-1 alpha-2 country enforcement on create_order (spec docs/specs/
// order-address-verification.md §1). Pure tests: the vendored set, the
// trim+uppercase normalization (" it " → "IT"), the field-only rejection
// message (the rejected value is never echoed), and parity between the MCP
// zod schema and the chat's manual validation for the same input.

import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ISO3166_ALPHA2, isIso3166Alpha2, normalizeCountryCode } from "../src/iso3166.js";
import { registerTools } from "../src/tools.js";
import { normalizeOrderArgs } from "../src/chat.js";

/** Captures create_order's zod schema via a fake server (no MCP runtime). */
function createOrderShape(): z.ZodTypeAny {
  let shape: z.ZodRawShape | undefined;
  registerTools(
    {
      registerTool(_name: string, config: { inputSchema?: z.ZodRawShape }) {
        if (_name === "create_order") shape = config.inputSchema;
      },
    } as never,
    { seller: null },
  );
  return z.object(shape!);
}

const address = (country: unknown) => ({
  item_id: "11111111-1111-4111-8111-111111111111",
  shipping_address: { name: "A", line1: "B", city: "C", postal_code: "D", country },
});

describe("iso3166 module", () => {
  it("carries the 249 assigned ISO 3166-1 alpha-2 codes", () => {
    expect(ISO3166_ALPHA2.size).toBe(249);
    for (const code of ["IT", "US", "DE", "JP", "BR", "ZA", "AQ"]) {
      expect(ISO3166_ALPHA2.has(code), code).toBe(true);
    }
    for (const notACode of ["XX", "ZZ", "QQ", "XA", "EU"]) {
      expect(ISO3166_ALPHA2.has(notACode), notACode).toBe(false);
    }
  });

  it("normalizes trim + uppercase before membership", () => {
    expect(normalizeCountryCode(" it ")).toBe("IT");
    expect(isIso3166Alpha2(" it ")).toBe(true);
    expect(isIso3166Alpha2("it")).toBe(true);
    expect(isIso3166Alpha2("It")).toBe(true);
    expect(isIso3166Alpha2("IT")).toBe(true);
    expect(isIso3166Alpha2(" XX ")).toBe(false);
    expect(isIso3166Alpha2("ITA")).toBe(false); // wrong shape, not a membership failure
    expect(isIso3166Alpha2("")).toBe(false);
  });
});

describe("create_order country check — MCP zod schema vs chat validation parity", () => {
  const shape = createOrderShape();

  it("accepts a valid code and normalizes it (trim + uppercase) on both surfaces", () => {
    for (const country of ["IT", "it", "It", " it ", "US"]) {
      const mcp = shape.safeParse(address(country));
      expect(mcp.success, country).toBe(true);
      const chat = normalizeOrderArgs("create_order", address(country));
      expect(chat.ok, country).toBe(true);
      const expected = normalizeCountryCode(country as string);
      expect((mcp.data as { shipping_address: { country: string } }).shipping_address.country).toBe(expected);
      expect((chat.args as { shipping_address: { country: string } }).shipping_address.country).toBe(expected);
    }
  });

  it("rejects a 2-letter non-ISO code on both surfaces", () => {
    for (const country of ["XX", "xx", " xx ", "ZZ"]) {
      expect(shape.safeParse(address(country)).success, country).toBe(false);
      expect(normalizeOrderArgs("create_order", address(country)).ok, country).toBe(false);
    }
  });

  it("rejection message names the field only — never the rejected value", () => {
    const mcp = shape.safeParse(address("XX"));
    expect(mcp.success).toBe(false);
    const mcpText = JSON.stringify((mcp.error as z.ZodError).issues);
    expect(mcpText).toMatch(/ISO 3166-1 alpha-2/);
    expect(mcpText).toContain("shipping_address");
    expect(mcpText).not.toContain("XX");

    const chat = normalizeOrderArgs("create_order", address("XX"));
    expect(chat.ok).toBe(false);
    const chatText = (chat as { ok: false; error: string }).error;
    expect(chatText).toBe("create_order: shipping_address.country must be an ISO 3166-1 alpha-2 country code");
    expect(chatText).not.toContain("XX");
  });

  it("still rejects wrong shapes on both surfaces (parity with the old 2-letter rule)", () => {
    for (const country of ["ITA", "", "I", null, 42]) {
      expect(shape.safeParse(address(country)).success, String(country)).toBe(false);
      expect(normalizeOrderArgs("create_order", address(country)).ok, String(country)).toBe(false);
    }
  });
});
