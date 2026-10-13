// Server-side chat agent for the /chat page (casual users, zero config).
// Talks to any OpenAI-compatible /v1/chat/completions endpoint with tool
// calling, and executes Thingery's own functions directly against the
// database — the same code paths the MCP tools use.

import type { SellerRow } from "./db.js";
import { getCategory, getItem, createItem, listCategories, myItems, searchItems, undeclaredKeyUsage, updateItem } from "./items.js";
import { validateAttributes, type Attributes } from "./attributes.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function chatConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

const SYSTEM_PROMPT = `You are the Thingery assistant — Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.
You help people sell used items and find used items, right here in the chat.

Selling:
- Gather what's needed with at most ONE compact question at a time: item identity (brand/model/size), condition, price.
- Call describe_category for the matching category to learn its expected attributes, then fill them.
  Undeclared keys are allowed — include anything a buyer would filter on.
- Grade condition honestly: new > like_new > good > fair > poor. Flaws go in the description.
- Prices are integer cents (EUR 12.50 -> price_cents 1250). Confirm the price with the user before creating a listing.
- Estimate weight_grams/dimensions_mm from the item type; shipping_tier: locker for shoebox-sized items, parcel up to ~30kg, bulky for furniture, local for pickup-only.
- After creating, give the item URL and mention they can ask you to mark it reserved/sold later.

Buying:
- Search with filters (max_price_cents, category, condition, attributes like {"size_eu": 43}).
- Propose ONE best match with reasoning, plus 1-2 runner-ups. Never exceed the user's budget.

If the user is not logged in and wants to publish, tell them to create an account first (link on the page).
Keep replies short and concrete. Amounts in normal currency (12500 cents = EUR 125.00).`;

type ToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "describe_category",
      description: "List categories, or get one category's declared attribute fields. Declared fields are validated on create; undeclared keys are allowed and searchable. Call before create_listing.",
      parameters: {
        type: "object",
        properties: { category: { type: "string", description: "category slug, e.g. sneakers; omit to list all" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_items",
      description: "Search active second-hand listings (public).",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string" },
          category: { type: "string", description: "category slug; call describe_category for the list" },
          condition: { type: "string", enum: ["new", "like_new", "good", "fair", "poor"] },
          min_price_cents: { type: "integer" },
          max_price_cents: { type: "integer" },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_item",
      description: "Fetch one listing by id (public).",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_listing",
      description: "Create a listing (requires logged-in seller). Prices in integer cents.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 3, maxLength: 200 },
          description: { type: "string" },
          category: { type: "string", description: "category slug; call describe_category for the list" },
          condition: { type: "string", enum: ["new", "like_new", "good", "fair", "poor"] },
          brand: { type: "string" },
          price_cents: { type: "integer", minimum: 0 },
          currency: { type: "string", minLength: 3, maxLength: 3 },
          location: { type: "string" },
          weight_grams: { type: "integer" },
          dimensions_mm: { type: "string" },
          shipping_tier: { type: "string", enum: ["locker", "parcel", "bulky", "local", "unknown"] },
          attributes: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        },
        required: ["title", "price_cents"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "my_listings",
      description: "List the logged-in seller's own listings.",
      parameters: {
        type: "object",
        properties: { status: { type: "string", enum: ["active", "reserved", "sold", "deleted"] } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_listing",
      description: "Update one of your listings: status (active/reserved/sold/deleted), price_cents, title, description.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["active", "reserved", "sold", "deleted"] },
          price_cents: { type: "integer", minimum: 0 },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
];

// Exported for the parity test (spec THI-83 §8/F3): both describe_category
// surfaces must render undeclaredKeyUsage() output identically.
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  seller: SellerRow | null,
): Promise<unknown> {
  const requireSeller = () => {
    if (!seller) throw new Error("You are not logged in — publishing requires an account.");
    return seller;
  };

  switch (name) {
    case "describe_category": {
      const cat = (args.category as string | undefined)?.toLowerCase();
      if (!cat) return { categories: await listCategories() };
      const categoryRow = await getCategory(cat);
      // Shape once, render twice (spec THI-83 §3.4/F3): same helper, same
      // shape as the MCP tool in src/tools.ts — verbatim, and (field + note
      // sentence both) omitted when empty, byte-identical to today otherwise.
      const undeclared = await undeclaredKeyUsage(
        cat,
        categoryRow?.attribute_definitions.map((d) => d.key) ?? [],
      );
      const hasUndeclared = undeclared.length > 0;
      return {
        category: categoryRow,
        ...(hasUndeclared ? { undeclared_in_use: undeclared } : {}),
        note: "Declared keys are validated on create; listings may also carry undeclared keys, and attribute search filters match any key." +
          (hasUndeclared
            ? " undeclared_in_use lists undeclared keys observed on active listings (item and distinct-seller counts); they are NOT validated — treat them as search hints, not contracts."
            : ""),
      };
    }
    case "search_items":
      return {
        results: await searchItems({
          q: args.q as string | undefined,
          category: args.category as string | undefined,
          condition: args.condition as string | undefined,
          min_price_cents: args.min_price_cents as number | undefined,
          max_price_cents: args.max_price_cents as number | undefined,
          currency: (args.currency as string) ?? "EUR",
          limit: (args.limit as number) ?? 10,
        }),
      };
    case "get_item": {
      const item = await getItem(args.id as string);
      return item ? { item } : { error: "not found" };
    }
    case "create_listing": {
      const s = requireSeller();
      const category = ((args.category as string) ?? "other").toLowerCase();
      const categoryRow = await getCategory(category);
      if (!categoryRow) return { error: `unknown category '${category}'` };
      const attributes = (args.attributes as Attributes | undefined) ?? {};
      const attributeErrors = validateAttributes(categoryRow.attribute_definitions, attributes);
      if (attributeErrors.length > 0) return { error: attributeErrors.join("; ") };
      const item = await createItem({
        seller_id: s.id,
        title: args.title as string,
        description: (args.description as string) ?? "",
        category,
        condition: (args.condition as string) ?? "good",
        brand: (args.brand as string) ?? null,
        price_cents: args.price_cents as number,
        currency: ((args.currency as string) ?? "EUR").toUpperCase(),
        location: (args.location as string) ?? null,
        weight_grams: (args.weight_grams as number | undefined) ?? null,
        dimensions_mm: (args.dimensions_mm as string) ?? null,
        shipping_tier: (args.shipping_tier as string) ?? "unknown",
        images: [],
        attributes,
      });
      const base = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
      return { created: true, id: item.id, url: `${base}/item/${item.id}` };
    }
    case "my_listings": {
      const s = requireSeller();
      return { items: await myItems(s.id, args.status as string | undefined, 50) };
    }
    case "update_listing": {
      const s = requireSeller();
      const item = await updateItem(args.id as string, s.id, {
        status: args.status as string | undefined,
        price_cents: args.price_cents as number | undefined,
        title: args.title as string | undefined,
        description: args.description as string | undefined,
      });
      return item ? { updated: true } : { error: "not found or not yours" };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

async function callLlm(messages: LlmMessage[]): Promise<LlmMessage> {
  const url = process.env.LLM_API_URL ?? "https://api.openai.com/v1/chat/completions";
  const model = process.env.LLM_MODEL ?? "gpt-4o-mini";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify({ model, messages, tools: TOOLS, max_tokens: 1200 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices: Array<{ message: LlmMessage }> };
  return json.choices[0]?.message ?? { role: "assistant", content: "No response from model." };
}

/** Runs one chat turn: user message in, assistant text out (tools executed server-side). */
export async function chatTurn(
  history: ChatMessage[],
  userMessage: string,
  seller: SellerRow | null,
): Promise<string> {
  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + (seller ? `\n\nThe user is logged in as seller "${seller.display_name}".` : "\n\nThe user is NOT logged in: read-only tools only; publishing needs an account.") },
    ...history.slice(-12).map((m) => ({ role: m.role, content: m.content } as LlmMessage)),
    { role: "user", content: userMessage },
  ];

  for (let round = 0; round < 6; round++) {
    const reply = await callLlm(messages);
    messages.push(reply);

    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      return reply.content ?? "";
    }

    for (const call of reply.tool_calls) {
      let result: unknown;
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        result = await executeTool(call.function.name, args, seller);
      } catch (e) {
        result = { error: (e as Error).message };
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 12_000),
      });
    }
  }
  return "Sorry — that took too many steps. Could you simplify the request?";
}
