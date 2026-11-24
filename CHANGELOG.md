# Changelog

Notable consumer-facing changes to the `thingery` npm package and MCP server.
Entries land under **Unreleased** and move into the version header when a
release ships (tags and release notes live on
[GitHub Releases](https://github.com/thingery/thingery/releases)).

API-evolution rule: we do not promise exact validation-error strings — wording
may change without a major version bump.

## [Unreleased]

### Changed

- **zod v4 internals (THI-326).** Request validation now runs on zod 4.x. Tool
  behavior contracts are unchanged, but consumer-visible surfaces drifted:
  - **Error wording:** stock zod messages surfaced inside MCP `INVALID_PARAMS`
    (-32602) errors are now zod v4 style (e.g. `"Invalid URL"` with issue code
    `"invalid_format"`, instead of v3's `"Invalid url"` / `"invalid_string"`).
    Custom messages (e.g. `"image URLs must be http(s)"`) are unchanged.
  - **Advertised JSON Schemas** (`tools/list`, converted with zod's
    `io: "input"`) drifted cosmetically: top-level `additionalProperties: false`
    is no longer advertised on tool input objects; `record` fields gain a
    `propertyNames` schema; integer fields gain safe-int `minimum`/`maximum`
    bounds; `uuid` fields gain a `pattern`. Validation semantics are unchanged
    and pinned by the test suite.
  - **URL inputs:** `z.string().url()` now validates via the WHATWG parser and
    stores the whitespace-trimmed value — `" https://example.com/a.jpg"` is
    accepted and stored as `"https://example.com/a.jpg"` (scheme case and inner
    characters preserved). The http(s) scheme allowlist still rejects
    `javascript:`, `data:` and `file:` URLs, including padding-prefixed
    attempts; the class is pinned in `tests/image-url-allowlist.test.ts`
    (THI-333).
