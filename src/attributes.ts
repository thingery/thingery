// Flexible attribute handling: category-declared definitions (validation +
// self-description for agents) and JSONB containment filters for search.
// Deliberately permissive: keys not declared by the category pass through
// unchanged — flexibility is the point; definitions are guidance, not law.

export interface AttributeDefinition {
  key: string;
  type: "string" | "number" | "boolean";
  enum?: string[];
  required?: boolean;
  unit?: string;
  description?: string;
}

export interface CategoryRow {
  name: string;
  description: string;
  attribute_definitions: AttributeDefinition[];
  /** Two-level taxonomy (THI-734): department slug or null (department/'other'). */
  parent: string | null;
}

export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;

/** Write-time shape caps for item attributes (spec THI-83 §3.5, Security F1).
 *  Fixed values — deliberately not env-configurable. */
export const ATTRIBUTE_CAPS = {
  maxEntries: 64,
  maxKeyLength: 128,
  maxValueLength: 500,
} as const;

/** Hygiene pattern for attribute keys surfaced to agents (spec THI-83 §3.3).
 *  Display filter only — deliberately stricter than the 128-char stored-key
 *  cap, so overlong keys are filtered from surfaces, never rejected on write. */
export const UNDECLARED_KEY_PATTERN = "^[A-Za-z0-9_-]{1,64}$";

/** THI-1936: cap on machine-readable field errors per rejection — matches the
 *  client-side cap in the platform ingest form, so both sides drop the same
 *  overflow and the refusal text (the joined message) stays the full truth. */
export const ATTRIBUTE_FIELD_ERROR_CAP = 20;

/** THI-1936: one machine-readable attribute problem, riding on tool errors as
 *  `field_errors` so clients (platform ingest review form) can render a
 *  field-specific refusal instead of a blanket one. `field` is the payload
 *  path ("attributes.<key>"; entry-less shape problems use "attributes"),
 *  `problem` a stable slug, `message` the exact human text also present in
 *  the joined error string, `expected` the declared type when one applies. */
export interface AttributeFieldError {
  field: string;
  problem: "missing_required" | "wrong_type" | "not_in_enum" | "too_many_entries" | "key_too_long" | "value_too_long";
  message: string;
  expected?: AttributeDefinition["type"];
}

/** THI-1936: structured twin of the shape-cap checks — same order (entry
 *  count first, then per-entry), same message text as attributeShapeErrors. */
function shapeFieldErrors(attributes: Attributes): AttributeFieldError[] {
  const problems: AttributeFieldError[] = [];
  const entries = Object.entries(attributes);
  if (entries.length > ATTRIBUTE_CAPS.maxEntries) {
    problems.push({
      field: "attributes",
      problem: "too_many_entries",
      message: `too many attribute entries: ${entries.length} (max ${ATTRIBUTE_CAPS.maxEntries})`,
    });
  }
  for (const [key, value] of entries) {
    if (key.length > ATTRIBUTE_CAPS.maxKeyLength) {
      // No per-key field: an over-long key cannot ride the attributes.<key>
      // path form inputs can express, so the entry is intentionally
      // entry-less and the offending key stays in the message text.
      problems.push({
        field: "attributes",
        problem: "key_too_long",
        message: `attribute key too long (${key.length} chars, max ${ATTRIBUTE_CAPS.maxKeyLength}): "${key.slice(0, 32)}…"`,
      });
    }
    if (typeof value === "string" && value.length > ATTRIBUTE_CAPS.maxValueLength) {
      problems.push({
        field: `attributes.${key}`,
        problem: "value_too_long",
        message: `attribute "${key}" value too long (${value.length} chars, max ${ATTRIBUTE_CAPS.maxValueLength})`,
      });
    }
  }
  return problems;
}

/** Shape validation against ATTRIBUTE_CAPS: entry count, key length, string
 *  value length. Numbers and booleans are unconstrained. Returns error
 *  messages; empty array = valid. */
export function attributeShapeErrors(attributes: Attributes): string[] {
  return shapeFieldErrors(attributes).map((p) => p.message);
}

/** Thrown by write paths when attributeShapeErrors() is non-empty; `code`
 *  matches the MCP error code create_listing already reports. THI-1936:
 *  carries the structured twin of `messages` so update_listing's rejection
 *  can emit field_errors with the same detail create_listing emits. */
export class AttributeValidationError extends Error {
  readonly code = "invalid_attributes";
  readonly fieldErrors: AttributeFieldError[];
  constructor(messages: string[], fieldErrors: AttributeFieldError[] = []) {
    super(messages.join("; "));
    this.name = "AttributeValidationError";
    this.fieldErrors = fieldErrors;
  }
}

/** THI-1936: structured twin of the registry-definition checks — same order
 *  (definition order), same message text as definitionErrors. */
function definitionFieldErrors(
  definitions: AttributeDefinition[],
  attributes: Attributes,
): AttributeFieldError[] {
  const problems: AttributeFieldError[] = [];

  for (const def of definitions) {
    const value = attributes[def.key];
    if (value === undefined || value === null || value === "") {
      if (def.required) {
        problems.push({
          field: `attributes.${def.key}`,
          problem: "missing_required",
          message: `missing required attribute "${def.key}"${def.description ? ` (${def.description})` : ""}`,
          expected: def.type,
        });
      }
      continue;
    }
    if (def.type === "number" && typeof value !== "number") {
      problems.push({ field: `attributes.${def.key}`, problem: "wrong_type", message: `attribute "${def.key}" must be a number, got ${JSON.stringify(value)}`, expected: "number" });
    } else if (def.type === "boolean" && typeof value !== "boolean") {
      problems.push({ field: `attributes.${def.key}`, problem: "wrong_type", message: `attribute "${def.key}" must be a boolean, got ${JSON.stringify(value)}`, expected: "boolean" });
    } else if (def.type === "string" && typeof value !== "string") {
      problems.push({ field: `attributes.${def.key}`, problem: "wrong_type", message: `attribute "${def.key}" must be a string, got ${JSON.stringify(value)}`, expected: "string" });
    } else if (def.enum && (typeof value !== "string" || !def.enum.includes(value))) {
      problems.push({ field: `attributes.${def.key}`, problem: "not_in_enum", message: `attribute "${def.key}" must be one of: ${def.enum.join(", ")}`, expected: def.type });
    }
  }

  return problems;
}

/** Registry-definition checks only (no shape caps): for each declared key,
 *  required-present / type / enum against the payload. Undeclared keys pass
 *  through — definitions are guidance for them, not law (module header).
 *  THI-1369 (Security F1): extracted from validateAttributes so the update
 *  path (updateItem) runs the same declared-key checks create_listing runs,
 *  after its own shape-cap gate. Returns error messages; empty = valid. */
export function definitionErrors(
  definitions: AttributeDefinition[],
  attributes: Attributes,
): string[] {
  return definitionFieldErrors(definitions, attributes).map((p) => p.message);
}

/** THI-1936: the full structured problem list for one attributes payload —
 *  shape caps first, then definition checks, exactly mirroring
 *  validateAttributes()' order and message text. Consumers cap at
 *  ATTRIBUTE_FIELD_ERROR_CAP when emitting (tools.ts). */
export function attributeFieldErrors(
  definitions: AttributeDefinition[],
  attributes: Attributes,
): AttributeFieldError[] {
  return [...shapeFieldErrors(attributes), ...definitionFieldErrors(definitions, attributes)];
}

/** Validate attributes against a category's definitions.
 *  Shape caps (attributeShapeErrors) run first, so every caller inherits
 *  them; definition checks follow. Returns error messages; empty = valid. */
export function validateAttributes(
  definitions: AttributeDefinition[],
  attributes: Attributes,
): string[] {
  return [...attributeShapeErrors(attributes), ...definitionErrors(definitions, attributes)];
}

/** Build the JSONB containment clause for attribute filters.
 *  `addParam` registers the JSON string and returns its $n placeholder. */
export function attributeFilterClause(
  attributes: Attributes,
  addParam: (value: unknown) => string,
): string {
  return `i.attributes @> ${addParam(JSON.stringify(attributes))}::jsonb`;
}

/** Flatten attributes into text for semantic indexing ("size_eu: 43"). */
export function attributesToText(attributes: Attributes | undefined): string {
  if (!attributes) return "";
  return Object.entries(attributes)
    .map(([key, value]) => `${key.replace(/_/g, " ")}: ${value}`)
    .join("\n");
}
