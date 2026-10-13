import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_CAPS,
  attributeFilterClause,
  attributeShapeErrors,
  AttributeValidationError,
  attributesToText,
  validateAttributes,
  type AttributeDefinition,
} from "../src/attributes.js";

const sneakerDefs: AttributeDefinition[] = [
  { key: "size_eu", type: "number", required: true },
  { key: "colorway", type: "string" },
  { key: "has_original_box", type: "boolean" },
];

describe("validateAttributes", () => {
  it("passes valid attributes and ignores undeclared keys (flexible by design)", () => {
    const errors = validateAttributes(sneakerDefs, {
      size_eu: 43,
      colorway: "white/grey",
      has_original_box: true,
      custom_future_field: "whatever",
    });
    expect(errors).toEqual([]);
  });

  it("includes shape errors (caps run first, inherited by every caller)", () => {
    // Before THI-83 this input yielded only the definition error; the shape
    // error must now be folded in ahead of it.
    const errors = validateAttributes(sneakerDefs, {
      colorway: "x".repeat(ATTRIBUTE_CAPS.maxValueLength + 1),
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("value too long");
    expect(errors[1]).toContain("size_eu");
  });

  it("flags missing required attributes", () => {
    const errors = validateAttributes(sneakerDefs, { colorway: "red" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("size_eu");
  });

  it("flags type mismatches", () => {
    const errors = validateAttributes(sneakerDefs, { size_eu: "43" });
    expect(errors[0]).toContain("must be a number");
  });

  it("validates enum values", () => {
    const defs: AttributeDefinition[] = [
      { key: "platform", type: "string", enum: ["ps5", "pc"] },
    ];
    expect(validateAttributes(defs, { platform: "ps5" })).toEqual([]);
    expect(validateAttributes(defs, { platform: "nes" })[0]).toContain("must be one of");
  });

  it("allows empty attributes when nothing is required", () => {
    expect(validateAttributes([], {})).toEqual([]);
  });
});

describe("attributeShapeErrors (write caps, THI-83 §3.5)", () => {
  const entries = (n: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));

  it("accepts the boundary: 64 entries, 128-char key, 500-char string", () => {
    expect(attributeShapeErrors(entries(ATTRIBUTE_CAPS.maxEntries))).toEqual([]);
    expect(attributeShapeErrors({ ["k".repeat(ATTRIBUTE_CAPS.maxKeyLength)]: "v" })).toEqual([]);
    expect(attributeShapeErrors({ k: "v".repeat(ATTRIBUTE_CAPS.maxValueLength) })).toEqual([]);
  });

  it("rejects 65 entries", () => {
    const errors = attributeShapeErrors(entries(ATTRIBUTE_CAPS.maxEntries + 1));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("too many attribute entries");
    expect(errors[0]).toContain("65");
  });

  it("rejects a 129-char key", () => {
    const errors = attributeShapeErrors({ ["k".repeat(ATTRIBUTE_CAPS.maxKeyLength + 1)]: "v" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("key too long");
    expect(errors[0]).toContain("129");
  });

  it("rejects a 501-char string value but not long numbers/booleans", () => {
    const errors = attributeShapeErrors({ k: "v".repeat(ATTRIBUTE_CAPS.maxValueLength + 1) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("value too long");
    expect(errors[0]).toContain("501");
    // Non-string values are unconstrained by design.
    expect(attributeShapeErrors({ big: 1e15, flag: true })).toEqual([]);
  });

  it("accumulates one error per violation", () => {
    const attrs: Record<string, string> = entries(ATTRIBUTE_CAPS.maxEntries + 1);
    attrs["k".repeat(ATTRIBUTE_CAPS.maxKeyLength + 1)] = "v".repeat(ATTRIBUTE_CAPS.maxValueLength + 1);
    const errors = attributeShapeErrors(attrs);
    expect(errors).toHaveLength(3);
  });

  it("AttributeValidationError carries the joined messages and the MCP error code", () => {
    const err = new AttributeValidationError(attributeShapeErrors({ k: "v".repeat(501) }));
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("invalid_attributes");
    expect(err.message).toContain("value too long");
  });
});

describe("attributeFilterClause", () => {
  it("builds a jsonb containment clause with a bound parameter", () => {
    const params: unknown[] = [];
    const add = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const clause = attributeFilterClause({ size_eu: 43 }, add);
    expect(clause).toBe("i.attributes @> $1::jsonb");
    expect(params).toEqual(['{"size_eu":43}']);
  });
});

describe("attributesToText", () => {
  it("flattens attributes for semantic indexing", () => {
    expect(attributesToText({ size_eu: 43, colorway: "red" })).toBe("size eu: 43\ncolorway: red");
  });

  it("handles undefined", () => {
    expect(attributesToText(undefined)).toBe("");
  });
});
