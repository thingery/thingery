# Search relevance suite (THI-393)

A 20-query buyer-experience benchmark for `search_items`, covering the two
adoption-sprint seed categories (fashion sneakers + consumer electronics).
It answers one question with numbers: **when a realistic buyer searches, do
the right listings come back?**

## Run

```bash
node scripts/search-relevance/run.mjs                    # against prod (thingery.dev/mcp)
node scripts/search-relevance/run.mjs --mcp-url http://localhost:3000/mcp --json results.json
```

Pure Node ≥ 20, no dependencies. Anonymous calls stay under the /mcp anon
rate bucket (30/min). Exit code is always 0 — this is a measurement tool,
not a CI gate.

## Suite shape

`suite.json` pins each query to a **corpus snapshot** (the feed-visible
listings on the `snapshot_date`) and carries graded relevance judgments:

- grade 3 — bullseye, exactly what the buyer described
- grade 2 — relevant
- grade 1 — marginal / partial match
- grade 0 (implicit) — irrelevant
- `expected: []` — a **no-inventory probe**: nothing in the corpus matches,
  and the correct answer is zero results.

Query types: `exact` (model numbers, titles), `fuzzy` (paraphrases, buyer
vocabulary, cross-lingual), `browse` (category words, filters, known-empty).

## Scoring

- Judged queries: per-query score = **nDCG@5** with gains `2^grade − 1`
  (7/3/1). Nothing returned ⇒ 0.
- No-inventory probes: score 1 iff zero results, else 0.
- **Baseline relevance score** = mean per-query score × 100.
- hit@1/3/5 and MRR count only grade ≥ 2 results.
- Results whose id is not in the corpus snapshot are reported as
  `unjudged` (corpus drift), never silently graded.

## Re-baselining

The corpus is tiny (9 listings at snapshot 2026-10-31) and will drift as the
sprint seeds inventory. To re-baseline:

1. Run with `--json`, inspect `unjudgedResultsTotal`; if non-zero, new
   listings exist that the judgments don't cover.
2. Re-judge affected queries in `suite.json` (add expected grades for new
   items), bump `snapshot_date`.
3. Re-run and compare `baselineRelevanceScore`.

When embeddings are enabled on the target, the report notes
`search mode: semantic`; with no embedding config it reports
`keyword fallback` — the two modes are not comparable baselines.
