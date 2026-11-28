import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_CAPS,
  attributeFieldErrors,
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

// THI-1936: the structured field_errors twin emitted on tool rejections must
// mirror the joined-string functions exactly — same checks, same order, same
// message text — so agents reading `error` and forms reading `field_errors`
// can never disagree about what was refused.
describe("attributeFieldErrors (structured twin, THI-1936)", () => {
  const defs: AttributeDefinition[] = [
    { key: "size_eu", type: "number", required: true },
    { key: "platform", type: "string", enum: ["ps5", "pc"] },
  ];

  it("missing required: field path, slug, exact message, declared type", () => {
    expect(attributeFieldErrors(defs, {})).toEqual([
      {
        field: "attributes.size_eu",
        problem: "missing_required",
        message: 'missing required attribute "size_eu"',
        expected: "number",
      },
    ]);
  });

  it("wrong type and enum problems carry the exact joined-string texts", () => {
    const problems = attributeFieldErrors(defs, { size_eu: "43", platform: "nes" });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({
      field: "attributes.size_eu",
      problem: "wrong_type",
      expected: "number",
      message: 'attribute "size_eu" must be a number, got "43"',
    });
    expect(problems[1]).toMatchObject({
      field: "attributes.platform",
      problem: "not_in_enum",
      expected: "string",
      message: 'attribute "platform" must be one of: ps5, pc',
    });
  });

  it("shape caps come first, same order as validateAttributes", () => {
    const payload = { platform: "x".repeat(ATTRIBUTE_CAPS.maxValueLength + 1) };
    const problems = attributeFieldErrors(defs, payload);
    // One shape problem (value too long) + definition problems in definition
    // order (missing size_eu, then platform's enum violation).
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatchObject({ field: "attributes.platform", problem: "value_too_long" });
    expect(problems[1]).toMatchObject({ field: "attributes.size_eu", problem: "missing_required" });
    expect(problems[2]).toMatchObject({ field: "attributes.platform", problem: "not_in_enum" });
    // And the message texts are identical to the joined-string path.
    expect(problems.map((p) => p.message)).toEqual(validateAttributes(defs, payload));
  });

  it("entry-less shape problems use the bare attributes field", () => {
    const problems = attributeFieldErrors([], { ["x".repeat(ATTRIBUTE_CAPS.maxKeyLength + 1)]: "v" });
    expect(problems[0]).toMatchObject({ field: "attributes", problem: "key_too_long" });
    expect(attributeFieldErrors([], Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 1])))[0])
      .toMatchObject({ field: "attributes", problem: "too_many_entries" });
  });

  it("empty attributes against an empty registry produce nothing", () => {
    expect(attributeFieldErrors([], {})).toEqual([]);
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
