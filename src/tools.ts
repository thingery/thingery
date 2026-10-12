import { z } from "zod";
import type { ItemRow, SellerRow } from "./db.js";
import { CONDITIONS, SHIPPING_TIERS, STATUSES } from "./db.js";
import { getCategory, getItem, createItem, listCategories, myItems, searchItems, updateItem } from "./items.js";
import { validateAttributes, type Attributes } from "./attributes.js";
import { addItemImageBase64 } from "./images.js";

export interface ToolContext {
  seller: SellerRow | null;
}

// ---------------------------------------------------------------------------
// Seller-required tools (spec THI-11 §2.10c, F7): the /mcp method-aware 401
// gate challenges anonymous calls to PROTECTED_TOOLS, so OAuth-capable hosts
// discover they must authenticate and start the browser onboarding flow.
// The annotation lives next to tool registration; CI
// (tests/protected-tools.test.ts) enforces that the set matches exactly the
// tools whose handlers reject anonymous callers, so a future write tool
// cannot silently lose its 401-challenge onboarding path. Tool-level
// requireSeller() guards remain as defense in depth (§2.10c, unchanged).
export const PROTECTED_TOOLS: ReadonlySet<string> = new Set([
  "create_listing",
  "add_item_image",
  "my_listings",
  "update_listing",
  // Order-flow tools (spec THI-10) must be added here when they land.
]);

function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function itemToPublic(item: ItemRow & { score?: number }) {
  const { id, title, price_cents, currency, ...rest } = item;
  return {
    ...rest,
    id,
    title,
    price: {
      amount: price_cents / 100,
      currency,
      cents: price_cents,
    },
    url: `${publicBaseUrl()}/item/${id}`,
  };
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const err = (message: string, code = "error") => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message, code }, null, 2) }],
  isError: true,
});

/** pg connection errors can carry an empty message; keep the code visible. */
const describeError = (e: unknown): string => {
  const error = e as Error & { code?: string };
  return error.message || error.code || "unknown error";
};

export function registerTools(server: { registerTool: Function }, ctx: ToolContext): void {
  const requireSeller = (): SellerRow | null => ctx.seller;

  server.registerTool(
    "describe_category",
    {
      description:
        "Discover the expected attribute fields for a category (e.g. sneakers want size_eu, " +
        "colorway...). Call with no arguments to list all categories. Use before create_listing " +
        "to fill attributes correctly. Public.",
      inputSchema: {
        category: z.string().min(2).max(40).optional().describe("Category slug, e.g. 'sneakers'"),
      },
    },
    async (args: Record<string, unknown>) => {
      const name = (args.category as string | undefined)?.toLowerCase();
      if (!name) {
        const categories = await listCategories();
        return ok({
          categories,
          note: "Call describe_category with a category name to get its attribute definitions.",
        });
      }
      const category = await getCategory(name);
      if (!category) {
        const categories = await listCategories();
        return err(`Unknown category '${name}'`, "unknown_category");
      }
      return ok({ category });
    },
  );

  server.registerTool(
    "create_listing",
    {
      description:
        "Create a listing for a second-hand item. Requires seller authentication (Bearer API key). " +
        "Prices are in integer cents (EUR 12.50 = 1250). Category-specific fields go in `attributes` " +
        "(call describe_category first to see what's expected). Generates the item's embedding for semantic search.",
      inputSchema: {
        title: z.string().min(3).max(200).describe("Short item title, e.g. 'Nike Air Max 90, size 43'"),
        description: z.string().max(5000).default("").describe("Honest description incl. flaws"),
        category: z.string().min(2).max(40).default("other").describe("Lowercase slug; call describe_category for the list"),
        condition: z.enum(CONDITIONS).default("good"),
        brand: z.string().max(80).optional(),
        price_cents: z.number().int().min(0).describe("Asking price in cents, e.g. 12500"),
        currency: z.string().length(3).default("EUR").describe("ISO 4217 code"),
        location: z.string().max(120).optional().describe("e.g. 'Milan, IT'"),
        weight_grams: z.number().int().min(1).optional().describe("For shipping estimation"),
        dimensions_mm: z.string().max(40).optional().describe("LxWxH, e.g. '320x220x120'"),
        shipping_tier: z.enum(SHIPPING_TIERS).default("unknown").describe("locker | parcel | bulky | local"),
        images: z.array(z.string().url()).max(12).default([]).describe("Image URLs"),
        attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).default({})
          .describe("Category-specific fields, e.g. {\"size_eu\": 43, \"colorway\": \"white/grey\"}"),
      },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      try {
        const category = ((args.category as string) ?? "other").toLowerCase();
        const categoryRow = await getCategory(category);
        if (!categoryRow) {
          const available = (await listCategories()).map((c) => c.name).join(", ");
          return err(`Unknown category '${category}'. Available: ${available}`, "unknown_category");
        }

        const attributes = (args.attributes as Attributes | undefined) ?? {};
        const attributeErrors = validateAttributes(categoryRow.attribute_definitions, attributes);
        if (attributeErrors.length > 0) {
          return err(`Invalid attributes for category '${category}': ${attributeErrors.join("; ")}`, "invalid_attributes");
        }

        const item = await createItem({
          seller_id: seller.id,
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
          images: (args.images as string[]) ?? [],
          attributes,
        });
        return ok({
          created: true,
          seller: seller.display_name,
          item: itemToPublic(item),
          next_steps: [
            "Share the item URL with potential buyers",
            "Update status to 'reserved' when a deal is close, 'sold' when completed",
          ],
        });
      } catch (e) {
        return err(`create_listing failed: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    "search_items",
    {
      description:
        "Search active second-hand listings. Public (no API key needed). " +
        "Hybrid: semantic similarity when embeddings are configured, keyword fallback otherwise.",
      inputSchema: {
        q: z.string().max(400).optional().describe("Free-text query, e.g. 'running shoes size 43'"),
        category: z.string().min(2).max(40).optional().describe("Category slug; see describe_category"),
        condition: z.enum(CONDITIONS).optional(),
        min_price_cents: z.number().int().min(0).optional(),
        max_price_cents: z.number().int().min(0).optional(),
        currency: z.string().length(3).default("EUR"),
        shipping_tier: z.enum(SHIPPING_TIERS).optional(),
        attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
          .describe("Exact-match attribute filter, e.g. {\"size_eu\": 43}"),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args: Record<string, unknown>) => {
      try {
        const results = await searchItems({
          q: args.q as string | undefined,
          category: args.category as string | undefined,
          condition: args.condition as string | undefined,
          min_price_cents: args.min_price_cents as number | undefined,
          max_price_cents: args.max_price_cents as number | undefined,
          currency: (args.currency as string) ?? "EUR",
          shipping_tier: args.shipping_tier as string | undefined,
          attributes: args.attributes as Attributes | undefined,
          limit: (args.limit as number) ?? 10,
        });
        return ok({
          count: results.length,
          results: results.map((r) => itemToPublic(r)),
          note: results.length === 0 ? "No matches. Try broader terms or fewer filters." : undefined,
        });
      } catch (e) {
        return err(`search_items failed: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    "get_item",
    {
      description: "Fetch a single listing by its item id. Public.",
      inputSchema: { id: z.string().uuid() },
    },
    async (args: Record<string, unknown>) => {
      const item = await getItem(args.id as string);
      if (!item || item.status === "deleted") return err("Item not found", "not_found");
      return ok({ item: itemToPublic(item) });
    },
  );

  server.registerTool(
    "my_listings",
    {
      description: "List the authenticated seller's own listings. Requires API key.",
      inputSchema: {
        status: z.enum(STATUSES).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      const items = await myItems(seller.id, args.status as string | undefined, (args.limit as number) ?? 50);
      return ok({ seller: seller.display_name, count: items.length, items: items.map(itemToPublic) });
    },
  );

  server.registerTool(
    "update_listing",
    {
      description:
        "Update one of your own listings: change status (active/reserved/sold/deleted), " +
        "adjust price, or edit title/description. Requires API key.",
      inputSchema: {
        id: z.string().uuid(),
        status: z.enum(STATUSES).optional(),
        price_cents: z.number().int().min(0).optional(),
        title: z.string().min(3).max(200).optional(),
        description: z.string().max(5000).optional(),
        attributes: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
          .describe("Replaces the whole attributes object (read-modify-write)"),
      },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      const item = await updateItem(args.id as string, seller.id, {
        status: args.status as string | undefined,
        price_cents: args.price_cents as number | undefined,
        title: args.title as string | undefined,
        description: args.description as string | undefined,
        attributes: args.attributes as Attributes | undefined,
      });
      if (!item) return err("Item not found or not owned by this seller", "not_found");
      return ok({ updated: true, item: itemToPublic(item) });
    },
  );

  server.registerTool(
    "add_item_image",
    {
      description:
        "Attach a photo to one of your listings. Pass the image as base64 (a data-URL prefix is " +
        "accepted — e.g. what you get when the user shares a photo in this conversation). " +
        "Max 5 MB; jpeg, png, webp or gif. Requires API key.",
      inputSchema: {
        item_id: z.string().uuid(),
        image_base64: z.string().min(50).describe("Base64-encoded image bytes (data-URL prefix allowed)"),
        media_type: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
      },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      const result = await addItemImageBase64(
        seller.id,
        args.item_id as string,
        args.image_base64 as string,
        args.media_type as string,
      );
      if ("error" in result) return err(result.error, "invalid_image");
      return ok({ added: true, image_url: `${publicBaseUrl()}${result.url}` });
    },
  );
}
