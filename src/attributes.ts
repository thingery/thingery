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

/** One field-specific attribute problem (THI-1921): a stable input dot-path
 *  and problem slug alongside the human message, so clients can render which
 *  field failed and why instead of a blanket refusal. `field` names the
 *  create_listing/update_listing input key (`attributes.<key>`; entry-count
 *  problems point at `attributes` itself). */
export interface AttributeIssue {
  field: string;
  problem:
    | "too_many_entries"
    | "key_too_long"
    | "value_too_long"
    | "missing_required"
    | "type"
    | "enum"
    | "unknown_category";
  message: string;
  /** THI-1921: the definition's declared type, set on definition issues so
   *  clients can coerce input (e.g. render a numeric field for size_eu)
   *  instead of guessing from the message text. */
  expected?: "string" | "number" | "boolean";
}

/** Shape validation against ATTRIBUTE_CAPS: entry count, key length, string
 *  value length. Numbers and booleans are unconstrained. Returns error
 *  messages; empty array = valid. */
export function attributeShapeErrors(attributes: Attributes): string[] {
  return attributeShapeIssues(attributes).map((issue) => issue.message);
}

/** Structured twin of attributeShapeErrors — same checks, same order, plus
 *  the field path and problem slug (THI-1921). */
export function attributeShapeIssues(attributes: Attributes): AttributeIssue[] {
  const issues: AttributeIssue[] = [];
  const entries = Object.entries(attributes);
  if (entries.length > ATTRIBUTE_CAPS.maxEntries) {
    issues.push({
      field: "attributes",
      problem: "too_many_entries",
      message: `too many attribute entries: ${entries.length} (max ${ATTRIBUTE_CAPS.maxEntries})`,
    });
  }
  for (const [key, value] of entries) {
    if (key.length > ATTRIBUTE_CAPS.maxKeyLength) {
      issues.push({
        field: `attributes.${key}`,
        problem: "key_too_long",
        message: `attribute key too long (${key.length} chars, max ${ATTRIBUTE_CAPS.maxKeyLength}): "${key.slice(0, 32)}…"`,
      });
    }
    if (typeof value === "string" && value.length > ATTRIBUTE_CAPS.maxValueLength) {
      issues.push({
        field: `attributes.${key}`,
        problem: "value_too_long",
        message: `attribute "${key}" value too long (${value.length} chars, max ${ATTRIBUTE_CAPS.maxValueLength})`,
      });
    }
  }
  return issues;
}

/** Thrown by write paths when attribute validation is non-empty; `code`
 *  matches the MCP error code create_listing already reports. Carries the
 *  structured issues (THI-1921) so tool surfaces can answer with
 *  field_errors, not just the joined message. */
export class AttributeValidationError extends Error {
  readonly code = "invalid_attributes";
  readonly issues: AttributeIssue[];
  constructor(issues: AttributeIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "AttributeValidationError";
    this.issues = issues;
  }
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
  return definitionIssues(definitions, attributes).map((issue) => issue.message);
}

/** Structured twin of definitionErrors — same checks, same order, plus the
 *  field path and problem slug (THI-1921). */
export function definitionIssues(
  definitions: AttributeDefinition[],
  attributes: Attributes,
): AttributeIssue[] {
  const issues: AttributeIssue[] = [];

  for (const def of definitions) {
    const value = attributes[def.key];
    if (value === undefined || value === null || value === "") {
      if (def.required) {
        issues.push({
          field: `attributes.${def.key}`,
          problem: "missing_required",
          message: `missing required attribute "${def.key}"${def.description ? ` (${def.description})` : ""}`,
          expected: def.type,
        });
      }
      continue;
    }
    if (def.type === "number" && typeof value !== "number") {
      issues.push({
        field: `attributes.${def.key}`,
        problem: "type",
        message: `attribute "${def.key}" must be a number, got ${JSON.stringify(value)}`,
        expected: "number",
      });
    } else if (def.type === "boolean" && typeof value !== "boolean") {
      issues.push({
        field: `attributes.${def.key}`,
        problem: "type",
        message: `attribute "${def.key}" must be a boolean, got ${JSON.stringify(value)}`,
        expected: "boolean",
      });
    } else if (def.type === "string" && typeof value !== "string") {
      issues.push({
        field: `attributes.${def.key}`,
        problem: "type",
        message: `attribute "${def.key}" must be a string, got ${JSON.stringify(value)}`,
        expected: "string",
      });
    } else if (def.enum && (typeof value !== "string" || !def.enum.includes(value))) {
      issues.push({
        field: `attributes.${def.key}`,
        problem: "enum",
        message: `attribute "${def.key}" must be one of: ${def.enum.join(", ")}`,
        expected: def.type,
      });
    }
  }

  return issues;
}

/** Structured validateAttributes: shape caps first, then definition checks
 *  (same order as the string form). THI-1921: create_listing answers with
 *  these so clients can surface every failing attribute field. */
export function attributeIssues(
  definitions: AttributeDefinition[],
  attributes: Attributes,
): AttributeIssue[] {
  return [...attributeShapeIssues(attributes), ...definitionIssues(definitions, attributes)];
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
