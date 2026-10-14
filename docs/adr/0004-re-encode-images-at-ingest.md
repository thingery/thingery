# ADR 0004 — Re-encode images at ingest: strip metadata, produce safe display copy

**Status:** Accepted (2026-10-14) · **Related:** THI-156 (spec rev 2), THI-159 (Security review), THI-110/111/112 (upload abuse controls)

## Context

Seller uploads were persisted byte-for-byte and served unauthenticated via `/img/**`, item pages, og:image, and MCP `search_items`/`get_item`/`my_listings` image URLs. JPEG EXIF (GPS, device info), PNG text chunks, WebP EXIF/XMP, and GIF comments survived to every buyer and search agent; the 5 MB cap was bytes-only with no pixel guard.

## Decision

Re-encode every uploaded image server-side at ingest into a metadata-free, same-family display copy and never persist original bytes. sharp (libvips) is the only new dependency, **exact-pinned** (0.35.5 at adoption) because older bundled natives carry live CVEs. Pipeline: header-parsed pixel budget (`limitInputPixels` 50 MP) with `failOn: "warning"`, `.autoOrient()`, resize to ≤ 2000 px long edge, same-family re-encode without `.withMetadata()`, output ≤ 5 MB with magic-byte re-validation, first-frame stills for GIFs. Startup hardening: libvips loader blocklist (only the four allowlisted buffer loaders unblocked), `concurrency(2)`, `cache(false)`, and a decode semaphore that fails fast when saturated. A one-shot backfill re-encodes pre-existing files in place, originals moved to a sibling backup dir outside the served tree.

## Alternatives rejected

- **Marker-surgery EXIF stripping** — rewrites headers without re-encoding; format-parser bug surface; the community task explicitly required re-encode.
- **`jimp` (pure JS)** — slow decode, weak decompression-bomb resistance, animated-GIF write gaps.
- **Client-side stripping** — server cannot trust clients.
- **Private originals + public display variant** — retains high-risk original bytes on disk; two artifacts and more leak paths for the same privacy outcome.
- **Own header-sniff dimension guard** — re-parses the same headers with less validation than libvips; `limitInputPixels` checks at header parse before allocation (THI-159 answer 2).

## Consequences

- First native dependency (pinned, musl prebuilds via npm ci; bumps go through Security's lockfile review).
- Accepted degradations: slight wide-gamut desaturation (ICC dropped), animated GIFs become stills, some large photographic PNGs rejected at the 5 MB output budget.
- Buyers/search agents can only ever retrieve the safe copy; originals unreachable by construction.
- Pre-existing uploads require a backfill; existing encrypted nightly archives retain EXIF originals up to 14 d local / 30 d offsite (disclosed residual risk, THI-159 F8).
- Decode CPU bounded by semaphore + existing quotas; multi-account floods can still burn bounded CPU-minutes/day (accepted at this scale).
