// Embeddings via any OpenAI-compatible /v1/embeddings endpoint.
// Returns null when unconfigured or on failure — callers fall back to keyword search.

/** All embedding columns are vector(1536) (db/schema.sql). A provider whose
 *  model returns a different dimensionality would make every INSERT that
 *  carries an embedding fail — THI-466 guard: drop the vector (keyword
 *  fallback for that row) and warn, never 500 the write path. */
export const EXPECTED_EMBEDDING_DIMS = 1536;

const DEFAULT_EMBED_API_URL = "https://api.openai.com/v1/embeddings";

/** Normalizes EMBED_API_URL: a full `…/embeddings` URL is used as-is; a base
 *  such as `https://api.z.ai/api/paas/v4/` gets `/embeddings` appended
 *  (mirrors normalizeBaseUrl for LLM_API_URL — THI-466 R1: prod shipped a
 *  base URL and every embeddings call 404'd). Unparseable input falls back
 *  to the default endpoint. */
export function normalizeEmbeddingsUrl(input: string | undefined): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return DEFAULT_EMBED_API_URL;
  try {
    const url = new URL(trimmed);
    if (url.pathname.endsWith("/embeddings")) return url.toString();
    url.pathname = url.pathname.replace(/\/+$/, "") + "/embeddings";
    return url.toString();
  } catch {
    return DEFAULT_EMBED_API_URL;
  }
}

let warnedBadEmbedDims = false;

/** Optional EMBED_DIMS override: when set to a positive integer the request
 *  carries `dimensions: N` (OpenAI embeddings API parameter; zhipu/z.ai
 *  embedding-3 accepts 256–2048 and defaults to 2048, so providers at a
 *  non-1536 default need this to satisfy the vector(1536) columns).
 *  Providers that ignore the parameter still hit the EXPECTED_EMBEDDING_DIMS
 *  guard in embedText — wrong-dim vectors are dropped, never written.
 *  THI-1743: z.ai restoration route (buy zhipu embeddings package). */
export function requestedDimensions(): number | null {
  const raw = (process.env.EMBED_DIMS ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    if (!warnedBadEmbedDims) {
      warnedBadEmbedDims = true;
      console.warn(
        `[embed] EMBED_DIMS="${raw}" is not a positive integer — ignoring; request will omit the dimensions parameter`,
      );
    }
    return null;
  }
  return n;
}

export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.EMBED_API_KEY;
  if (!apiKey) return null;
  const url = normalizeEmbeddingsUrl(process.env.EMBED_API_URL);
  const model = process.env.EMBED_MODEL ?? "text-embedding-3-small";
  const dimensions = requestedDimensions();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text.slice(0, 8000),
        ...(dimensions ? { dimensions } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = json.data?.[0]?.embedding ?? null;
    if (embedding && embedding.length !== EXPECTED_EMBEDDING_DIMS) {
      console.warn(
        `[embed] model ${model} returned ${embedding.length} dims, expected ${EXPECTED_EMBEDDING_DIMS} — dropping vector (keyword fallback); check EMBED_MODEL`,
      );
      return null;
    }
    return embedding;
  } catch {
    return null;
  }
}

// The text an item is indexed by: weighted toward title, brand and category.
// Category-specific attributes are flattened in ("size eu: 43") so they are
// semantically searchable too.
export function itemEmbeddingText(input: {
  title: string;
  description: string;
  category: string;
  condition: string;
  brand?: string | null;
  attributes?: Record<string, string | number | boolean>;
}): string {
  return [
    input.title,
    input.title,
    input.brand ?? "",
    input.category,
    input.condition.replace(/_/g, " "),
    input.description,
    Object.entries(input.attributes ?? {})
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
      .join("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}
