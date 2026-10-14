import { z } from "zod";
import type { ItemRow, SellerRow } from "./db.js";
import { CONDITIONS, SHIPPING_TIERS, STATUSES } from "./db.js";
import { getCategory, getItem, createItem, listCategories, myItems, searchItems, undeclaredKeyUsage, updateItem } from "./items.js";
import { validateAttributes, AttributeValidationError, type Attributes } from "./attributes.js";
import { addItemImageBase64 } from "./images.js";
import { createOnboardingLink, getPayoutSetup, getOrCreateStripeAccount, getStripe, stripeConfigured } from "./stripe.js";
import { orderFlowConfig } from "./config.js";
import { cancelOrder, createOrder, getOrderView, OrderFlowError } from "./order-flow.js";
import { confirmPayment, confirmReceipt, openDispute, recordTracking, releaseFunds } from "./fulfillment.js";
import { logSecurityEvent } from "./security-events.js";

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
  "get_payout_setup",
  "create_order",
  "get_order",
  "cancel_order",
  "record_tracking",
  "confirm_payment",
  "confirm_receipt",
  "open_dispute",
  "release_funds",
]);

function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function itemToPublic(item: ItemRow & { score?: number }) {
  const { id, title, price_cents, currency, seller_payout_ready, ...rest } = item;
  return {
    ...rest,
    id,
    title,
    price: {
      amount: price_cents / 100,
      currency,
      cents: price_cents,
    },
    // §11.2: buyers see payment availability before ordering; `orderable`
    // stays true either way (off_platform orders track the deal regardless).
    ...(seller_payout_ready !== undefined
      ? { payment_available: orderFlowConfig().stripePaymentsEnabled && seller_payout_ready === true }
      : {}),
    orderable: item.status === "active",
    url: `${publicBaseUrl()}/item/${id}`,
  };
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/** Order payload for tool responses — parties only; address is PII (F16). */
function orderToPublic(order: Parameters<typeof getOrderView>[0] extends never ? never : {
  id: string; status: string; payment_mode: string; item_id: string; item_title?: string;
  price_cents: number; shipping_price_cents: number; currency: string; fulfillment: string;
  carrier: string | null; tracking_code: string | null; label_url: string | null;
  payment_deadline: Date | null; dispute_deadline: Date | null;
  status_changed_at: Date; created_at: Date; payment_url?: string | null;
  shipping_address?: Record<string, unknown>;
  checkout_session_id?: string | null; payment_intent_id?: string | null;
  transfer_id?: string | null; refund_id?: string | null; seller_id?: string; buyer_id?: string;
}) {
  const { shipping_address, seller_id, buyer_id, ...rest } = order;
  return {
    ...rest,
    total_price_cents: order.price_cents + order.shipping_price_cents,
  };
}

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
        "Discover a category's declared attribute fields (e.g. sneakers want size_eu, " +
        "colorway...). Declared fields are validated by create_listing; listings may also carry " +
        "undeclared attribute keys, and search attribute filters match any key. When undeclared " +
        "keys are actually in use in a category, they're listed in undeclared_in_use with " +
        "item/seller counts — search hints, not validated fields. " +
        "Call with no arguments to list all categories. Use before create_listing " +
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
          note: "Call describe_category with a category name to get its attribute definitions. " +
            "Definitions cover declared keys, which create_listing validates; listings may also " +
            "carry undeclared keys, and attribute search filters match any key.",
        });
      }
      const category = await getCategory(name);
      if (!category) {
        const categories = await listCategories();
        return err(`Unknown category '${name}'`, "unknown_category");
      }
      // Spec THI-83 §3.1/§3.4: helper output verbatim — no re-filtering,
      // sorting or capping here; field AND its note sentence are omitted when
      // empty so clean categories keep a payload byte-identical to today's.
      const undeclared = await undeclaredKeyUsage(
        name,
        category.attribute_definitions.map((d) => d.key),
      );
      const hasUndeclared = undeclared.length > 0;
      return ok({
        category,
        ...(hasUndeclared ? { undeclared_in_use: undeclared } : {}),
        note: "attribute_definitions are the declared keys — create_listing validates them " +
          "(types, required, enums). Listings may also carry undeclared keys: they pass through " +
          "unvalidated, and search_items attribute filters match any key, declared or not." +
          (hasUndeclared
            ? " undeclared_in_use lists undeclared keys observed on active listings (item and " +
              "distinct-seller counts); they are NOT validated — treat them as search hints, not contracts."
            : ""),
      });
    },
  );

  server.registerTool(
    "create_listing",
    {
      description:
        "Create a listing for a second-hand item. Requires seller authentication (Bearer API key). " +
        "Prices are in integer cents (EUR 12.50 = 1250). Category-specific fields go in `attributes` " +
        "(call describe_category first to see what's declared — undeclared keys are allowed " +
        "and searchable). Generates the item's embedding for semantic search.",
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
        // THI-111 (security doc §6 H3): z.string().url() validates URL shape, not
        // scheme — javascript:/data:/file: URLs passed and were stored on items
        // (buyer-IP leak via tracking pixels, script-scheme footgun for naive
        // clients). Scheme allowlist: image URLs must be http(s).
        // THI-130: also bound each URL to 2048 chars — previously the only cap
        // was the 8 MiB /mcp body gate (~7 MiB of URL text across 12 images).
        images: z.array(
          z.string().url().max(2048, "image URLs must be at most 2048 characters").refine(
            (v) => /^https?:\/\//i.test(v),
            "image URLs must be http(s) — javascript:, data:, file: and other schemes are rejected",
          ),
        ).max(12).default([]).describe("Image URLs (http/https only, max 2048 chars each)"),
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
          // THI-133 F2: create-time validation rejection, correlated by
          // sellerId (no request IP at this layer). Mirrors items.ts.
          logSecurityEvent({ type: "listing_write", action: "create", outcome: "rejected" }, { sellerId: seller.id });
          const available = (await listCategories()).map((c) => c.name).join(", ");
          return err(`Unknown category '${category}'. Available: ${available}`, "unknown_category");
        }

        const attributes = (args.attributes as Attributes | undefined) ?? {};
        const attributeErrors = validateAttributes(categoryRow.attribute_definitions, attributes);
        if (attributeErrors.length > 0) {
          logSecurityEvent({ type: "listing_write", action: "create", outcome: "rejected" }, { sellerId: seller.id });
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
          .describe("Exact-match attribute filter, e.g. {\"size_eu\": 43} — matches any attribute key, declared or not"),
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
      try {
        const item = await updateItem(args.id as string, seller.id, {
          status: args.status as string | undefined,
          price_cents: args.price_cents as number | undefined,
          title: args.title as string | undefined,
          description: args.description as string | undefined,
          attributes: args.attributes as Attributes | undefined,
        });
        if (!item) return err("Item not found or not owned by this seller", "not_found");
        return ok({ updated: true, item: itemToPublic(item) });
      } catch (e) {
        // updateItem throws AttributeValidationError for attribute shape-cap
        // violations (spec THI-83 §3.5); surface it with the structured
        // invalid_attributes code, same as create_listing (THI-90 note 1).
        if (e instanceof AttributeValidationError) {
          return err(`Invalid attributes: ${describeError(e)}`, e.code);
        }
        return err(`update_listing failed: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    "add_item_image",
    {
      description:
        "Attach a photo to one of your listings. Pass the image as base64 (a data-URL prefix is " +
        "accepted — e.g. what you get when the user shares a photo in this conversation). " +
        "Max 5 MB decoded — a full-size image fits: ~6.7 MB as base64+JSON, under the 8 MiB " +
        "/mcp request cap. jpeg, png, webp or gif. Requires API key.",
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

  server.registerTool(
    "get_payout_setup",
    {
      description:
        "Get this seller's payout setup for the order flow: a Stripe Express onboarding URL " +
        "when payments are enabled for this Thingery deployment, plus current onboarding status. " +
        "Onboarding is optional — items stay buyable as off-platform orders without it — but " +
        "platform payment (Stripe Checkout with buyer protection) requires it. Requires seller auth.",
      inputSchema: {},
    },
    async (_args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      try {
        if (!stripeConfigured()) {
          return err(
            "Stripe payments are not configured on this Thingery deployment (STRIPE_SECRET_KEY unset). " +
              "Listings remain buyable as off-platform orders; platform payment is unavailable.",
            "payments_not_configured",
          );
        }
        const stripe = getStripe();
        if (!stripe) return err("Stripe payments are not configured on this deployment.", "payments_not_configured");
        const accountId = await getOrCreateStripeAccount(seller.id, stripe);
        const link = await createOnboardingLink(accountId, publicBaseUrl(), stripe);
        const setup = await getPayoutSetup(seller.id);
        return ok({
          onboarding_url: link.url,
          onboarded: setup?.onboardedAt != null,
          stripe_account_id: accountId,
          note: setup?.onboardedAt
            ? "Payout account is onboarded — your listings accept platform payment."
            : "Open the onboarding URL to accept platform payment (Stripe Express, ~5 minutes). " +
                "The link is single-use; call get_payout_setup again for a fresh one.",
        });
      } catch (e) {
        return err(`get_payout_setup failed: ${describeError(e)}`);
      }
    },
  );

  // ---- Order flow (spec THI-3 rev 2 §4.1 + rev 3 §11.2; PR-4) ----

  server.registerTool(
    "create_order",
    {
      description:
        "Order an item. Default payment_mode is 'stripe' (Checkout URL returned) when the " +
        "deployment has payments AND the seller finished payout onboarding; otherwise " +
        "'off_platform' — you and the seller settle payment yourselves (check get_item's " +
        "payment_available first). Shippable items need a shipping_address; local-pickup " +
        "items ignore it. Requires authentication (buyer account).",
      inputSchema: {
        item_id: z.string().uuid().describe("Item to order"),
        shipping_address: z.object({
          name: z.string().min(1).max(120),
          line1: z.string().min(1).max(200),
          line2: z.string().max(200).optional(),
          city: z.string().min(1).max(80),
          postal_code: z.string().min(1).max(20),
          country: z.string().length(2).describe("ISO 3166-1 alpha-2, e.g. 'IT'"),
        }).strict().optional().describe("Required for shippable items"),
        payment_mode: z.enum(["stripe", "off_platform"]).optional()
          .describe("Leave unset for the best available path"),
      },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      try {
        const { order, paymentUrl } = await createOrder({
          buyerId: seller.id,
          itemId: args.item_id as string,
          shippingAddress: args.shipping_address as Parameters<typeof createOrder>[0]["shippingAddress"],
          paymentMode: args.payment_mode as "stripe" | "off_platform" | undefined,
        });
        return ok({
          order: orderToPublic(order),
          payment_url: paymentUrl,
          next_steps: paymentUrl
            ? ["Open payment_url to pay with card (the order expires unpaid in 24h)", "Track with get_order"]
            : ["Agree payment directly with the seller (off-platform)", "The seller confirms receipt with confirm_payment", "Track with get_order"],
        });
      } catch (e) {
        if (e instanceof OrderFlowError) return err(e.message, e.code);
        return err(`create_order failed: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      description: "Fetch one of your orders (as buyer or seller): status, price breakdown, " +
        "tracking, deadlines. Requires authentication; only order parties can see it.",
      inputSchema: { order_id: z.string().uuid() },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      const order = await getOrderView(args.order_id as string, seller.id);
      if (!order) return err("Order not found.", "not_found");
      return ok({ order: orderToPublic(order) });
    },
  );

  server.registerTool(
    "cancel_order",
    {
      description:
        "Cancel one of your orders (buyer or seller) while it is still cancellable " +
        "(pending, sold, label_issued). Stripe-mode orders that already paid cannot be " +
        "cancelled — the payment is refunded instead where applicable; off-platform " +
        "parties reverse their own payment. Requires authentication.",
      inputSchema: {
        order_id: z.string().uuid(),
        reason: z.string().max(500).optional(),
      },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      try {
        const order = await cancelOrder(args.order_id as string, seller.id, args.reason as string | undefined);
        return ok({
          order: orderToPublic(order),
          note: order.status === "refunding"
            ? "Refund initiated; status moves to refunded when Stripe confirms (get_order)."
            : order.status === "cancelled"
              ? "Order cancelled and the item is available again."
              : undefined,
        });
      } catch (e) {
        if (e instanceof OrderFlowError) return err(e.message, e.code);
        return err(`cancel_order failed: ${describeError(e)}`);
      }
    },
  );

  // ---- Fulfillment + dispute tools (spec THI-3 rev 2 §4.2/§5.2 + rev 3 §11.2; PR-5) ----

  server.registerTool(
    "record_tracking",
    {
      description:
        "Seller records the shipment's carrier and tracking code (order moves sold → label_issued; " +
        "shippable orders only — pickups have nothing to ship). Registers a carrier tracker when the " +
        "deployment has EasyPost configured, so status updates (in transit, delivered) arrive " +
        "automatically. Calling it again while still label_issued CORRECTS the tracking details.",
      inputSchema: {
        order_id: z.string().uuid(),
        carrier: z.string().min(1).max(40).describe("Carrier name, e.g. 'DHL', 'DPD', 'UPS'"),
        tracking_code: z.string().min(1).max(64),
        label_url: z.string().url().startsWith("https://").max(500).optional()
          .describe("https-only shipping label URL, if you generated one"),
      },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      try {
        const result = await recordTracking(args.order_id as string, seller.id, {
          carrier: args.carrier as string,
          trackingCode: args.tracking_code as string,
          labelUrl: args.label_url as string | undefined,
        });
        return ok({
          order: orderToPublic(result.order),
          tracker_registered: result.trackerRegistered,
          ...(result.note ? { note: result.note } : {}),
        });
      } catch (e) {
        if (e instanceof OrderFlowError) return err(e.message, e.code);
        return err(`record_tracking failed: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    "confirm_payment",
    {
      description:
        "Seller confirms receiving an OFF-PLATFORM payment (cash, bank transfer, …): the order " +
        "moves pending → sold. Only exists for off_platform orders — Stripe-mode orders flip to " +
        "sold automatically when payment succeeds.",
      inputSchema: {
        order_id: z.string().uuid(),
        note: z.string().max(500).optional().describe("e.g. 'cash received at pickup'"),
      },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      try {
        const order = await confirmPayment(args.order_id as string, seller.id, args.note as string | undefined);
        return ok({ order: orderToPublic(order) });
      } catch (e) {
        if (e instanceof OrderFlowError) return err(e.message, e.code);
        return err(`confirm_payment failed: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    "confirm_receipt",
    {
      description:
        "Buyer confirms receiving the item: the order moves to delivered and the dispute window " +
        "opens (48h default). For local pickup this is the delivery step; for shipped items it is " +
        "an early confirm (carriers usually report delivery automatically).",
      inputSchema: { order_id: z.string().uuid() },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      try {
        const order = await confirmReceipt(args.order_id as string, seller.id);
        return ok({
          order: orderToPublic(order),
          next_steps: ["open_dispute within the dispute window if something is wrong", "release_funds to release early otherwise"],
        });
      } catch (e) {
        if (e instanceof OrderFlowError) return err(e.message, e.code);
        return err(`confirm_receipt failed: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    "open_dispute",
    {
      description:
        "Buyer opens a dispute on a delivered order (within the dispute window). Payout is held " +
        "while the order is disputed; a deployment operator resolves it.",
      inputSchema: {
        order_id: z.string().uuid(),
        reason: z.string().min(1).max(1000).describe("What went wrong (required)"),
      },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      try {
        const order = await openDispute(args.order_id as string, seller.id, args.reason as string);
        return ok({ order: orderToPublic(order) });
      } catch (e) {
        if (e instanceof OrderFlowError) return err(e.message, e.code);
        return err(`open_dispute failed: ${describeError(e)}`);
      }
    },
  );

  server.registerTool(
    "release_funds",
    {
      description:
        "Buyer waives the remaining dispute window and releases the seller's payout immediately " +
        "(delivered → payout_pending for Stripe orders; → completed for off-platform). Use when " +
        "everything arrived fine and you want the seller paid now.",
      inputSchema: { order_id: z.string().uuid() },
    },
    async (args: Record<string, unknown>) => {
      const seller = requireSeller();
      if (!seller) return err("Missing or invalid Authorization: Bearer API key (thg_...) or OAuth token (thgo_...)", "unauthorized");
      try {
        const result = await releaseFunds(args.order_id as string, seller.id);
        return ok({
          order: orderToPublic(result.order),
          ...(result.note ? { note: result.note } : {}),
        });
      } catch (e) {
        if (e instanceof OrderFlowError) return err(e.message, e.code);
        return err(`release_funds failed: ${describeError(e)}`);
      }
    },
  );
}
