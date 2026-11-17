// Order-time address verification (docs/specs/order-address-verification.md).
//
// Advisory EasyPost delivery check, run inside createOrder's transaction
// before the item reservation. The state machine is failure-open by design:
// any provider problem (unset key, error, timeout, over cap) resolves to
// "not_checked" and the order proceeds exactly as it did before this module
// existed. Nothing here can block an order that the platform could ship
// before — a correction pauses the order once, with the suggestion in hand.
//
// Privacy invariants (spec §Privacy and security):
// - Raw provider responses never travel past easypost.ts; suggestions are
//   re-validated to the exact ShippingAddress shape (validateSuggestionAddress)
//   before any cache write, store, or return. A malformed suggestion downgrades
//   to "unverified" — provider output is never surfaced as-is.
// - Nothing about a verification failure is logged with address values: the
//   module throws no provider-derived errors and its results carry no raw
//   payload. checked_at timestamps are ISO UTC.
// - Dedup cache keys are salted SHA-256 digests (account id + normalized
//   address) — no plaintext addresses in memory beyond the in-flight call.

import { createHash } from "node:crypto";
import { envNonNegativeInt, envValue } from "./config.js";
import { verifyEasyPostAddress } from "./easypost.js";
import { RateLimiter } from "./rate-limit.js";
import { isIsoCountryCode, normalizeCountryCode } from "./countries.js";
import type { ShippingAddress } from "./order-flow.js";

/** How long a verification outcome is reused for the same address (spec: 10
 *  minutes). Within the TTL an identical re-submission skips the provider
 *  entirely; past it the check runs fresh and overwrites. */
const CACHE_TTL_MS = 10 * 60_000;

/** Per-account provider budget: 20 checks per account per day (RateLimiter
 *  bucket "addrverify:{accountId}", 24h window). Deliberately shared: this is
 *  the same bucket the saved-addresses verification path (THI-910) spends
 *  from, so one account cannot multiply its budget by mixing surfaces. */
const PER_ACCOUNT_DAILY_MAX = 20;

/** Global daily ceiling default (spec Q2 resolution): the platform spends at
 *  most this many provider checks per UTC day across all accounts. Override
 *  with ADDRESS_VERIFICATION_DAILY_CAP; 0 disables verification entirely. */
const GLOBAL_DAILY_CAP_DEFAULT = 1_000;

/** The stored record shape: status, when it was checked, and — only for a
 *  kept correction — the validated suggestion. Never the provider response,
 *  never error details. `accepted` = the buyer re-submitted exactly the
 *  suggested address; `kept` = the buyer chose to keep their typed address. */
export type ShippingVerificationRecord =
  | { status: "verified"; checked_at: string }
  | { status: "unverified"; checked_at: string }
  | { status: "suggested"; kept: true; suggestion: ShippingAddress; checked_at: string }
  | { status: "suggested"; accepted: true; checked_at: string };

/** Outcome for createOrder: a record to store (or null = not_checked), or the
 *  order-blocking suggestion ("No order was created"). */
export type OrderVerificationOutcome =
  | { kind: "not_checked" }
  | { kind: "record"; record: ShippingVerificationRecord | null }
  | { kind: "suggested"; suggestion: ShippingAddress; checkedAt: string };

/** Thrown by createOrder when the carrier suggests a correction and the buyer
 *  has not chosen an address yet. Extends OrderFlowError so every existing
 *  catch keeps working; handlers that know this class surface the suggestion
 *  (code "address_verification_suggested"). The message names no address
 *  values — the suggestion rides in `verification`, where callers choose to
 *  show it, and is never embedded in the error text. */
export class AddressSuggestedError extends Error {
  readonly code = "address_verification_suggested";
  readonly verification: { status: "suggested"; suggestion: ShippingAddress; checked_at: string };
  constructor(verification: AddressSuggestedError["verification"]) {
    super(
      "No order was created: the carrier could not confirm this address as typed and suggests a corrected one " +
        "(see verification.suggestion). Ask the buyer which address to use, then re-call create_order with that address.",
    );
    this.name = "AddressSuggestedError";
    this.verification = verification;
  }
}

export interface VerifyOrderAddressOptions {
  /** Test seams — production callers pass nothing. */
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
}

interface CachedOutcome {
  status: "verified" | "unverified" | "suggested";
  suggestion?: ShippingAddress;
  checkedAt: string;
}

// Single-instance process state: dedup cache + per-account budget. Both are
// in-memory by design (spec residual risk: single-instance assumption —
// multi-instance deployments would dedupe/budget per instance until this
// moves to shared storage; the ceiling still bounds total provider spend).
const state = {
  cache: new Map<string, { outcome: CachedOutcome; expiresAt: number }>(),
  limiter: new RateLimiter(PER_ACCOUNT_DAILY_MAX, 24 * 3600_000),
};
let dailyCounter: { day: string; count: number } = { day: "", count: 0 };

/** Test hook: reset the cache, the per-account budget, and the daily counter. */
export function __resetAddressVerificationForTests(): void {
  state.cache.clear();
  state.limiter = new RateLimiter(PER_ACCOUNT_DAILY_MAX, 24 * 3600_000);
  dailyCounter = { day: "", count: 0 };
}

/** F2: re-validate a provider suggestion to the EXACT ShippingAddress shape
 *  and limits the create_order schema accepts (name ≤120, line1/line2 ≤200,
 *  city ≤80, postal_code ≤20, country ISO 3166-1 alpha-2). Unknown fields are
 *  dropped, not rejected — provider payloads carry extras (id, carrier
 *  metadata) that must never ride into storage. Anything that does not
 *  validate cleanly returns null and the outcome downgrades to "unverified".
 *  Mirrors tools.ts F16 limits; a parity test locks the two together. */
export function validateSuggestionAddress(raw: unknown): ShippingAddress | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | null =>
    typeof v === "string" && v.length >= 1 && v.length <= max ? v : null;
  const name = str(r.name, 120);
  const line1 = str(r.line1, 200);
  let line2: string | undefined;
  if (r.line2 !== undefined) {
    const v = str(r.line2, 200);
    if (v === null) return null;
    line2 = v;
  }
  const city = str(r.city, 80);
  const postal = str(r.postal_code, 20);
  // Shared ISO module (saved-addresses step 1): normalize then check against
  // the officially assigned alpha-2 list — same rule as create_order's schema.
  const country = typeof r.country === "string" ? r.country.trim().toUpperCase() : "";
  if (!name || !line1 || !city || !postal || !isIsoCountryCode(country)) return null;
  return { name, line1, ...(line2 !== undefined ? { line2 } : {}), city, postal_code: postal, country };
}

const ADDRESS_KEYS = ["name", "line1", "line2", "city", "postal_code", "country"] as const;

/** Normalized form for identity comparisons and cache keys: trimmed strings,
 *  uppercased ISO country, line2 omitted when empty. Two submissions the
 *  buyer would call "the same address" map to the same key. */
function normalizedAddress(address: ShippingAddress): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ADDRESS_KEYS) {
    const value = (address as unknown as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    let trimmed = value.trim();
    if (key === "country") {
      // normalizeCountryCode throws on non-ISO input; this helper only ever
      // sees already-validated addresses, so fall back to uppercase-trim
      // (identity hashing must not have failure modes).
      try {
        trimmed = normalizeCountryCode(value);
      } catch {
        trimmed = value.trim().toUpperCase();
      }
    }
    if (trimmed !== "" || key !== "line2") out[key] = trimmed;
  }
  return out;
}

function sameAddress(a: ShippingAddress, b: ShippingAddress): boolean {
  const na = normalizedAddress(a);
  const nb = normalizedAddress(b);
  return ADDRESS_KEYS.every((key) => (na[key] ?? "") === (nb[key] ?? ""));
}

/** Salted digest — the account id is part of the key material, so two
 *  accounts checking the same address do not share cache entries (per-account
 *  dedup, never cross-account). */
function cacheKey(accountId: string, address: ShippingAddress): string {
  return createHash("sha256").update(`${accountId}\n${JSON.stringify(normalizedAddress(address))}`).digest("hex");
}

function readCache(key: string, now: number, ttl: number): CachedOutcome | null {
  const hit = state.cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    state.cache.delete(key);
    return null;
  }
  return hit.outcome;
}

function dailyCount(now: () => number): number {
  const day = new Date(now()).toISOString().slice(0, 10);
  if (dailyCounter.day !== day) dailyCounter = { day, count: 0 };
  return dailyCounter.count;
}

/** The advisory gate for one createOrder attempt. At most ONE provider call;
 *  everything else (cache hit, cap refusal, provider failure) costs nothing
 *  and resolves to not_checked. */
export async function verifyOrderAddress(input: {
  accountId: string;
  address: ShippingAddress;
  choice?: "keep_original";
  options?: VerifyOrderAddressOptions;
}): Promise<OrderVerificationOutcome> {
  const opts = input.options ?? {};
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;

  // Degraded mode first: no key means today's behavior, byte for byte —
  // no caps consumed, no cache writes, no suggestion flow.
  const apiKey = opts.apiKey ?? envValue("EASYPOST_API_KEY");
  if (!apiKey) return { kind: "not_checked" };

  const nowMs = now();
  const keyA = cacheKey(input.accountId, input.address);

  // keep_original (PR3 wires the choice into create_order's input): honoring a
  // cached suggestion needs no provider call. Without one it is a no-op — we
  // cannot pre-emptively skip a check for a suggestion that may never exist.
  if (input.choice === "keep_original") {
    const cached = readCache(keyA, nowMs, ttl);
    if (cached?.status === "suggested" && cached.suggestion && !sameAddress(input.address, cached.suggestion)) {
      return {
        kind: "record",
        record: { status: "suggested", kept: true, suggestion: cached.suggestion, checked_at: cached.checkedAt },
      };
    }
  }

  // Cache hit: identical re-submission within the TTL. Re-submitting exactly
  // the suggested address is the ACCEPT protocol — no provider call, the
  // order carries suggested/accepted with the original check time.
  const cached = readCache(keyA, nowMs, ttl);
  if (cached) {
    if (cached.status === "suggested" && cached.suggestion && sameAddress(input.address, cached.suggestion)) {
      return { kind: "record", record: { status: "suggested", accepted: true, checked_at: cached.checkedAt } };
    }
    if (cached.status === "verified") return { kind: "record", record: { status: "verified", checked_at: cached.checkedAt } };
    if (cached.status === "unverified") return { kind: "record", record: { status: "unverified", checked_at: cached.checkedAt } };
    // suggested + typed address unchanged → same pause again (no new call).
    return { kind: "suggested", suggestion: cached.suggestion!, checkedAt: cached.checkedAt };
  }

  // Caps: global ceiling first (platform-wide spend bound), then the
  // per-account bucket. Both resolve to not_checked — the order proceeds
  // unverified, exactly the pre-rollout behavior.
  const cap = envNonNegativeInt("ADDRESS_VERIFICATION_DAILY_CAP", GLOBAL_DAILY_CAP_DEFAULT);
  if (cap === 0) return { kind: "not_checked" }; // kill switch
  if (dailyCount(now) >= cap) return { kind: "not_checked" };
  if (!state.limiter.allow(`addrverify:${input.accountId}`)) return { kind: "not_checked" };
  dailyCounter.count += 1; // spend counted even if the provider call fails

  // Provider call, wrapped: easypost.ts maps the response; ANY throw (network,
  // timeout, non-2xx, malformed JSON) lands here → not_checked. The raw error
  // is dropped, never logged with context — nothing provider-derived leaks.
  let outcome: CachedOutcome;
  try {
    // Domain → provider mapping happens here (postal_code → postalCode) so
    // easypost.ts stays domain-agnostic and nothing downstream sees wire
    // field names.
    const result = await verifyEasyPostAddress(
      {
        name: input.address.name,
        line1: input.address.line1,
        ...(input.address.line2 !== undefined ? { line2: input.address.line2 } : {}),
        city: input.address.city,
        postalCode: input.address.postal_code,
        country: input.address.country,
      },
      {
        apiKey,
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      },
    );
    if (!result) return { kind: "not_checked" }; // degraded (key vanished mid-call)
    if (result.status === "verified") {
      outcome = { status: "verified", checkedAt: new Date(nowMs).toISOString() };
    } else if (result.status === "unverified" || !result.suggestion) {
      outcome = { status: "unverified", checkedAt: new Date(nowMs).toISOString() };
    } else {
      // F2 gate: provider output becomes a suggestion only after it validates
      // to the exact ShippingAddress shape. Identical-to-input "corrections"
      // are not corrections — plain unverified.
      const suggestion = validateSuggestionAddress(result.suggestion);
      if (!suggestion || sameAddress(input.address, suggestion)) {
        outcome = { status: "unverified", checkedAt: new Date(nowMs).toISOString() };
      } else {
        outcome = { status: "suggested", suggestion, checkedAt: new Date(nowMs).toISOString() };
      }
    }
  } catch {
    return { kind: "not_checked" };
  }

  // Cache under the typed address, and — for a suggestion — also under the
  // suggested address so the accept path is a cache hit with no second call.
  state.cache.set(keyA, { outcome, expiresAt: nowMs + ttl });
  if (outcome.status === "suggested" && outcome.suggestion) {
    state.cache.set(cacheKey(input.accountId, outcome.suggestion), { outcome, expiresAt: nowMs + ttl });
  }

  if (outcome.status === "suggested" && outcome.suggestion) {
    return { kind: "suggested", suggestion: outcome.suggestion, checkedAt: outcome.checkedAt };
  }
  return {
    kind: "record",
    record:
      outcome.status === "verified"
        ? { status: "verified", checked_at: outcome.checkedAt }
        : { status: "unverified", checked_at: outcome.checkedAt },
  };
}
