// HTTP API for the browser pages: account signup/login and the chat endpoint.
// Mounted after the raw-body /mcp route; express.json() applies from here on.

import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  accountByEmail,
  createAccount,
  sellerFromSession,
  sessionCookieOptions,
  signSession,
  verifyPassword,
  SESSION_COOKIE,
  type AccountRow,
} from "./auth.js";
import { chatTurn, chatConfigured, type ChatMessage } from "./chat.js";
import { addItemImage, MAX_IMAGE_BYTES } from "./images.js";
import { asyncHandler } from "./oauth.js";
import { RateLimiter } from "./rate-limit.js";
import crypto from "node:crypto";
import { pool } from "./db.js";
import { orderFlowConfig, envValue } from "./config.js";
import { applyTransition, IllegalTransitionError, type OrderRow } from "./orders.js";
import { logSecurityEvent } from "./security-events.js";
import { getStripe, createRefundForOrder, createTransferForOrder, retrieveTransfer } from "./stripe.js";

const authAttemptLimiter = new RateLimiter(10, 60 * 60_000); // 10 signups/logins per IP per hour
const chatAnonLimiter = new RateLimiter(10, 60 * 60_000); // 10 anonymous chats per IP per hour
const chatAuthedLimiter = new RateLimiter(60, 60 * 60_000); // 60 logged-in chats per hour
export const adminAttemptLimiter = new RateLimiter(10, 60 * 60_000); // 10 admin calls per IP per hour (F7)
export const imageUploadLimiter = new RateLimiter(30, 60 * 60_000); // 30 image uploads per seller per hour (THI-110 / H3)

function clientIp(req: Request): string {
  return req.ip ?? "unknown";
}

export const api = express.Router();

// --- accounts --------------------------------------------------------------

const signupSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(80).optional(),
});

// THI-59 / THI-58: every async handler is wrapped in asyncHandler — rejections
// reach the terminal error middleware in mountApiRoutes below instead of
// escaping as unhandled rejections that kill the process (Express 4 does not
// route rejected promises to error middleware on its own).

api.post("/signup", asyncHandler(async (req: Request, res: Response) => {
  if (!authAttemptLimiter.allow(`ip:${clientIp(req)}`)) {
    // THI-112: brute-force attempts on the auth surface are first-class
    // security events — the 429 response alone leaves no trace.
    logSecurityEvent({ type: "rate_limit", route: "/api/signup" }, { ip: clientIp(req) });
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Valid email and a password of at least 8 characters are required." });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  if (await accountByEmail(email)) {
    res.status(409).json({ error: "An account with this email already exists." });
    return;
  }
  // createAccount rejections flow to the terminal middleware as a generic
  // JSON 500 — the old local catch leaked raw driver detail (spec THI-58 F5).
  // THI-61 (Security THI-60 note N3 / spec THI-58 §9 OQ3): two concurrent
  // signups can both pass the pre-check above; the insert loser hits the
  // sellers email unique constraint (pg 23505) and gets the same 409 body
  // as the pre-check. Any other fault rethrows — generic 500, no detail.
  let account: AccountRow;
  try {
    account = await createAccount(email, parsed.data.password, parsed.data.name ?? email.split("@")[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "An account with this email already exists." });
      return;
    }
    throw err;
  }
  // THI-112: signup success — correlated by seller id + IP (H4.2).
  logSecurityEvent({ type: "signup", outcome: "success" }, { sellerId: account.id, ip: clientIp(req) });
  // Sign at the live epoch (spec THI-115 §3): a fresh account is epoch 0, but
  // passing the row's value keeps the cookie correct-by-construction.
  res.cookie(SESSION_COOKIE, signSession(account.id, account.session_epoch), sessionCookieOptions());
  res.json({ seller: { name: account.display_name, email: account.email, api_key: account.api_key } });
}));

api.post("/login", asyncHandler(async (req: Request, res: Response) => {
  if (!authAttemptLimiter.allow(`ip:${clientIp(req)}`)) {
    logSecurityEvent({ type: "rate_limit", route: "/api/login" }, { ip: clientIp(req) });
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  // THI-55 (repeated-param type-confusion sweep): a JSON body can carry
  // arrays/objects where strings are expected, and email.toLowerCase() on an
  // array is a TypeError → generic 500 via the terminal middleware. Treat
  // non-string credentials as absent — the same fail-closed 401 as a wrong
  // email. `?? {}` also covers a non-object body (top-level JSON array/string).
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof body.email === "string" ? body.email : undefined;
  const password = typeof body.password === "string" ? body.password : undefined;
  const account = email ? await accountByEmail(email.toLowerCase()) : null;
  if (!account || !verifyPassword(password ?? "", (account as { password_hash?: string }).password_hash ?? null)) {
    // THI-112: no email/username is logged — the failure event carries only
    // outcome + IP, so the log can't become a credential-validity oracle.
    logSecurityEvent({ type: "login", outcome: "failure" }, { ip: clientIp(req) });
    res.status(401).json({ error: "Wrong email or password." });
    return;
  }
  logSecurityEvent({ type: "login", outcome: "success" }, { sellerId: account.id, ip: clientIp(req) });
  // Sign at the live epoch (spec THI-115 §3): after a future epoch bump (key
  // regeneration), a cookie signed at a stale epoch would fail verification
  // immediately — so login always reads the seller's current epoch.
  res.cookie(SESSION_COOKIE, signSession(account.id, account.session_epoch), sessionCookieOptions());
  res.json({ seller: { name: account.display_name, email: account.email, api_key: account.api_key } });
}));

api.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  res.json({ ok: true });
});

api.get("/me", asyncHandler(async (req: Request, res: Response) => {
  // The .catch stays: a session-lookup fault means anonymous here (intended
  // semantics, spec THI-58 D3), not a 500.
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.json({ seller: null });
    return;
  }
  res.json({ seller: { name: seller.display_name, api_key: seller.api_key } });
}));

// --- item images (browser upload) -------------------------------------------

// Raw body for image uploads: express.raw with the image content types only.
const imageUpload = express.raw({ type: ["image/jpeg", "image/png", "image/webp", "image/gif"], limit: MAX_IMAGE_BYTES + 64 * 1024 });

api.post("/items/:id/images", imageUpload, asyncHandler(async (req: Request, res: Response) => {
  const seller = await sellerFromSession(req).catch(() => null);
  if (!seller) {
    res.status(401).json({ error: "Log in to add photos." });
    return;
  }
  // THI-110 (H3): the upload route is authenticated, so key the bucket by
  // seller, not IP (IP attribution was the H1 bug; seller keys are exact).
  if (!imageUploadLimiter.allow(`seller:${seller.id}`)) {
    res.status(429).json({ error: "Too many uploads — try again later." });
    return;
  }
  const mediaType = (req.headers["content-type"] ?? "").split(";")[0].trim();
  const data = req.body as Buffer;
  if (!data || data.length === 0) {
    res.status(400).json({ error: "Empty upload — send the image bytes as the request body." });
    return;
  }
  const result = await addItemImage(seller.id, req.params.id, data, mediaType);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ url: result.url });
}));

// --- chat -------------------------------------------------------------------

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(24)
    .default([]),
});

// No inner try/catch → next(e): asyncHandler forwards rejections to the
// terminal middleware — one idiom everywhere (THI-59, spec THI-58 D1).
api.post("/chat", asyncHandler(async (req: Request, res: Response) => {
  const seller = await sellerFromSession(req).catch(() => null);
  const limiter = seller ? chatAuthedLimiter : chatAnonLimiter;
  const key = seller ? `seller:${seller.id}` : `ip:${clientIp(req)}`;
  if (!limiter.allow(key)) {
    res.status(429).json({
      error: seller
        ? "Chat limit reached for this hour."
        : "Anonymous chat limit reached — create an account (free) to keep going.",
    });
    return;
  }
  if (!chatConfigured()) {
    res.status(503).json({
      error: "Chat is not configured on this server yet. The MCP endpoint at /mcp works as usual.",
    });
    return;
  }
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Message required (max 4000 characters)." });
    return;
  }
  const reply = await chatTurn(parsed.data.history as ChatMessage[], parsed.data.message, seller);
  res.json({ reply });
}));

// --- admin: dispute resolution (spec THI-3 §4.3, PR-9) ----------------------

/** F7: timing-safe Bearer compare — length-check first, then constant-time
 * equal (auth.ts verifyPassword pattern; kept local so auth.ts is untouched). */
function adminKeyMatches(presented: string | undefined, expected: string | undefined): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const resolveDisputeSchema = z.object({
  outcome: z.enum(["refund", "release"]),
  note: z.string().min(1).max(500),
});

const ADMIN = { type: "admin" as const };

/** §6.6 refund-after-transfer: reverse the transfer (full, idempotent per
 * order), then refund the charge from the platform balance; alert the
 * operator to any shortfall — never silently drop funds. */
async function refundAfterTransfer(order: OrderRow): Promise<{ refundId: string | null }> {
  const stripe = getStripe();
  if (!stripe) throw new Error("payments_not_configured");
  if (order.transfer_id && !order.refund_id) {
    await stripe.transfers
      .createReversal(order.transfer_id, {}, { idempotencyKey: `reversal:${order.id}` })
      .catch((err: unknown) => console.error(`[admin] reversal of ${order.transfer_id} failed (${(err as Error).message}) — refund continues from platform balance`));
    console.error(
      `[admin] operator alert: order ${order.id} refunded after transfer ${order.transfer_id} — ` +
        `platform-balance shortfall possible (transfer ${order.transfer_id} reversed; reserve policy §6.4)`,
    );
  }
  if (order.refund_id) return { refundId: null }; // refund already in flight — reconcile, never duplicate (F3)
  const refund = await createRefundForOrder(order, order.payment_intent_id!, stripe);
  // THI-70 A1(a): persist refund_id BEFORE the transition. If admin_refund
  // loses a cross-outcome race (admin_release won the status CAS meanwhile),
  // the refund stays visible on the row instead of orphaning at Stripe —
  // sweep rules 7/9 key on non-terminal statuses, so the row is the only
  // record a terminal paid_out would carry.
  await pool.query("UPDATE orders SET refund_id = $2 WHERE id = $1 AND refund_id IS NULL", [order.id, refund.id]);
  return { refundId: refund.id };
}

/** #19 release: reconcile-don't-recreate (F3) — an existing transfer is
 * retrieved, not re-created; paid → #20 lands immediately, in flight → the
 * order waits for its own transfer event. */
async function releaseWithReconcile(order: OrderRow): Promise<void> {
  if (order.payment_mode !== "stripe") return;
  if (order.transfer_id) {
    const transfer = await retrieveTransfer(order.transfer_id);
    if (transfer && !transfer.amount_reversed) {
      // Already landed: complete the payout now instead of waiting for a
      // possibly-lost transfer event (rule 6 recovers it otherwise).
      const landed = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
      if (landed.rows[0]?.status === "payout_pending") {
        await applyTransition({ orderId: order.id, trigger: "transfer_paid", actor: { type: "stripe", id: order.transfer_id } });
      }
    }
    return;
  }
  const stripe = getStripe();
  if (!stripe) throw new Error("payments_not_configured");
  const dest = await pool.query<{ stripe_account_id: string | null }>(
    "SELECT stripe_account_id FROM sellers WHERE id = $1",
    [order.seller_id],
  );
  const destination = dest.rows[0]?.stripe_account_id;
  if (!destination) throw new Error("inconsistent_state: seller payout account missing");
  const transfer = await createTransferForOrder(order, destination, stripe);
  await pool.query("UPDATE orders SET transfer_id = $2 WHERE id = $1", [order.id, transfer.id]);
}

api.post("/admin/orders/:id/resolve-dispute", asyncHandler(async (req: Request, res: Response) => {
  // F1/F7: boot validation disables the route entirely when the key is unset
  // or short — a disabled admin surface is indistinguishable from absent.
  const cfg = orderFlowConfig();
  if (!cfg.adminRouteEnabled) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  if (!adminAttemptLimiter.allow(`ip:${clientIp(req)}`)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  const header = req.get("Authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
  // A2 (THI-70): read through envValue — trimmed, empty=unset — so the auth
  // compare sees exactly what the adminRouteEnabled gate validated at boot.
  // Raw process.env here made a whitespace-padded key enable the route while
  // every request 401s (fail-closed, availability-only).
  if (!adminKeyMatches(presented, envValue("ADMIN_API_KEY"))) {
    res.status(401).json({ error: "Not authorized." });
    return;
  }
  const parsed = resolveDisputeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "outcome (refund|release) and note (1-500 chars) required." });
    return;
  }
  // Malformed ids must 404 (no uuid parse error, no oracle).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
    res.status(404).json({ error: "Order not found." });
    return;
  }
  const { outcome, note } = parsed.data;
  const { rows } = await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [req.params.id]);
  const order = rows[0];
  if (!order) {
    res.status(404).json({ error: "Order not found." });
    return;
  }
  if (order.status !== "disputed") {
    res.status(409).json({ error: `Order is ${order.status}; only disputed orders can be resolved.` });
    return;
  }
  try {
    if (outcome === "refund") {
      const refundId =
        order.payment_mode === "stripe" && order.payment_intent_id
          ? (await refundAfterTransfer(order)).refundId
          : null; // null → refund already in flight (reconcile) or off_platform
      await applyTransition({ orderId: order.id, trigger: "admin_refund", actor: ADMIN, reason: note, ...(refundId ? { sets: { refund_id: refundId } } : {}) });
    } else {
      await applyTransition({ orderId: order.id, trigger: "admin_release", actor: ADMIN, reason: note });
      await releaseWithReconcile(order);
    }
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
  const after = (await pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [order.id])).rows[0];
  res.set("Cache-Control", "no-store");
  res.json({ order_id: order.id, status: after.status, refund_id: after.refund_id, transfer_id: after.transfer_id });
}));

/**
 * Mounts the browser API and its terminal error middleware (spec THI-58 §2
 * D2, PR-1). The middleware is app-level and registered AFTER the router
 * mount, so it catches both errors escaping the router and the pre-router
 * body-parser errors a router-internal handler can never see (F3). Mirrors
 * mountOauthRoutes in src/oauth.ts.
 */
export function mountApiRoutes(app: Express): void {
  app.use("/api", api);
  // THI-58: terminal error middleware for the /api surface. asyncHandler
  // forwards handler rejections here; they degrade to a generic JSON 500 —
  // no error detail, no stack (F5). Body-parser 4xx statuses are preserved
  // ONLY for genuine entity.* parser errors (F4); anything else — including
  // a handler error carrying a forged or real .status — fails closed to 500
  // (Security note N1). In-flight (headers-sent) responses are destroyed.
  // Express 4 matches routes case-insensitively (THI-52 finding 1), so the
  // scope check folds the path: /API/LOGIN stays in scope.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const foldedPath = req.path.toLowerCase();
    if (foldedPath !== "/api" && !foldedPath.startsWith("/api/")) {
      next(err); // non-/api errors pass through untouched (blast-radius guard)
      return;
    }
    const parserErr = err as { type?: unknown; status?: unknown };
    let status = 500;
    let message = "Something went wrong. Please try again.";
    if (
      typeof parserErr.type === "string" &&
      parserErr.type.startsWith("entity.") &&
      typeof parserErr.status === "number" &&
      parserErr.status >= 400 &&
      parserErr.status < 500
    ) {
      status = parserErr.status;
      message = status === 413 ? "Request body too large." : "Request body could not be read.";
    }
    console.error("api error:", req.method, req.path, "->", status, message);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.set("Cache-Control", "no-store");
    res.status(status).json({ error: message });
  });
}
