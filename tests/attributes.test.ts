import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_CAPS,
  attributeFilterClause,
  attributeIssues,
  attributeShapeErrors,
  attributeShapeIssues,
  AttributeValidationError,
  attributesToText,
  definitionErrors,
  definitionIssues,
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
    const err = new AttributeValidationError(attributeShapeIssues({ k: "v".repeat(501) }));
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("invalid_attributes");
    expect(err.message).toContain("value too long");
  });

  // THI-1921: structured twins — same checks, same order, plus field path +
  // problem slug for field_errors surfacing.
  it("attributeShapeIssues mirrors attributeShapeErrors with field paths and slugs", () => {
    const issues = attributeShapeIssues({
      ["k".repeat(129)]: "v",
      big: "v".repeat(501),
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      field: `attributes.${"k".repeat(129)}`,
      problem: "key_too_long",
    });
    expect(issues[1]).toMatchObject({ field: "attributes.big", problem: "value_too_long" });
    expect(issues.map((i) => i.message)).toEqual(
      attributeShapeErrors({ ["k".repeat(129)]: "v", big: "v".repeat(501) }),
    );
  });

  it("definitionIssues names the missing required attribute and mirrors definitionErrors", () => {
    const issues = definitionIssues(sneakerDefs, { colorway: "red" });
    expect(issues).toEqual([
      {
        field: "attributes.size_eu",
        problem: "missing_required",
        message: issues[0].message,
        expected: "number",
      },
    ]);
    expect(issues[0].message).toContain("size_eu");
    expect(issues.map((i) => i.message)).toEqual(definitionErrors(sneakerDefs, { colorway: "red" }));
  });

  it("attributeIssues folds shape + definition issues in validateAttributes order", () => {
    const issues = attributeIssues(sneakerDefs, {
      colorway: "x".repeat(ATTRIBUTE_CAPS.maxValueLength + 1),
    });
    expect(issues.map((i) => i.problem)).toEqual(["value_too_long", "missing_required"]);
    expect(issues.map((i) => i.message)).toEqual(
      validateAttributes(sneakerDefs, { colorway: "x".repeat(ATTRIBUTE_CAPS.maxValueLength + 1) }),
    );
  });

  it("AttributeValidationError carries the structured issues", () => {
    const err = new AttributeValidationError(definitionIssues(sneakerDefs, {}));
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0].field).toBe("attributes.size_eu");
    expect(err.message).toBe(err.issues[0].message);
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
