// Generates the MCP tool reference pages of the docs site (docs-site/tools/*.mdx) from the
// live tool registry, so the published reference cannot drift from src/tools.ts.
// tests/tool-docs.test.ts fails when the committed pages differ from this output.
//
//   npm run docs:tools

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PROTECTED_TOOLS, registerTools } from "../src/tools.js";

type Annotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
};

type ToolConfig = {
  title: string;
  description: string;
  annotations: Annotations;
  inputSchema?: Record<string, z.ZodType>;
};

type JsonSchema = {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  format?: string;
};

type ToolPage = {
  slug: string;
  title: string;
  description: string;
  intro: string;
  tools: string[];
};

export const TOOL_PAGES: ToolPage[] = [
  {
    slug: "listings",
    title: "Listings and search",
    description: "Find items, read the category schema, and publish and manage listings.",
    intro:
      "Search and item reads are public. Publishing needs an account, and a listing stays hidden " +
      "until it has at least one photo.",
    tools: [
      "search_items",
      "get_item",
      "describe_category",
      "create_listing",
      "add_item_image",
      "my_listings",
      "update_listing",
    ],
  },
  {
    slug: "orders",
    title: "Orders",
    description: "Place an order, pay, ship, confirm delivery, and handle disputes.",
    intro:
      "Every order tool needs an account, and only the two parties of an order can see it. " +
      "See [Orders](/guides/orders) for the states and deadlines.",
    tools: [
      "create_order",
      "get_order",
      "my_orders",
      "cancel_order",
      "get_payout_setup",
      "confirm_payment",
      "share_shipping_address",
      "record_tracking",
      "confirm_receipt",
      "open_dispute",
      "release_funds",
    ],
  },
  {
    slug: "alerts",
    title: "Buyer alerts",
    description: "Save what a buyer is looking for and read new matching listings.",
    intro:
      "A saved search (an intent) collects new listings that match it. The buyer's agent reads them " +
      "with `my_matches`; nothing is emailed.",
    tools: ["save_intent", "my_intents", "update_intent", "delete_intent", "my_matches"],
  },
  {
    slug: "wanted",
    title: "Wanted board",
    description: "Buyers post what they want; sellers answer with real listings.",
    intro:
      "The [wanted board](https://thingery.dev/wanted) is public to read. Posting, editing and " +
      "answering need an account.",
    tools: [
      "search_wanted",
      "get_wanted",
      "create_wanted",
      "my_wanted",
      "update_wanted",
      "expire_wanted",
      "renew_wanted",
      "respond_to_wanted",
    ],
  },
];

export function collectTools(): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  registerTools(
    {
      registerTool(name: string, config: ToolConfig) {
        tools.set(name, config);
      },
    },
    { seller: null },
  );
  return tools;
}

/** Plain text from the registry must not be read as JSX. */
function escapeMdx(text: string): string {
  return text
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s*\n\s*/g, " ");
}

/** The type label, which is a JSX attribute value, so it never carries quotes. */
function describeType(schema: JsonSchema): string {
  if (schema.anyOf) return [...new Set(schema.anyOf.map(describeType))].join(" | ");
  if (schema.enum) return schema.enum.every((value) => typeof value === "string") ? "string" : "enum";
  if (schema.type === "array") return `${schema.items ? describeType(schema.items) : "any"}[]`;
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  return schema.type ?? "any";
}

function describeLimits(schema: JsonSchema): string[] {
  const limits: string[] = [];
  if (schema.enum) {
    limits.push(`One of ${schema.enum.map((value) => `\`${String(value)}\``).join(", ")}`);
  }
  // z.number().int() reports the safe-integer range, which tells a reader nothing.
  const maximum = schema.maximum === Number.MAX_SAFE_INTEGER ? undefined : schema.maximum;
  if (schema.minimum !== undefined && maximum !== undefined) {
    limits.push(`From ${schema.minimum} to ${maximum}`);
  } else if (maximum !== undefined) {
    limits.push(`At most ${maximum}`);
  } else if (schema.minimum !== undefined && schema.minimum !== 0) {
    limits.push(`At least ${schema.minimum}`);
  }
  if (schema.maxLength !== undefined && schema.maxLength === schema.minLength) {
    limits.push(`Exactly ${schema.maxLength} characters`);
  } else if (schema.maxLength !== undefined) {
    limits.push(`Up to ${schema.maxLength} characters`);
  }
  if (schema.maxItems !== undefined) limits.push(`Up to ${schema.maxItems} items`);
  if (schema.default !== undefined) limits.push(`Default \`${JSON.stringify(schema.default)}\``);
  return limits;
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function renderField(name: string, property: JsonSchema, isRequired: boolean, indent: string): string[] {
  // Limits carry their own code spans, so only the registry's prose is escaped.
  const notes = [
    ...(property.description ? [escapeMdx(property.description)] : []),
    ...describeLimits(property),
  ]
    .map(asSentence)
    .join(" ");
  const attributes = `body="${name}" type="${describeType(property)}"${isRequired ? " required" : ""}`;
  const lines = [`${indent}<ParamField ${attributes}>`];
  if (notes) lines.push(`${indent}  ${notes}`);
  if (property.type === "object" && property.properties) {
    lines.push(
      `${indent}  <Expandable title="fields">`,
      ...renderFields(property.properties, property.required ?? [], `${indent}    `),
      `${indent}  </Expandable>`,
    );
  }
  lines.push(`${indent}</ParamField>`);
  return lines;
}

function renderFields(properties: Record<string, JsonSchema>, required: string[], indent = ""): string[] {
  return Object.entries(properties).flatMap(([name, property]) =>
    renderField(name, property, required.includes(name), indent),
  );
}

function renderParameters(inputSchema: ToolConfig["inputSchema"]): string {
  if (!inputSchema || Object.keys(inputSchema).length === 0) return "No parameters.";

  const schema = z.toJSONSchema(z.object(inputSchema), { io: "input", unrepresentable: "any" }) as JsonSchema;
  return ["**Parameters**", "", ...renderFields(schema.properties ?? {}, schema.required ?? [])].join("\n");
}

function renderTool(name: string, tool: ToolConfig): string {
  const access = PROTECTED_TOOLS.has(name) ? "Needs an account" : "Public";
  const effect = tool.annotations.readOnlyHint
    ? "Read-only"
    : tool.annotations.destructiveHint
      ? "Writes, cannot be undone"
      : "Writes";
  return [
    `## \`${name}\``,
    "",
    `**${escapeMdx(tool.title)}** · ${access} · ${effect}`,
    "",
    escapeMdx(tool.description),
    "",
    renderParameters(tool.inputSchema),
  ].join("\n");
}

export function renderToolPages(tools = collectTools()): Map<string, string> {
  const pages = new Map<string, string>();
  for (const page of TOOL_PAGES) {
    const sections = page.tools.map((name) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`docs lists ${name}, which is not a registered tool`);
      return renderTool(name, tool);
    });
    pages.set(
      `docs-site/tools/${page.slug}.mdx`,
      [
        "---",
        `title: "${page.title}"`,
        `description: "${page.description}"`,
        "---",
        "",
        "{/* Generated by scripts/gen-tool-docs.ts from src/tools.ts. Do not edit; run npm run docs:tools. */}",
        "",
        page.intro,
        "",
        sections.join("\n\n"),
        "",
      ].join("\n"),
    );
  }
  return pages;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [path, content] of renderToolPages()) {
    writeFileSync(new URL(`../${path}`, import.meta.url), content);
    console.log(`wrote ${path}`);
  }
}
