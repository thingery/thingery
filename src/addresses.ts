// Saved shipping addresses v1 core (spec docs/specs/saved-addresses.md,
// rollout step 1): the account-owned address store behind the MCP account
// tools (step 2), the web settings routes (step 3) and advisory EasyPost
// verification (step 4). Foundation first — nothing calls this module until
// those land. Mirrors src/wanted.ts conventions throughout.
//
// PII minimization is the load-bearing rule here (spec Goal 3, review
// condition C2): the model-facing surface gets the summary shape ONLY —
// addressToSummary below is the one allowlist, pinned by test. Name,
// street and postal code never leave this module except to the owner's own
// web routes (step 3) and into the order snapshot at use time (step 2).
// Security events carry ids and statuses only, never address content
// (review note N3).

import { pool } from "./db.js";
import { normalizeCountryCode, CountryCodeError } from "./countries.js";
import { RateLimiter } from "./rate-limit.js";
import { logSecurityEvent } from "./security-events.js";

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

/** The advisory verification state machine (spec "Verification"): one of
 *  ADDRESS_VERIFICATION_STATUSES, mirrored by the DB CHECK on
 *  account_addresses.verification. The check never blocks a save; the
 *  EasyPost fetch that produces the non-default statuses lands in rollout
 *  step 4 — until then every row stays not_checked. */
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
  options?: { isDefault?: boolean },
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
    return row;
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
  return rows;
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
  return row;
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
    return row;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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
