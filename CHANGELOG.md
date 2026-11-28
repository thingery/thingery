# Changelog

Notable consumer-facing changes to the `thingery` npm package and MCP server.
Entries land under **Unreleased** and move into the version header when a
release ships (tags and release notes live on
[GitHub Releases](https://github.com/thingery/thingery/releases)).

API-evolution rule: we do not promise exact validation-error strings — wording
may change without a major version bump.

## [Unreleased]

### Fixed

- **IPv6 clients no longer share one rate-limit bucket (THI-1706).** The
  production/self-host compose network is now IPv6-enabled. Previously every
  inbound IPv6 connection was bridged through Docker's userland proxy, which
  erased the client IP — all IPv6 visitors appeared as one address
  (the bridge gateway), so the 10-attempts/hour auth limiter (and every other
  IP-keyed limiter) bucketed them together and 429'd the whole IPv6 internet
  after ten signups/logins per hour. With `enable_ipv6` + a ULA subnet on the
  compose network, Docker 27+ DNATs inbound v6 straight to the container and
  preserves the real client source IP. Ops-only: no app behavior change apart
  from correct per-IP limiting; first `up -d` after upgrading restarts all
  services once (network recreation — see `docs/deploy-vps.md` §5).

### Changed

- **The /apps page follows the site locale cookie (THI-1953).** The legacy
  connected-apps page — the documented revoke URL linked from privacy and
  security pages — now renders in Italian when the browser carries the
  `thingery_locale=it` cookie set by the thingery.dev web app, matching the
  web app's voice ("App collegate", "Scollega"). Every other cookie value
  (absent, `en`, unknown) renders English exactly as before, and the change is
  cookie-only: no Accept-Language sniffing, no routing change, so self-hosted
  behavior is unchanged for anyone not carrying the cookie.

- **Order email text fixes (THI-1585).** Order emails no longer show raw
  internal codes: cancel/refund reasons, dispute outcomes, and order
  statuses render in plain English (unknown values fall back to neutral
  copy, never the raw code), and the payment deadline renders as a
  readable date with an explicit UTC time zone instead of a raw ISO
  timestamp. The never-rendered "Pay here" link parameter was removed —
  buyers pay via their assistant's checkout link, as before.

- **`update_listing` attribute registry validation (THI-1369).** Update payloads
  that replace `attributes` are now validated against the item's stored
  category definitions — the same checks `create_listing` has always run
  (declared-required keys present, declared keys type/enum-valid, undeclared
  keys pass through). Previously the update path enforced shape caps only
  (64 entries / 128-char keys / 500-char values), so agents could drop a
  required attribute (e.g. a game's `platform`) or write wrong-case enum
  values that create would reject. Rejections use the same structured
  `invalid_attributes` error as create. Payloads valid under create rules
  keep working; updates that do not touch `attributes` are unaffected, and
  items whose category is missing from the registry keep shape-caps-only
  behavior.
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
