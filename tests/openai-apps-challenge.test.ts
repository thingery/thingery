// THI-296 AC1: OpenAI plugin directory domain-verification route. Pure HTTP
// tests over a bare express app — no DB needed (the handler is a single env
// read). Covers: exact-token 200 with text/plain + no-store, 503-safe while
// the env is unset or empty, no JSON wrapping, and HEAD passthrough.

import express from "express";
import type { Server } from "node:http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mountOpenaiAppsChallenge } from "../src/openai-apps-challenge.js";

const ORIGINAL = process.env.OPENAI_APPS_CHALLENGE_TOKEN;

let server: Server | null = null;

function listen(): Promise<string> {
  const app = express();
  mountOpenaiAppsChallenge(app);
  return new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

async function get(base: string, path: string, method = "GET"): Promise<Response> {
  return fetch(`${base}${path}`, { method });
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.OPENAI_APPS_CHALLENGE_TOKEN;
  else process.env.OPENAI_APPS_CHALLENGE_TOKEN = ORIGINAL;
});

afterAll(() => {
  server?.close();
});

describe("GET /.well-known/openai-apps-challenge", () => {
  it("returns the exact token as plain text with no-store when the env is set", async () => {
    process.env.OPENAI_APPS_CHALLENGE_TOKEN = "openai-apps-challenge-3f9a2c";
    const base = await listen();
    const res = await get(base, "/.well-known/openai-apps-challenge");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("openai-apps-challenge-3f9a2c");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("does not wrap the token in JSON", async () => {
    process.env.OPENAI_APPS_CHALLENGE_TOKEN = "tok-123";
    const base = await listen();
    const res = await get(base, "/.well-known/openai-apps-challenge");
    const body = await res.text();
    expect(body).toBe("tok-123");
    expect(body).not.toContain("{");
    expect(res.headers.get("content-type")).not.toContain("json");
  });

  it("answers 503 while the token is unset", async () => {
    delete process.env.OPENAI_APPS_CHALLENGE_TOKEN;
    const base = await listen();
    const res = await get(base, "/.well-known/openai-apps-challenge");
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 while the token is an empty string", async () => {
    process.env.OPENAI_APPS_CHALLENGE_TOKEN = "";
    const base = await listen();
    const res = await get(base, "/.well-known/openai-apps-challenge");
    expect(res.status).toBe(503);
  });
});
