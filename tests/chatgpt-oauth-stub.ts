// Local stub harness for the "Sign in with ChatGPT" browser OAuth flow
// (spec THI-193 §7, PR-2): a real local HTTP server faking the pinned
// provider endpoints — authorize (issues single-use codes bound to the
// connect request's PKCE challenge + nonce), token (fixed-shape responses
// with rotating refresh tokens and RS256 ID tokens signed by an RSA key
// generated at harness start), JWKS, revocation, and the /v1/models
// catalog. The app's pinned https://auth.openai.com / https://api.openai.com
// URLs are remapped onto this server by a global-fetch proxy the test
// installs with vi.stubGlobal — real provider endpoints are NEVER hit, and a
// call to any other non-app URL throws (config drift fails the test, it
// never silently reaches the network). Fixtures stay in the gitleaks-safe
// chatgpt_test_ namespace (low-entropy strings, never real credentials).

import crypto from "node:crypto";
import http from "node:http";
import type { Server } from "node:http";

export const STUB_ISSUER = "https://auth.openai.com";
export const STUB_SUB = "auth0|chatgpt_test_sub";
export const STUB_KID = "chatgpt_test_kid_1";
export const STUB_FULL_SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const STUB_DEFAULT_MODEL = "chatgpt_test_model_list_1";

/** Claim overrides for the next issued ID token (wrong-iss/aud/exp/nonce
 *  cases flip exactly one field at a time). */
export interface StubIdTokenOverrides {
  iss?: string;
  aud?: string;
  nonce?: string;
  sub?: string;
  exp?: number;
  iat?: number;
}

export interface StubAuthorizeCall {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  resource: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: string;
}

export interface StubTokenCall {
  grantType: string;
  code?: string;
  clientId: string;
  redirectUri?: string;
  codeVerifier?: string;
  refreshToken?: string;
  resource?: string;
  /** Decoded `client_id:client_secret` when Basic auth was used. */
  basicAuth: string | null;
  /** The raw form fields as received (the confidential-client test asserts
   *  the secret never appears in any of THEM or in the URL). */
  form: Record<string, string>;
}

export interface StubRevokeCall {
  token: string;
  tokenTypeHint: string;
  clientId: string;
  /** Decoded `client_id:client_secret` when Basic auth was used. */
  basicAuth: string | null;
}

export interface ChatgptStubState {
  /** Granted-scope string the token endpoint returns (plan-gate cases drop
   *  chatgpt.tokens.use.direct from it). */
  scopes: string;
  /** Forced non-200 status for the token endpoint (0 = issue normally). */
  tokenStatus: number;
  /** Forced status for revocation (default 200; 500 ⇒ unconfirmed branch). */
  revokeStatus: number;
  /** Forced status for /v1/models (default 200). */
  modelsStatus: number;
  /** ID-token claim overrides for every token this state issues. */
  idTokenOverrides: StubIdTokenOverrides;
  /** Sign ID tokens with a key that is NOT in the served JWKS. */
  signWithWrongKey: boolean;
  /** The account model catalog served at /v1/models. */
  modelsData: Array<{ slug: string; visibility: string }>;
}

export interface ChatgptStub {
  base: string;
  state: ChatgptStubState;
  authorizeCalls: StubAuthorizeCall[];
  tokenCalls: StubTokenCall[];
  revokeCalls: StubRevokeCall[];
  /** Authorization bearers seen at /v1/models (models-catalog calls). */
  modelBearers: string[];
  /** Restores default state and clears recorded calls (keys/server stay). */
  reset(): void;
  close(): Promise<void>;
}

const KID = STUB_KID;

function signIdToken(claims: Record<string, unknown>, key: crypto.KeyObject): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const signingInput = `${enc({ alg: "RS256", typ: "JWT", kid: KID })}.${enc(claims)}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), key);
  return `${signingInput}.${sig.toString("base64url")}`;
}

function basicAuthOf(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return null;
  return Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk as string;
  return body.slice(0, 64 * 1024);
}

/** Starts the fake provider: one RSA keypair generated now, JWKS served from
 *  it, ID tokens signed with it (or the unpaired wrong key on demand). */
export async function startChatgptStub(): Promise<ChatgptStub> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const wrongKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };
  const jwks = { keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] };

  const state: ChatgptStubState = {
    scopes: STUB_FULL_SCOPES,
    tokenStatus: 0,
    revokeStatus: 200,
    modelsStatus: 200,
    idTokenOverrides: {},
    signWithWrongKey: false,
    modelsData: [
      { slug: "chatgpt_test_model_hidden", visibility: "hidden" },
      { slug: STUB_DEFAULT_MODEL, visibility: "list" },
      { slug: "chatgpt_test_model_list_2", visibility: "list" },
    ],
  };
  const authorizeCalls: StubAuthorizeCall[] = [];
  const tokenCalls: StubTokenCall[] = [];
  const revokeCalls: StubRevokeCall[] = [];
  const modelBearers: string[] = [];
  // Single-use codes bound to the authorize request's PKCE challenge.
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string; nonce: string }>();
  let codeN = 0;
  let tokenN = 0;
  const resetCounters = (): void => {
    codeN = 0;
    tokenN = 0;
  };

  const server: Server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://chatgpt.test");
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && url.pathname === "/.well-known/jwks.json") {
        res.end(JSON.stringify(jwks));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/accounts/authorize") {
        const p = url.searchParams;
        authorizeCalls.push({
          clientId: p.get("client_id") ?? "",
          redirectUri: p.get("redirect_uri") ?? "",
          responseType: p.get("response_type") ?? "",
          scope: p.get("scope") ?? "",
          resource: p.get("resource") ?? "",
          state: p.get("state") ?? "",
          nonce: p.get("nonce") ?? "",
          codeChallenge: p.get("code_challenge") ?? "",
          codeChallengeMethod: p.get("code_challenge_method") ?? "",
        });
        if (p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256") {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "unsupported_response_type" }));
          return;
        }
        codeN += 1;
        const code = `chatgpt_test_code_${codeN}`;
        codes.set(code, {
          challenge: p.get("code_challenge") ?? "",
          redirectUri: p.get("redirect_uri") ?? "",
          clientId: p.get("client_id") ?? "",
          nonce: p.get("nonce") ?? "",
        });
        const cb = new URL(p.get("redirect_uri") ?? "http://invalid");
        cb.searchParams.set("code", code);
        cb.searchParams.set("state", p.get("state") ?? "");
        res.writeHead(302, { location: cb.toString() });
        res.end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/accounts/oauth/token") {
        const form = new URLSearchParams(await readBody(req));
        const formEntries: Record<string, string> = {};
        for (const [k, v] of form.entries()) formEntries[k] = v;
        const call: StubTokenCall = {
          grantType: form.get("grant_type") ?? "",
          code: form.get("code") ?? undefined,
          clientId: form.get("client_id") ?? "",
          redirectUri: form.get("redirect_uri") ?? undefined,
          codeVerifier: form.get("code_verifier") ?? undefined,
          refreshToken: form.get("refresh_token") ?? undefined,
          resource: form.get("resource") ?? undefined,
          basicAuth: basicAuthOf(req),
          form: formEntries,
        };
        tokenCalls.push(call);
        if (state.tokenStatus !== 0) {
          res.statusCode = state.tokenStatus;
          res.end(JSON.stringify({ error: "temporarily_unavailable" }));
          return;
        }
        const code = codes.get(call.code ?? "");
        // Single-use code, exact redirect_uri/client_id, PKCE S256 echo.
        if (call.grantType !== "authorization_code" || !code) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        codes.delete(call.code ?? "");
        if (code.redirectUri !== call.redirectUri || code.clientId !== call.clientId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        const got = crypto.createHash("sha256").update(call.codeVerifier ?? "").digest("base64url");
        if (got !== code.challenge) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        tokenN += 1;
        const now = Math.floor(Date.now() / 1000);
        const o = state.idTokenOverrides;
        const idToken = signIdToken(
          {
            iss: o.iss ?? STUB_ISSUER,
            aud: o.aud ?? code.clientId,
            sub: o.sub ?? STUB_SUB,
            nonce: o.nonce ?? code.nonce,
            iat: o.iat ?? now,
            exp: o.exp ?? now + 3600,
          },
          state.signWithWrongKey ? wrongKey : privateKey,
        );
        res.end(
          JSON.stringify({
            access_token: `chatgpt_test_at_${tokenN}`,
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: `chatgpt_test_rt_${tokenN}`,
            scope: state.scopes,
            id_token: idToken,
            earliest_refresh_at: new Date(Date.now() - 60_000).toISOString(),
            resource: "https://api.openai.com/v1",
          }),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/accounts/oauth/revoke") {
        const form = new URLSearchParams(await readBody(req));
        revokeCalls.push({
          token: form.get("token") ?? "",
          tokenTypeHint: form.get("token_type_hint") ?? "",
          clientId: form.get("client_id") ?? "",
          basicAuth: basicAuthOf(req),
        });
        res.statusCode = state.revokeStatus;
        res.end(state.revokeStatus === 200 ? "{}" : JSON.stringify({ error: "server_error" }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        modelBearers.push(req.headers.authorization ?? "");
        res.statusCode = state.modelsStatus;
        res.end(JSON.stringify({ data: state.modelsData }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    })().catch(() => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "stub_failure" }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    base,
    state,
    authorizeCalls,
    tokenCalls,
    revokeCalls,
    modelBearers,
    reset() {
      state.scopes = STUB_FULL_SCOPES;
      state.tokenStatus = 0;
      state.revokeStatus = 200;
      state.modelsStatus = 200;
      state.idTokenOverrides = {};
      state.signWithWrongKey = false;
      state.modelsData = [
        { slug: "chatgpt_test_model_hidden", visibility: "hidden" },
        { slug: STUB_DEFAULT_MODEL, visibility: "list" },
        { slug: "chatgpt_test_model_list_2", visibility: "list" },
      ];
      authorizeCalls.length = 0;
      tokenCalls.length = 0;
      revokeCalls.length = 0;
      modelBearers.length = 0;
      codes.clear();
      resetCounters();
    },
    close() {
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

export interface ProviderFetchProxy {
  fetch: typeof globalThis.fetch;
  /** Every provider-bound call (method + pinned URL) that was proxied. */
  calls: Array<{ method: string; url: string }>;
}

/** Global-fetch proxy for tests: pinned provider URLs are rewritten onto the
 *  stub server, calls to the app under test pass through untouched, and any
 *  other URL throws — the app must never reach an unpinned endpoint. */
export function createProviderFetchProxy(
  realFetch: typeof globalThis.fetch,
  stubBase: string,
  appBase: string,
): ProviderFetchProxy {
  const calls: Array<{ method: string; url: string }> = [];
  const proxied = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(appBase)) return realFetch(input as Parameters<typeof fetch>[0], init);
    const mapped = url
      .replace(/^https:\/\/auth\.openai\.com(?=\/)/, stubBase)
      .replace(/^https:\/\/api\.openai\.com(?=\/)/, stubBase);
    if (mapped === url) {
      throw new Error(`chatgpt stub: refusing unexpected URL ${url.split("?")[0]}`);
    }
    calls.push({ method: init?.method ?? "GET", url });
    return realFetch(mapped as Parameters<typeof fetch>[0], init);
  }) as typeof globalThis.fetch;
  return { fetch: proxied, calls };
}
