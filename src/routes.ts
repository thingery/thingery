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
} from "./auth.js";
import { chatTurn, chatConfigured, type ChatMessage } from "./chat.js";
import { addItemImage, MAX_IMAGE_BYTES } from "./images.js";
import { asyncHandler } from "./oauth.js";
import { RateLimiter } from "./rate-limit.js";

const authAttemptLimiter = new RateLimiter(10, 60 * 60_000); // 10 signups/logins per IP per hour
const chatAnonLimiter = new RateLimiter(10, 60 * 60_000); // 10 anonymous chats per IP per hour
const chatAuthedLimiter = new RateLimiter(60, 60 * 60_000); // 60 logged-in chats per hour

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
  const account = await createAccount(email, parsed.data.password, parsed.data.name ?? email.split("@")[0]);
  res.cookie(SESSION_COOKIE, signSession(account.id), sessionCookieOptions());
  res.json({ seller: { name: account.display_name, email: account.email, api_key: account.api_key } });
}));

api.post("/login", asyncHandler(async (req: Request, res: Response) => {
  if (!authAttemptLimiter.allow(`ip:${clientIp(req)}`)) {
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }
  const { email, password } = req.body as { email?: string; password?: string };
  const account = email ? await accountByEmail(email.toLowerCase()) : null;
  if (!account || !verifyPassword(password ?? "", (account as { password_hash?: string }).password_hash ?? null)) {
    res.status(401).json({ error: "Wrong email or password." });
    return;
  }
  res.cookie(SESSION_COOKIE, signSession(account.id), sessionCookieOptions());
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
