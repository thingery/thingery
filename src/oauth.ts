import crypto from "node:crypto";
import express from "express";
import type { Express, Request, Response } from "express";
import { pool } from "./db.js";
import { RateLimiter } from "./rate-limit.js";
import { SESSION_SECRET, sellerFromSession } from "./auth.js";

// MCP OAuth one-click onboarding — spec THI-11 rev 2.
// This module is new auth surface: every change follows the protected-path
// discipline (spec link + explicit human approval in the PR description).
// PR 2 scope: RFC 9728/8414 discovery metadata + RFC 7591 dynamic client
// registration. The authorize/token/revoke endpoints land in later PRs.

const DCR_HOURLY_LIMIT = Number(process.env.OAUTH_DCR_HOURLY_LIMIT ?? 10);
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LEN = 2048;
const MAX_CLIENT_NAME_LEN = 200;
const MAX_CLIENT_URI_LEN = 2048;

/** The three loopback literals whose http redirect URIs are accepted (RFC 8252 §7.3). */
export const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates and canonicalizes one redirect URI at registration time
 * (spec §2.4): absolute https://, or absolute http:// whose host is a
 * loopback literal. Returns the normalized WHATWG href, or null if invalid.
 */
export function normalizeRedirectUri(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > MAX_REDIRECT_URI_LEN) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const loopbackHttp = u.protocol === "http:" && LOOPBACK_HOSTNAMES.has(u.hostname);
  if (u.protocol !== "https:" && !loopbackHttp) return null;
  if (u.username || u.password || u.hash) return null; // no userinfo/fragments in redirect URIs (RFC 6749 §3.1.2)
  return u.href;
}

export function newClientId(): string {
  return `thgc_${crypto.randomBytes(16).toString("base64url")}`; // 22 b64url chars
}

/** Issuer/base URL: PUBLIC_BASE_URL when set, else the request origin (self-hosters, zero config). */
export function issuerFromRequest(req: Request): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (base) return base;
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

function protectedResourceDoc(issuer: string) {
  return { resource: `${issuer}/mcp`, authorization_servers: [issuer] };
}

function authorizationServerDoc(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp"],
    authorization_response_iss_parameter_supported: true,
  };
}

interface RegistrationError extends Error {
  status: number;
  code: string;
}

function registrationError(code: string, description: string): RegistrationError {
  return Object.assign(new Error(description), { status: 400, code });
}

export interface ClientRegistration {
  redirect_uris: string[];
  client_name: string | null;
  client_uri: string | null;
}

/** RFC 7591 registration payload validation (spec §2.4). Unknown fields ignored. */
export function validateClientRegistration(body: unknown): ClientRegistration {
  if (typeof body !== "object" || body === null) {
    throw registrationError("invalid_client_metadata", "request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;

  if (!Array.isArray(raw.redirect_uris) || raw.redirect_uris.length < 1 || raw.redirect_uris.length > MAX_REDIRECT_URIS) {
    throw registrationError("invalid_redirect_uri", `redirect_uris must be an array of 1-${MAX_REDIRECT_URIS} URIs`);
  }
  const redirect_uris: string[] = [];
  for (const candidate of raw.redirect_uris) {
    const normalized = normalizeRedirectUri(candidate);
    if (normalized === null) {
      throw registrationError(
        "invalid_redirect_uri",
        "each redirect_uri must be absolute https://, or http:// on localhost/127.0.0.1/[::1]",
      );
    }
    redirect_uris.push(normalized);
  }

  let client_name: string | null = null;
  if (raw.client_name !== undefined) {
    if (typeof raw.client_name !== "string" || raw.client_name.length > MAX_CLIENT_NAME_LEN) {
      throw registrationError("invalid_client_metadata", `client_name must be a string of at most ${MAX_CLIENT_NAME_LEN} chars`);
    }
    client_name = raw.client_name;
  }

  let client_uri: string | null = null;
  if (raw.client_uri !== undefined) {
    if (typeof raw.client_uri !== "string" || raw.client_uri.length > MAX_CLIENT_URI_LEN) {
      throw registrationError("invalid_client_metadata", `client_uri must be a string of at most ${MAX_CLIENT_URI_LEN} chars`);
    }
    client_uri = raw.client_uri; // stored as data; never rendered as a link (spec §5 row 8)
  }

  return { redirect_uris, client_name, client_uri };
}

/** Mounts the OAuth authorization-server surface (spec §4.1). No CORS headers are ever set on /oauth/*. */
export function mountOauthRoutes(app: Express): void {
  const dcrLimiter = new RateLimiter(DCR_HOURLY_LIMIT, 60 * 60 * 1000);

  const wellKnown =
    (doc: (issuer: string) => unknown) => (req: Request, res: Response): void => {
      res
        .set("Cache-Control", "public, max-age=3600")
        .type("application/json")
        .json(doc(issuerFromRequest(req)));
    };

  app.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    wellKnown(protectedResourceDoc),
  );
  app.get(
    ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"],
    wellKnown(authorizationServerDoc),
  );

  app.post("/oauth/register", async (req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    if (!dcrLimiter.allow(`dcr:${req.ip ?? "unknown"}`)) {
      res.status(429).json({ error: "rate_limited", retry_after_ms: 60 * 60 * 1000 });
      return;
    }
    let registration: ClientRegistration;
    try {
      registration = validateClientRegistration(req.body);
    } catch (e) {
      const err = e as RegistrationError;
      res.status(err.status).json({ error: err.code, error_description: err.message });
      return;
    }
    try {
      const client_id = newClientId();
      const { rows } = await pool.query<{ created_at: Date }>(
        `INSERT INTO oauth_clients (client_id, client_name, client_uri, redirect_uris)
         VALUES ($1, $2, $3, $4) RETURNING created_at`,
        [client_id, registration.client_name, registration.client_uri, registration.redirect_uris],
      );
      res.status(201).json({
        client_id,
        client_id_issued_at: Math.floor(rows[0].created_at.getTime() / 1000),
        client_name: registration.client_name,
        client_uri: registration.client_uri,
        redirect_uris: registration.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mcp",
      });
    } catch (e) {
      console.error("oauth: DCR failed:", (e as Error).message);
      res.status(500).json({ error: "server_error" });
    }
  });

  mountAuthorize(app);
}

// ---------------------------------------------------------------------------
// Authorization endpoint (spec THI-11 §2.5) — login hop, consent, code issuance.

const AUTHORIZE_HOURLY_LIMIT = 30;
const CODE_TTL_S = 60;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/; // S256 digest length (base64url, 32 bytes)
const MAX_STATE_LEN = 2048;

/** Structured security-significant event log (spec §4.5). Never token/code material. */
function securityEvent(kind: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ security_event: kind, ...fields, timestamp: new Date().toISOString() }));
}

function htmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Normative redirect-URI matcher (spec §2.5(2), F3): WHATWG parse of both
 * sides; protocol and pathname exact; hostname exact after case-folding;
 * port ignored ONLY when the registered hostname is one of the three loopback
 * literals (RFC 8252 §7.3 — hosts bind random ports). Never DNS-resolve,
 * never strip trailing dots, never suffix/substring match.
 */
export function redirectUriMatches(presented: string, registered: string): boolean {
  let p: URL;
  let r: URL;
  try {
    p = new URL(presented);
    r = new URL(registered);
  } catch {
    return false;
  }
  if (p.protocol !== r.protocol) return false;
  if (p.pathname !== r.pathname) return false;
  if (p.hostname !== r.hostname) return false;
  if (!LOOPBACK_HOSTNAMES.has(r.hostname) && p.port !== r.port) return false;
  return true;
}

/** Consent CSRF (spec §2.5(5), F8): HMAC over the exact authorization request, domain-separated with "csrf:". */
export function consentCsrfToken(fields: {
  sellerId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
}): string {
  const message = ["csrf:", fields.sellerId, fields.clientId, fields.redirectUri, fields.codeChallenge, fields.nonce].join("|");
  return crypto.createHmac("sha256", SESSION_SECRET).update(message).digest("base64url");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Page/redirect hardening headers (F10): no-store, no-referrer, anti-framing. */
function pageHeaders(res: Response): void {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
  });
}

function errorPage(res: Response, title: string, detail: string): void {
  pageHeaders(res);
  res.status(400).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorization error — Thingery</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.6}</style></head>
<body><h1>Authorization error</h1><p><strong>${htmlEscape(title)}</strong></p><p>${htmlEscape(detail)}</p>
<p><a href="/">Back to Thingery</a></p></body></html>`);
}

/** Appends OAuth response parameters to a validated redirect URI (RFC 9207 `iss` included). */
function redirectWithParams(
  res: Response,
  req: Request,
  redirectUri: string,
  params: Record<string, string | undefined>,
): void {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", issuerFromRequest(req));
  pageHeaders(res);
  res.redirect(302, url.href);
}

interface ClientRow {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
}

async function clientById(clientId: string): Promise<ClientRow | null> {
  const { rows } = await pool.query<ClientRow>(
    `SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  return rows[0] ?? null;
}

interface AuthorizeQuery {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
}

interface ParamCheck {
  error?: string;
  error_description?: string;
  code_challenge?: string;
  scope: string;
}

/**
 * Validation steps 3+ of the §2.5 order — run AFTER client/redirect validation,
 * so failures redirect with error= per RFC 6749 §4.1.2.1. Runs identically on
 * GET and on the consent POST (the POST re-validates in full; the GET render is
 * a convenience, never a source of truth — F8).
 */
function checkAuthorizeParams(q: AuthorizeQuery, issuer: string): ParamCheck {
  const out: ParamCheck = { scope: "mcp" };
  if (q.response_type !== "code") {
    return { ...out, error: "unsupported_response_type", error_description: "only response_type=code is supported" };
  }
  const challenge = q.code_challenge ?? "";
  if (!challenge || !PKCE_CHALLENGE_RE.test(challenge) || q.code_challenge_method !== "S256") {
    return {
      ...out,
      error: "invalid_request",
      error_description: "PKCE is required: code_challenge must be 43 base64url chars and code_challenge_method must be S256",
    };
  }
  if (q.scope !== undefined && q.scope !== "mcp") {
    return { ...out, error: "invalid_scope", error_description: "only the 'mcp' scope is supported" };
  }
  if (q.resource !== undefined && q.resource !== `${issuer}/mcp`) {
    return { ...out, error: "invalid_target", error_description: "resource must be the Thingery /mcp endpoint" };
  }
  if (q.state !== undefined && q.state.length > MAX_STATE_LEN) {
    return { ...out, error: "invalid_request", error_description: "state is too long" };
  }
  return { ...out, code_challenge: challenge };
}

/**
 * Consent page copy (spec §2.5(5) + OQ8: the human reviews this copy before
 * merge of PR 3). client_name is attacker-suppliable DCR text — rendered as
 * text only (htmlEscape), never as HTML or an attribute link.
 */
function consentPageHtml(opts: {
  clientName: string;
  accountLabel: string;
  query: Record<string, string | undefined>;
  csrf: string;
  nonce: string;
}): string {
  const hidden = (name: string, value: string | undefined) =>
    value === undefined ? "" : `<input type="hidden" name="${name}" value="${htmlEscape(value)}">`;
  const q = opts.query;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${htmlEscape(opts.clientName)} — Thingery</title>
<style>:root{color-scheme:light dark}body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:30rem;margin:2rem auto;padding:0 1rem;line-height:1.6}
h1{font-size:1.35rem}button{padding:.6rem 1.2rem;font:inherit;border-radius:8px;cursor:pointer;border:1px solid rgba(127,127,127,.5);margin-right:.5rem}
.allow{background:#2563eb;color:#fff;border-color:#2563eb}.hint{font-size:.9rem;opacity:.8}</style></head>
<body>
<h1>Authorize ${htmlEscape(opts.clientName)}</h1>
<p><strong>${htmlEscape(opts.clientName)}</strong> wants to connect to your Thingery account
<strong>${htmlEscape(opts.accountLabel)}</strong>.</p>
<p>It will be able to read and manage your listings and orders, acting as you.</p>
<form method="post" action="/oauth/authorize">
${hidden("client_id", q.client_id)}${hidden("redirect_uri", q.redirect_uri)}${hidden("response_type", q.response_type)}
${hidden("scope", q.scope)}${hidden("state", q.state)}${hidden("code_challenge", q.code_challenge)}
${hidden("code_challenge_method", q.code_challenge_method)}${hidden("resource", q.resource)}
${hidden("csrf", opts.csrf)}${hidden("nonce", opts.nonce)}
<button type="submit" name="action" value="deny">Deny</button>
<button type="submit" name="action" value="allow" class="allow">Allow</button>
</form>
<p class="hint">Only allow applications you trust. You can review and disconnect connected applications
anytime from your account page.</p>
</body></html>`;
}

function mountAuthorize(app: Express): void {
  const authorizeLimiter = new RateLimiter(AUTHORIZE_HOURLY_LIMIT, 60 * 60 * 1000);

  /** Validation steps 1–2: unknown client or unregistered redirect → 400 page, never a redirect. */
  const validateClientAndRedirect = async (q: AuthorizeQuery): Promise<
    { client: ClientRow; redirectUri: string } | { errorPage: { title: string; detail: string } }
  > => {
    if (!q.client_id) return { errorPage: { title: "Missing client_id", detail: "The authorization request is incomplete." } };
    const client = await clientById(q.client_id);
    if (!client) return { errorPage: { title: "Unknown application", detail: "This client is not registered with Thingery." } };
    if (!q.redirect_uri || !client.redirect_uris.some((registered) => redirectUriMatches(q.redirect_uri as string, registered))) {
      return {
        errorPage: {
          title: "Invalid redirect URI",
          detail: "The redirect URI does not match a URI registered for this application.",
        },
      };
    }
    return { client, redirectUri: new URL(q.redirect_uri).href };
  };

  app.get("/oauth/authorize", async (req: Request, res: Response) => {
    if (!authorizeLimiter.allow(`authz:${req.ip ?? "unknown"}`)) {
      res.status(429).type("text").send("Too many authorization requests. Try again later.");
      return;
    }
    const q = req.query as AuthorizeQuery;
    const validated = await validateClientAndRedirect(q);
    if ("errorPage" in validated) {
      errorPage(res, validated.errorPage.title, validated.errorPage.detail);
      return;
    }
    const issuer = issuerFromRequest(req);
    const check = checkAuthorizeParams(q, issuer);
    if (check.error) {
      redirectWithParams(res, req, validated.redirectUri, {
        error: check.error,
        error_description: check.error_description,
        state: q.state,
      });
      return;
    }
    const seller = await sellerFromSession(req);
    if (!seller) {
      pageHeaders(res);
      res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    const nonce = crypto.randomBytes(16).toString("base64url");
    const csrf = consentCsrfToken({
      sellerId: seller.id,
      clientId: validated.client.client_id,
      redirectUri: validated.redirectUri,
      codeChallenge: check.code_challenge as string,
      nonce,
    });
    const { rows } = await pool.query<{ email: string | null }>(`SELECT email FROM sellers WHERE id = $1`, [seller.id]);
    pageHeaders(res);
    res.type("html").send(
      consentPageHtml({
        clientName: validated.client.client_name ?? validated.client.client_id,
        accountLabel: rows[0]?.email ?? seller.display_name,
        query: {
          client_id: q.client_id,
          redirect_uri: validated.redirectUri,
          response_type: q.response_type,
          scope: q.scope,
          state: q.state,
          code_challenge: check.code_challenge,
          code_challenge_method: q.code_challenge_method,
          resource: q.resource,
        },
        csrf,
        nonce,
      }),
    );
  });

  app.post(
    "/oauth/authorize",
    express.urlencoded({ extended: false, limit: "64kb" }),
    async (req: Request, res: Response) => {
      if (!authorizeLimiter.allow(`authz:${req.ip ?? "unknown"}`)) {
        res.status(429).type("text").send("Too many authorization requests. Try again later.");
        return;
      }
      const body = req.body as Record<string, string>;
      const q = body as AuthorizeQuery & { action?: string };
      const validated = await validateClientAndRedirect(q);
      if ("errorPage" in validated) {
        errorPage(res, validated.errorPage.title, validated.errorPage.detail);
        return;
      }
      const issuer = issuerFromRequest(req);
      const check = checkAuthorizeParams(q, issuer);
      if (check.error) {
        redirectWithParams(res, req, validated.redirectUri, {
          error: check.error,
          error_description: check.error_description,
          state: q.state,
        });
        return;
      }
      const seller = await sellerFromSession(req);
      if (!seller) {
        // Session expired between consent render and submit: restart at login,
        // carrying the submitted authorization request as next (GET re-validates
        // every parameter independently — next can never smuggle past that).
        const nextQuery = new URLSearchParams();
        for (const key of [
          "client_id",
          "redirect_uri",
          "response_type",
          "scope",
          "state",
          "code_challenge",
          "code_challenge_method",
          "resource",
        ] as const) {
          const value = (q as Record<string, string | undefined>)[key];
          if (value !== undefined) nextQuery.set(key, value);
        }
        pageHeaders(res);
        res.redirect(302, `/login.html?next=${encodeURIComponent(`/oauth/authorize?${nextQuery.toString()}`)}`);
        return;
      }
      // CSRF contract (F8): recompute the HMAC over the SUBMITTED fields plus
      // the CURRENT session's seller_id — mismatch means this POST did not come
      // from a consent page rendered for this session and this request.
      const expected = consentCsrfToken({
        sellerId: seller.id,
        clientId: validated.client.client_id,
        redirectUri: validated.redirectUri,
        codeChallenge: check.code_challenge as string,
        nonce: body.nonce ?? "",
      });
      const submitted = Buffer.from(body.csrf ?? "");
      const expectedBuf = Buffer.from(expected);
      const csrfOk = submitted.length === expectedBuf.length && crypto.timingSafeEqual(submitted, expectedBuf);
      if (!csrfOk) {
        securityEvent("csrf_rejected", { client_id: validated.client.client_id, seller_id: seller.id, ip: req.ip });
        errorPage(res, "Invalid request", "The authorization request could not be verified. Please start again.");
        return;
      }
      if (q.action !== "allow") {
        redirectWithParams(res, req, validated.redirectUri, { error: "access_denied", state: q.state });
        return;
      }

      // One transaction (F5): revoke prior active grants for this (seller,
      // client) — one live grant per client — then issue the fresh grant+code.
      const code = `thga_${crypto.randomBytes(32).toString("base64url")}`;
      const codeHash = sha256Hex(code);
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query(
          `UPDATE oauth_grants SET revoked_at = now() WHERE seller_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
          [seller.id, validated.client.client_id],
        );
        const grant = await db.query<{ id: string }>(
          `INSERT INTO oauth_grants (seller_id, client_id, scope) VALUES ($1, $2, $3) RETURNING id`,
          [seller.id, validated.client.client_id, check.scope],
        );
        await db.query(
          `INSERT INTO oauth_codes (code_hash, grant_id, client_id, seller_id, redirect_uri, code_challenge, resource, scope, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))`,
          [
            codeHash,
            grant.rows[0].id,
            validated.client.client_id,
            seller.id,
            validated.redirectUri,
            check.code_challenge,
            q.resource,
            check.scope,
            CODE_TTL_S,
          ],
        );
        await db.query(`UPDATE oauth_clients SET authorized_at = now() WHERE client_id = $1 AND authorized_at IS NULL`, [
          validated.client.client_id,
        ]);
        await db.query("COMMIT");
      } catch (e) {
        await db.query("ROLLBACK").catch(() => {});
        db.release();
        console.error("oauth: authorize issuance failed:", (e as Error).message);
        res.status(500).type("text").send("Authorization failed. Please try again.");
        return;
      }
      db.release();
      redirectWithParams(res, req, validated.redirectUri, { code, state: q.state });
    },
  );
}
