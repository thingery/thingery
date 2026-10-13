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

/** Shape validation against ATTRIBUTE_CAPS: entry count, key length, string
 *  value length. Numbers and booleans are unconstrained. Returns error
 *  messages; empty array = valid. */
export function attributeShapeErrors(attributes: Attributes): string[] {
  const errors: string[] = [];
  const entries = Object.entries(attributes);
  if (entries.length > ATTRIBUTE_CAPS.maxEntries) {
    errors.push(`too many attribute entries: ${entries.length} (max ${ATTRIBUTE_CAPS.maxEntries})`);
  }
  for (const [key, value] of entries) {
    if (key.length > ATTRIBUTE_CAPS.maxKeyLength) {
      errors.push(`attribute key too long (${key.length} chars, max ${ATTRIBUTE_CAPS.maxKeyLength}): "${key.slice(0, 32)}…"`);
    }
    if (typeof value === "string" && value.length > ATTRIBUTE_CAPS.maxValueLength) {
      errors.push(`attribute "${key}" value too long (${value.length} chars, max ${ATTRIBUTE_CAPS.maxValueLength})`);
    }
  }
  return errors;
}

/** Thrown by write paths when attributeShapeErrors() is non-empty; `code`
 *  matches the MCP error code create_listing already reports. */
export class AttributeValidationError extends Error {
  readonly code = "invalid_attributes";
  constructor(messages: string[]) {
    super(messages.join("; "));
    this.name = "AttributeValidationError";
  }
}

/** Validate attributes against a category's definitions.
 *  Shape caps (attributeShapeErrors) run first, so every caller inherits
 *  them; definition checks follow. Returns error messages; empty = valid. */
export function validateAttributes(
  definitions: AttributeDefinition[],
  attributes: Attributes,
): string[] {
  const errors: string[] = [...attributeShapeErrors(attributes)];

  for (const def of definitions) {
    const value = attributes[def.key];
    if (value === undefined || value === null || value === "") {
      if (def.required) errors.push(`missing required attribute "${def.key}"${def.description ? ` (${def.description})` : ""}`);
      continue;
    }
    if (def.type === "number" && typeof value !== "number") {
      errors.push(`attribute "${def.key}" must be a number, got ${JSON.stringify(value)}`);
    } else if (def.type === "boolean" && typeof value !== "boolean") {
      errors.push(`attribute "${def.key}" must be a boolean, got ${JSON.stringify(value)}`);
    } else if (def.type === "string" && typeof value !== "string") {
      errors.push(`attribute "${def.key}" must be a string, got ${JSON.stringify(value)}`);
    } else if (def.enum && (typeof value !== "string" || !def.enum.includes(value))) {
      errors.push(`attribute "${def.key}" must be one of: ${def.enum.join(", ")}`);
    }
  }

  return errors;
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
