// Saved shipping addresses v1 core (spec docs/specs/saved-addresses.md,
// rollout step 1): the account-owned address store behind the MCP account
// tools (step 2), the web settings routes (step 3) and advisory provider
// verification (step 4, now via the active shipping provider — amended
// spec). Foundation first — nothing calls this module until
// those land. Mirrors src/wanted.ts conventions throughout.
//
// PII minimization is the load-bearing rule here (spec Goal 3, review
// condition C2): the model-facing surface gets the summary shape ONLY —
// addressToSummary below is the one allowlist, pinned by test. Name,
// street and postal code never leave this module except to the owner's own
// web routes (step 3) and into the order snapshot at use time (step 2).
// Security events carry ids and statuses only, never address content
// (review note N3).

import { z } from "zod";
import { pool } from "./db.js";
import { normalizeCountryCode, CountryCodeError } from "./countries.js";
import { RateLimiter } from "./rate-limit.js";
import { logSecurityEvent } from "./security-events.js";
import { orderFlowConfig } from "./config.js";
import { getShippingProvider } from "./shipping/registry.js";
import { ADDRESS_VERIFY_TIMEOUT_MS } from "./address-verification.js";
import type { ProviderAddress, ShippingProvider } from "./shipping/provider.js";

/** Fan-out controls (spec "Security and privacy"): module constants,
 *  deliberately not env-configurable — same posture as the wanted caps.
 *  Changing them is one reviewed edit and the error message follows. */
export const MAX_ADDRESSES_PER_ACCOUNT = 10;

/** Spec: 30 address writes per account per hour, one bucket across both
 *  surfaces (MCP tools and web routes) so mixing them cannot double the
 *  allowance. Token-bucket semantics (continuously refilling): this is an
 *  average-rate ceiling with burst-after-idle, not a wall-clock calendar
 *  cap — documented per review note N2, same caveat as the wanted buckets. */
export const addressWriteLimiter = new RateLimiter(30, 60 * 60_000);

/** Spec "Verification (advisory)": 20 checks per account per day — a ceiling,
 *  not an expected rate (the provider charges per check). Over the limit is
 *  not_checked, never an error. Same token-bucket semantics as the write
 *  bucket (review note N2): an average-rate ceiling over a 24h window with
 *  burst-after-idle, not a wall-clock calendar cap — so "about 20/day" in
 *  the privacy statement (docs/security.md §4b) is exact. */
export const addressVerificationLimiter = new RateLimiter(20, 24 * 60 * 60_000);

/** Hard cap on the stored `suggested` correction (review condition C4): the
 *  suggestion is provider-written, untrusted text — capped at synthesis and
 *  zod-enforced on every read back (AddressVerificationSchema below). */
export const MAX_VERIFICATION_SUGGESTED_LENGTH = 200;

/** The advisory verification state machine (spec "Verification", amended:
 *  the ACTIVE provider verifies — one provider per deployment covers labels,
 *  tracking and verification; without a verification-capable provider every
 *  row stays not_checked). The check never blocks a save. */
export const ADDRESS_VERIFICATION_STATUSES = ["verified", "suggested", "unverified", "not_checked"] as const;
export type AddressVerificationStatus = (typeof ADDRESS_VERIFICATION_STATUSES)[number];

export interface AddressVerification {
  status: AddressVerificationStatus;
  /** ISO timestamp of the last check (absent on the not_checked default). */
  checked_at?: string;
  /** Stored correction when status is "suggested": length-capped,
   *  untrusted provider text (review condition C4). Never returned through
   *  MCP tools — the summary carries the status only. */
  suggested?: string;
  /** Provider-prefixed reason code when status is "unverified" (e.g.
   *  "shippo_address_invalid") — a code string only: never address values,
   *  never provider prose. */
  reason?: string;
}

/** C4, enforced at the read boundary: every verification JSONB read back
 *  from the database is re-validated — status from the closed set,
 *  `suggested` length-capped. A row that fails (hand-edited, corrupted)
 *  degrades to the not_checked default instead of surfacing unbounded
 *  provider text. */
export const AddressVerificationSchema = z.object({
  status: z.enum(ADDRESS_VERIFICATION_STATUSES),
  checked_at: z.string().optional(),
  suggested: z.string().max(MAX_VERIFICATION_SUGGESTED_LENGTH).optional(),
  // Code-string only, capped — same untrusted-provider-output discipline as
  // `suggested` (C4). Values observed in the wild are far shorter.
  reason: z.string().max(80).optional(),
});

export function parseAddressVerification(json: unknown): AddressVerification {
  const parsed = AddressVerificationSchema.safeParse(json);
  return parsed.success ? parsed.data : { status: "not_checked" };
}

/** Over the 10-address cap. Quota-shaped: rate_limited, the same code as
 *  WantedLimitError and IntentLimitError — agents treat it as
 *  back-off-and-retry-later (delete one, then save). */
export class AddressLimitError extends Error {
  readonly code = "rate_limited";
  constructor() {
    super(`Address limit reached (max ${MAX_ADDRESSES_PER_ACCOUNT} per account). Delete one and try again.`);
    this.name = "AddressLimitError";
  }
}

/** Invalid field shape (lengths, ISO country). Thrown before any query. */
export class AddressValidationError extends Error {
  readonly code = "invalid_address";
  constructor(message: string) {
    super(message);
    this.name = "AddressValidationError";
  }
}

/** Address not found or not owned by the caller — indistinguishable by
 *  design (same posture as WantedNotFoundError): foreign ids answer 404,
 *  never 403, so no other account's ids are revealed. */
export class AddressNotFoundError extends Error {
  readonly code = "not_found";
  constructor() {
    super("Address not found");
    this.name = "AddressNotFoundError";
  }
}

export interface AccountAddressRow {
  id: string;
  account_id: string;
  label: string;
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  postal_code: string;
  country: string;
  is_default: boolean;
  verification: AddressVerification;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}

/** Maps a raw pg row onto AccountAddressRow: the only job is re-validating
 *  the verification JSONB through AddressVerificationSchema (the C4
 *  read-boundary cap). Every query site returns rows through here. */
function mapRow(raw: AccountAddressRow): AccountAddressRow {
  return { ...raw, verification: parseAddressVerification(raw?.verification) };
}

/** The writable shape shared by the MCP save tool and the web POST/PATCH
 *  routes. Lengths mirror the DB CHECKs exactly (defense in depth: the
 *  zod surface, this module and the schema all enforce the same bounds). */
export interface AddressInput {
  label: string;
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  postal_code: string;
  country: string;
}

/** Test seam for the advisory verification: production resolves the boot
 *  provider selection from the registry — injectable so tests never touch
 *  the network and never depend on the host environment. */
export interface AddressVerificationDeps {
  provider?: ShippingProvider;
}

/** Wholesale field replacement (update_listing semantics) plus the
 *  default toggle, which only the web surface sets in v1. is_default is
 *  required — the caller sends the merged target state (current row +
 *  patch), so an edit cannot silently unset an existing default. */
export interface AddressUpdate {
  address: AddressInput;
  is_default: boolean;
}

/** Review note N3: one content-free address_write event per write —
 *  account id via the context, the address uuid when one is in play.
 *  Never label, name, street, city or postal code (no-payload rule). */
function logAddressWrite(
  action: "save" | "update" | "delete",
  outcome: "success" | "rejected",
  accountId: string,
  addressId?: string,
): void {
  logSecurityEvent({ type: "address_write", action, outcome, ...(addressId ? { addressId } : {}) }, { sellerId: accountId });
}

function field(name: string, value: string, min: number, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new AddressValidationError(`${name} must be between ${min} and ${max} characters`);
  }
  return trimmed;
}

/** Validates and normalizes a full address input: trims every field,
 *  enforces the length bounds shared with the schema CHECKs, and checks
 *  `country` against the ISO 3166-1 alpha-2 list (lowercase input is
 *  accepted and uppercased). Throws AddressValidationError or
 *  CountryCodeError before any query runs. */
export function validateAddressInput(input: AddressInput): Required<Pick<AddressInput, "label" | "name" | "line1" | "city" | "postal_code" | "country">> & { line2: string | null } {
  return {
    label: field("label", input.label, 1, 40),
    name: field("name", input.name, 1, 120),
    line1: field("line1", input.line1, 1, 200),
    line2: input.line2 ? field("line2", input.line2, 0, 200) : null,
    city: field("city", input.city, 1, 80),
    postal_code: field("postal_code", input.postal_code, 1, 20),
    country: normalizeCountryCode(input.country),
  };
}

/** Saves a new address. The 10-row cap is race-safe by construction
 *  (review note N1): the INSERT only runs where the account is under the
 *  cap — a concurrent writer that fills the last slot makes this INSERT
 *  select zero rows, which maps to AddressLimitError. Setting the new row
 *  as the default clears any previous default in the same transaction
 *  (review note N5) so the partial unique index can never 500 a legal
 *  write. */
export async function saveAddress(
  accountId: string,
  input: AddressInput,
  options?: { isDefault?: boolean; verification?: AddressVerificationDeps },
): Promise<AccountAddressRow> {
  let address;
  try {
    address = validateAddressInput(input);
  } catch (e) {
    logAddressWrite("save", "rejected", accountId);
    throw e;
  }
  const isDefault = options?.isDefault ?? false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (isDefault) {
      await client.query(
        `UPDATE account_addresses SET is_default = false, updated_at = now()
         WHERE account_id = $1 AND is_default`,
        [accountId],
      );
    }
    const { rows } = await client.query<AccountAddressRow>(
      `INSERT INTO account_addresses (account_id, label, name, line1, line2, city, postal_code, country, is_default)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
       WHERE (SELECT count(*) FROM account_addresses WHERE account_id = $1) < $10
       RETURNING *`,
      [accountId, address.label, address.name, address.line1, address.line2, address.city, address.postal_code, address.country, isDefault, MAX_ADDRESSES_PER_ACCOUNT],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      logAddressWrite("save", "rejected", accountId);
      throw new AddressLimitError();
    }
    await client.query("COMMIT");
    logAddressWrite("save", "success", accountId, row.id);
    return await withAdvisoryVerification(accountId, row, options?.verification);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** All saved addresses for one account, default first then oldest-first —
 *  the order the settings screen and the summary listing show. */
export async function listAddresses(accountId: string): Promise<AccountAddressRow[]> {
  const { rows } = await pool.query<AccountAddressRow>(
    `SELECT * FROM account_addresses
     WHERE account_id = $1
     ORDER BY is_default DESC, created_at`,
    [accountId],
  );
  return rows.map(mapRow);
}

/** Owner-scoped load: a foreign or missing id is AddressNotFoundError,
 *  never a distinct "exists but not yours" signal. */
export async function getOwnedAddress(accountId: string, addressId: string): Promise<AccountAddressRow> {
  const { rows } = await pool.query<AccountAddressRow>(
    `SELECT * FROM account_addresses WHERE id = $1 AND account_id = $2`,
    [addressId, accountId],
  );
  const row = rows[0];
  if (!row) throw new AddressNotFoundError();
  return mapRow(row);
}

/** Hard delete, owner-scoped: 0 deleted rows is AddressNotFoundError.
 *  Past orders keep their own snapshot — nothing here cascades to them. */
export async function deleteAddress(accountId: string, addressId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `DELETE FROM account_addresses WHERE id = $1 AND account_id = $2`,
    [addressId, accountId],
  );
  if (!rowCount) {
    logAddressWrite("delete", "rejected", accountId, addressId);
    throw new AddressNotFoundError();
  }
  logAddressWrite("delete", "success", accountId, addressId);
}

/** Wholesale replace of the editable fields, optionally toggling the
 *  default. The default flip is clear-then-set inside one transaction
 *  (review note N5): the previous default is cleared first, so the partial
 *  unique index accepts exactly one default at every intermediate state. */
export async function updateAddress(
  accountId: string,
  addressId: string,
  update: AddressUpdate,
  options?: { verification?: AddressVerificationDeps },
): Promise<AccountAddressRow> {
  let address;
  try {
    address = validateAddressInput(update.address);
  } catch (e) {
    logAddressWrite("update", "rejected", accountId, addressId);
    throw e;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (update.is_default) {
      await client.query(
        `UPDATE account_addresses SET is_default = false, updated_at = now()
         WHERE account_id = $1 AND is_default AND id <> $2`,
        [accountId, addressId],
      );
    }
    const { rows } = await client.query<AccountAddressRow>(
      `UPDATE account_addresses
       SET label = $3, name = $4, line1 = $5, line2 = $6, city = $7,
           postal_code = $8, country = $9, is_default = $10, updated_at = now()
       WHERE id = $1 AND account_id = $2
       RETURNING *`,
      [addressId, accountId, address.label, address.name, address.line1, address.line2, address.city, address.postal_code, address.country, update.is_default],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      logAddressWrite("update", "rejected", accountId, addressId);
      throw new AddressNotFoundError();
    }
    await client.query("COMMIT");
    logAddressWrite("update", "success", accountId, addressId);
    return await withAdvisoryVerification(accountId, row, options?.verification);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Stamps last_used_at at order time (spec "Using a saved address").
 *  Owner-scoped and advisory only: the order keeps its own snapshot, so a
 *  row deleted between the order's load and this stamp is not an error —
 *  0 affected rows is fine. Best-effort by design: an order must never
 *  fail (or surface an error) because a usage stamp could not be written. */
export async function markAddressUsed(accountId: string, addressId: string): Promise<void> {
  await pool
    .query(
      `UPDATE account_addresses SET last_used_at = now() WHERE id = $1 AND account_id = $2`,
      [addressId, accountId],
    )
    .catch(() => {}); // advisory stamp — swallow, never fail the order
}

// --- Advisory verification via the active shipping provider (spec
// "Verification (advisory)", rollout step 4; amended spec: provider seam) ---
//
// Runs on save and edit ONLY — never on list, never at order time. Every
// failure mode (unconfigured provider, capability missing, over the daily
// ceiling, provider error, the C3 timeout) maps to not_checked: saving never
// fails because of verification, and a valid address is never refused
// (advisory only).

const NOT_CHECKED: AddressVerification = { status: "not_checked" };

function toProviderInput(input: AddressInput): ProviderAddress {
  return {
    name: input.name,
    line1: input.line1,
    ...(input.line2 ? { line2: input.line2 } : {}),
    city: input.city,
    postalCode: input.postal_code,
    country: input.country,
  };
}

/** Whitespace- and case-insensitive single-field compare. */
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when the provider-confirmed address differs from what the user typed
 *  (delivery fields only — a name-only difference is not a correction). */
function addressDiffers(input: AddressInput, corrected: ProviderAddress): boolean {
  return (
    norm(input.line1) !== norm(corrected.line1) ||
    norm(input.line2 ?? "") !== norm(corrected.line2 ?? "") ||
    norm(input.city) !== norm(corrected.city) ||
    norm(input.postal_code) !== norm(corrected.postalCode) ||
    norm(input.country) !== norm(corrected.country)
  );
}

/** The stored suggestion (C4): one line of untrusted, provider-written text,
 *  each component whitespace-collapsed and capped to its field bound, the
 *  whole line capped at MAX_VERIFICATION_SUGGESTED_LENGTH. Synthesized here
 *  from the corrected fields — the provider's raw response is never stored. */
function suggestedLine(corrected: ProviderAddress): string {
  const line1 = corrected.line1.trim().replace(/\s+/g, " ").slice(0, 200);
  const line2 = corrected.line2?.trim().replace(/\s+/g, " ").slice(0, 200);
  const city = corrected.city.trim().replace(/\s+/g, " ").slice(0, 80);
  const postal = corrected.postalCode.trim().slice(0, 20);
  const country = corrected.country.trim().slice(0, 2);
  const line = [line1, ...(line2 ? [line2] : []), `${city} ${postal}`, country].join(", ");
  return line.length > MAX_VERIFICATION_SUGGESTED_LENGTH
    ? `${line.slice(0, MAX_VERIFICATION_SUGGESTED_LENGTH - 1)}…`
    : line;
}

/** One advisory check: resolves the boot provider (unless deps override it),
 *  pre-checks availability + verification capability BEFORE the cap (an
 *  unavailable provider never costs budget), draws from the 20/day bucket
 *  only when a check can actually run, and maps every outcome onto the
 *  four-status state machine (spec table). Exported for tests; never touches
 *  the database. */
export async function verifyAddressAdvisory(
  accountId: string,
  input: AddressInput,
  deps?: AddressVerificationDeps,
): Promise<AddressVerification> {
  const provider = deps?.provider ?? getShippingProvider(orderFlowConfig());
  if (!provider.isConfigured() || !provider.supportsAddressVerification) return NOT_CHECKED;
  if (!addressVerificationLimiter.allow(`seller:${accountId}`)) return NOT_CHECKED;
  try {
    const result = await provider.verifyAddress(
      toProviderInput(input),
      AbortSignal.timeout(ADDRESS_VERIFY_TIMEOUT_MS),
    );
    if (result === null) return NOT_CHECKED;
    const checked_at = new Date().toISOString();
    if (result.status === "verified") return { status: "verified", checked_at };
    if (result.status === "suggested") {
      if (addressDiffers(input, result.suggestion)) {
        return { status: "suggested", checked_at, suggested: suggestedLine(result.suggestion) };
      }
      // An identical-to-input "correction" is not a correction (same rule
      // as the order-time seam) — plain unverified, no reason code.
      return { status: "unverified", checked_at };
    }
    return {
      status: "unverified",
      checked_at,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  } catch (e) {
    // Spec "Failure" + C3: provider error or timeout → not_checked. The
    // logged message carries no address content (provider errors are
    // status+code only); the address itself never reaches a log line.
    console.error("address verification failed (ignored):", e instanceof Error ? e.message : e);
    return NOT_CHECKED;
  }
}

/** Post-commit verification stamp for a freshly written row: runs the
 *  advisory check and persists the non-default result. The stamp UPDATE is
 *  itself advisory — its failure leaves the row at not_checked and never
 *  fails the save. updated_at is deliberately untouched: a check is not an
 *  edit. Runs outside the write transaction so no DB connection is ever
 *  held across the provider fetch. */
async function withAdvisoryVerification(
  accountId: string,
  raw: AccountAddressRow,
  deps?: AddressVerificationDeps,
): Promise<AccountAddressRow> {
  const row = mapRow(raw);
  const input: AddressInput = {
    label: row.label,
    name: row.name,
    line1: row.line1,
    line2: row.line2,
    city: row.city,
    postal_code: row.postal_code,
    country: row.country,
  };
  const verification = await verifyAddressAdvisory(accountId, input, deps);
  if (verification.status === "not_checked") return row;
  await pool
    .query(`UPDATE account_addresses SET verification = $1 WHERE id = $2 AND account_id = $3`, [
      JSON.stringify(verification),
      row.id,
      accountId,
    ])
    .catch(() => {}); // advisory stamp — swallow, never fail the save
  return { ...row, verification };
}

/** The model-facing summary (spec "The model never sees a full saved
 *  address", review condition C2): label, city, country, default flag and
 *  verification STATUS only. This is the one allowlist — pinned by test:
 *  name, line1/line2 and postal_code must never appear in its output. The
 *  assistant disambiguates with the label ("Home — Milano"), which the
 *  user can rename; the street never reaches the model provider. */
export interface AddressSummary {
  id: string;
  label: string;
  city: string;
  country: string;
  is_default: boolean;
  verification: AddressVerificationStatus;
}

export function addressToSummary(row: AccountAddressRow): AddressSummary {
  return {
    id: row.id,
    label: row.label,
    city: row.city,
    country: row.country,
    is_default: row.is_default,
    verification: row.verification?.status ?? "not_checked",
  };
}
