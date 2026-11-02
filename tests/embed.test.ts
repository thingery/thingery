// THI-466: embeddings activation hardening — URL normalization (R1: prod
// shipped a base URL and every call 404'd) and the vector(1536) dimension
// guard (a provider returning other dims must degrade to keyword fallback,
// never fail the INSERT write path).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPECTED_EMBEDDING_DIMS,
  embedText,
  normalizeEmbeddingsUrl,
} from "../src/embed.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EMBED_API_KEY;
  delete process.env.EMBED_API_URL;
  delete process.env.EMBED_MODEL;
});

describe("normalizeEmbeddingsUrl (THI-466 R1)", () => {
  it("uses a full …/embeddings URL as-is", () => {
    expect(normalizeEmbeddingsUrl("https://api.openai.com/v1/embeddings")).toBe(
      "https://api.openai.com/v1/embeddings",
    );
  });

  it("appends /embeddings to a bare base URL (prod z.ai case)", () => {
    expect(normalizeEmbeddingsUrl("https://api.z.ai/api/paas/v4/")).toBe(
      "https://api.z.ai/api/paas/v4/embeddings",
    );
  });

  it("appends /embeddings to a base without trailing slash", () => {
    expect(normalizeEmbeddingsUrl("https://example.com/api/v4")).toBe(
      "https://example.com/api/v4/embeddings",
    );
  });

  it("collapses trailing slashes before appending", () => {
    expect(normalizeEmbeddingsUrl("https://example.com/v1///")).toBe(
      "https://example.com/v1/embeddings",
    );
  });

  it("defaults to the OpenAI endpoint for empty or unparseable input", () => {
    expect(normalizeEmbeddingsUrl(undefined)).toBe("https://api.openai.com/v1/embeddings");
    expect(normalizeEmbeddingsUrl("")).toBe("https://api.openai.com/v1/embeddings");
    expect(normalizeEmbeddingsUrl("not a url")).toBe("https://api.openai.com/v1/embeddings");
  });

  it("preserves query strings and ports", () => {
    expect(normalizeEmbeddingsUrl("https://example.com:8443/v1?key=abc")).toBe(
      "https://example.com:8443/v1/embeddings?key=abc",
    );
  });
});

describe("embedText dimension guard (THI-466)", () => {
  const okBody = (dims: number) => ({ data: [{ embedding: Array.from({ length: dims }, (_, i) => i % 7) }] });

  const stubFetch = (status: number, body: unknown, captures: string[] = []) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        captures.push(url);
        if (init?.body) captures.push(init.body);
        return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
      }),
    );
  };

  it("returns the vector when dims match EXPECTED_EMBEDDING_DIMS and posts to the normalized URL", async () => {
    process.env.EMBED_API_KEY = "test-key";
    process.env.EMBED_API_URL = "https://api.z.ai/api/paas/v4/";
    const captures: string[] = [];
    stubFetch(200, okBody(EXPECTED_EMBEDDING_DIMS), captures);
    const out = await embedText("running shoes");
    expect(out).toHaveLength(EXPECTED_EMBEDDING_DIMS);
    expect(captures[0]).toBe("https://api.z.ai/api/paas/v4/embeddings");
  });

  it("returns null (never a short vector) when the model returns other dims", async () => {
    process.env.EMBED_API_KEY = "test-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(200, okBody(768));
    const out = await embedText("running shoes");
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("768"));
    warn.mockRestore();
  });

  it("returns null on non-ok responses (keyword fallback)", async () => {
    process.env.EMBED_API_KEY = "test-key";
    stubFetch(429, { error: { code: "1113", message: "Insufficient balance" } });
    expect(await embedText("running shoes")).toBeNull();
  });

  it("returns null without calling the API when unconfigured", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    expect(await embedText("running shoes")).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});
