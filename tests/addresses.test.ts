// Saved addresses v1 core (spec docs/specs/saved-addresses.md, rollout
// step 1) — src/addresses.ts: validation ordering (rejections before any
// query), the race-safe 10-address cap (N1: INSERT…SELECT returns zero
// rows → AddressLimitError), owner-scoped 404 discipline, clear-then-set
// default transactions (N5), the C2 summary allowlist (name, street and
// postal code can never appear in addressToSummary output), and
// content-free address_write events (N3).
//
// Part 1 is pure (pool.connect/query mocked, mirroring tests/wanted.test.ts
// conventions). Part 2 is DB-backed (skips when no Postgres is reachable);
// like wanted.test.ts it never TRUNCATEs — it seeds uniquely-emailed
// sellers and cleans up just those rows via the account cascade.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { pool } from "../src/db.js";
import { CountryCodeError } from "../src/countries.js";
import {
  MAX_ADDRESSES_PER_ACCOUNT,
  AddressLimitError,
  AddressValidationError,
  AddressNotFoundError,
  addressToSummary,
  deleteAddress,
  getOwnedAddress,
  listAddresses,
  saveAddress,
  updateAddress,
  type AccountAddressRow,
  type AddressInput,
} from "../src/addresses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "..", "db", "schema.sql");
const connectionString =
  process.env.DATABASE_URL ?? "postgres://thingery:thingery@localhost:5432/thingery";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const ADDRESS_ID = "22222222-2222-4222-8222-222222222222";

function input(overrides: Partial<AddressInput> = {}): AddressInput {
  return {
    label: "Home",
    name: "Ada Lovelace",
    line1: "Via Roma 1",
    city: "Milano",
    postal_code: "20121",
    country: "IT",
    ...overrides,
  };
}

function row(overrides: Partial<AccountAddressRow> = {}): AccountAddressRow {
  return {
    id: ADDRESS_ID,
    account_id: ACCOUNT_ID,
    label: "Home",
    name: "Ada Lovelace",
    line1: "Via Roma 1",
    line2: null,
    city: "Milano",
    postal_code: "20121",
    country: "IT",
    is_default: false,
    verification: { status: "not_checked" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    last_used_at: null,
    ...overrides,
  };
}

/** Transactional calls run on a checked-out client; plain calls use
 *  pool.query. Both are spied here with per-query queued results. */
function mockDb(queue: Array<{ rows?: unknown[]; rowCount?: number | null }>) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  // Transaction control statements pass through without consuming the
  // queued per-statement results — tests queue results for the real work
  // (UPDATE/INSERT/DELETE), not for BEGIN/COMMIT/ROLLBACK.
  const isControl = (sql: string) => /^(BEGIN|COMMIT|ROLLBACK)\s*$/.test(sql.trim());
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (isControl(sql)) return { rows: [], rowCount: 0 };
      const next = queue.shift();
      return { rows: next?.rows ?? [], rowCount: next?.rowCount ?? next?.rows?.length ?? 0 };
    }),
    release: vi.fn(),
  };
  const connectSpy = vi.spyOn(pool, "connect").mockResolvedValue(client as never);
  const querySpy = vi.spyOn(pool, "query").mockImplementation((async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (isControl(sql)) return { rows: [], rowCount: 0 };
    const next = queue.shift();
    return { rows: next?.rows ?? [], rowCount: next?.rowCount ?? next?.rows?.length ?? 0 };
  }) as never);
  return { queries, connectSpy, querySpy };
}

function spyLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

function events(spy: ReturnType<typeof spyLog>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((v): v is string => typeof v === "string")
    .map((line) => JSON.parse(line))
    .filter((o) => typeof o === "object" && o !== null && "type" in o && "ts" in o);
}

function addressEvents(spy: ReturnType<typeof spyLog>): Record<string, unknown>[] {
  return events(spy).filter((e) => e.type === "address_write");
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Part 1 — pure: validation ordering, cap race, 404 discipline, C2, events

describe("saveAddress", () => {
  it("rejects invalid shape before any query or connect", async () => {
    const { connectSpy, querySpy } = mockDb([]);
    await expect(saveAddress(ACCOUNT_ID, input({ label: "" }))).rejects.toBeInstanceOf(AddressValidationError);
    await expect(saveAddress(ACCOUNT_ID, input({ country: "XX" }))).rejects.toBeInstanceOf(CountryCodeError);
    await expect(saveAddress(ACCOUNT_ID, input({ postal_code: "" }))).rejects.toBeInstanceOf(AddressValidationError);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("normalizes a lowercase country before the insert", async () => {
    const { queries } = mockDb([{ rows: [row()] }]);
    await saveAddress(ACCOUNT_ID, input({ country: "it" }));
    const insert = queries.find((q) => q.sql.startsWith("INSERT"));
    expect(insert?.params).toContain("IT");
  });

  it("maps a lost cap race (zero inserted rows) to AddressLimitError with ROLLBACK (N1)", async () => {
    const log = spyLog();
    const { queries } = mockDb([{ rows: [] }]);
    await expect(saveAddress(ACCOUNT_ID, input())).rejects.toBeInstanceOf(AddressLimitError);
    const sql = queries.map((q) => q.sql).join("\n");
    expect(sql).toContain("BEGIN");
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    // The cap is enforced in the INSERT itself, not a separate check query.
    expect(queries.filter((q) => q.sql.startsWith("SELECT"))).toHaveLength(0);
    const [event] = addressEvents(log);
    expect(event).toMatchObject({ type: "address_write", action: "save", outcome: "rejected", sellerId: ACCOUNT_ID });
    expect("addressId" in event).toBe(false); // no address exists yet — nothing to name
  });

  it("clears the previous default in the same transaction when saving a default (N5)", async () => {
    const log = spyLog();
    const { queries } = mockDb([{ rows: [] }, { rows: [row({ is_default: true })] }]);
    const saved = await saveAddress(ACCOUNT_ID, input(), { isDefault: true });
    expect(saved.is_default).toBe(true);
    expect(queries[0].sql).toBe("BEGIN");
    const clear = queries.find((q) => q.sql.startsWith("UPDATE"));
    expect(clear?.sql).toMatch(/UPDATE account_addresses SET is_default = false/);
    expect(clear?.sql).not.toContain("id <>"); // a save clears every default
    const insert = queries.find((q) => q.sql.startsWith("INSERT"));
    expect(insert?.params).toEqual([
      ACCOUNT_ID, "Home", "Ada Lovelace", "Via Roma 1", null, "Milano", "20121", "IT",
      true, MAX_ADDRESSES_PER_ACCOUNT, // the cap rides in the INSERT itself (N1)
    ]);
  });

  it("logs a content-free success event", async () => {
    const log = spyLog();
    mockDb([{ rows: [row()] }]);
    await saveAddress(ACCOUNT_ID, input());
    const [event] = addressEvents(log);
    expect(event).toMatchObject({ type: "address_write", action: "save", outcome: "success", addressId: ADDRESS_ID, sellerId: ACCOUNT_ID });
    expect(JSON.stringify(event)).not.toContain("Milano");
    expect(JSON.stringify(event)).not.toContain("Via Roma");
  });
});

describe("ownership and delete", () => {
  it("getOwnedAddress treats a foreign id as not found", async () => {
    mockDb([{ rows: [] }]);
    await expect(getOwnedAddress(ACCOUNT_ID, ADDRESS_ID)).rejects.toBeInstanceOf(AddressNotFoundError);
  });

  it("deleteAddress with zero deleted rows is not_found plus a rejected event", async () => {
    const log = spyLog();
    mockDb([{ rowCount: 0, rows: [] }]);
    await expect(deleteAddress(ACCOUNT_ID, ADDRESS_ID)).rejects.toBeInstanceOf(AddressNotFoundError);
    expect(addressEvents(log)).toHaveLength(1);
    expect(addressEvents(log)[0]).toMatchObject({ action: "delete", outcome: "rejected" });
  });

  it("deleteAddress is a hard delete scoped to id AND owner", async () => {
    const log = spyLog();
    const { queries } = mockDb([{ rowCount: 1, rows: [row()] }]);
    await deleteAddress(ACCOUNT_ID, ADDRESS_ID);
    expect(queries[0].sql).toMatch(/^DELETE FROM account_addresses WHERE id = \$1 AND account_id = \$2$/);
    expect(addressEvents(log)[0]).toMatchObject({ action: "delete", outcome: "success" });
  });
});

describe("updateAddress", () => {
  it("rejects invalid input before any query", async () => {
    const { querySpy } = mockDb([]);
    await expect(
      updateAddress(ACCOUNT_ID, ADDRESS_ID, { address: input({ name: "" }), is_default: false }),
    ).rejects.toBeInstanceOf(AddressValidationError);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("zero updated rows rolls back and answers not_found", async () => {
    const { queries } = mockDb([{ rows: [] }]);
    await expect(
      updateAddress(ACCOUNT_ID, ADDRESS_ID, { address: input(), is_default: false }),
    ).rejects.toBeInstanceOf(AddressNotFoundError);
    expect(queries.map((q) => q.sql).join("\n")).toContain("ROLLBACK");
  });

  it("clear-then-set keeps one default when promoting another address (N5)", async () => {
    const { queries } = mockDb([{ rows: [] }, { rows: [row({ is_default: true })] }]);
    const updated = await updateAddress(ACCOUNT_ID, ADDRESS_ID, { address: input(), is_default: true });
    expect(updated.is_default).toBe(true);
    expect(queries[0].sql).toBe("BEGIN");
    const clear = queries.find((q) => q.sql.startsWith("UPDATE") && q.sql.includes("is_default = false"));
    expect(clear?.sql).toContain("id <> $2"); // never clears the row being promoted
    expect(queries.filter((q) => q.sql.startsWith("UPDATE") && q.sql.includes("SET label"))).toHaveLength(1);
  });
});

describe("addressToSummary (C2 allowlist)", () => {
  it("returns exactly id, label, city, country, is_default, verification", () => {
    const summary = addressToSummary(row({ verification: { status: "suggested", checked_at: "2026-01-01T00:00:00Z", suggested: "Via Roma 10" } }));
    expect(summary).toEqual({
      id: ADDRESS_ID,
      label: "Home",
      city: "Milano",
      country: "IT",
      is_default: false,
      verification: "suggested",
    });
    // The C2 invariant, pinned: no street, name or postal code, and the
    // stored `suggested` correction text never rides along either.
    for (const banned of ["Via Roma 1", "Via Roma 10", "Ada Lovelace", "20121", "checked_at"]) {
      expect(JSON.stringify(summary)).not.toContain(banned);
    }
  });

  it("treats a malformed verification object as not_checked", () => {
    const summary = addressToSummary(row({ verification: undefined as never }));
    expect(summary.verification).toBe("not_checked");
  });
});

// ---------------------------------------------------------------------------
// Part 2 — DB-backed (skips without a reachable Postgres)

async function dbAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const available = await dbAvailable();

describe.skipIf(!available)("addresses (db)", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
    await client.query(readFileSync(schemaPath, "utf8"));
  });

  afterAll(async () => {
    await client.end();
  });

  async function seedAccount(): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO sellers (id, display_name, email) VALUES ($1, $2, $3)`,
      [id, `address-test-${id.slice(0, 8)}`, `addr-${id}@test.thingery.dev`],
    );
    return id;
  }

  it("roundtrips save → list → get → update → delete", async () => {
    const accountId = await seedAccount();
    const saved = await saveAddress(accountId, input());
    expect(saved.country).toBe("IT");
    expect(saved.verification).toEqual({ status: "not_checked" });

    const listed = await listAddresses(accountId);
    expect(listed).toHaveLength(1);

    const owned = await getOwnedAddress(accountId, saved.id);
    expect(owned.label).toBe("Home");

    const updated = await updateAddress(accountId, saved.id, {
      address: input({ label: "Casa" }),
      is_default: true,
    });
    expect(updated.label).toBe("Casa");
    expect(updated.is_default).toBe(true);

    await deleteAddress(accountId, saved.id);
    await expect(listAddresses(accountId)).resolves.toHaveLength(0);
    await client.query(`DELETE FROM sellers WHERE id = $1`, [accountId]);
  });

  it("enforces the 10-address cap, race-safe", async () => {
    const accountId = await seedAccount();
    for (let i = 0; i < MAX_ADDRESSES_PER_ACCOUNT; i++) {
      await saveAddress(accountId, input({ label: `Addr ${i + 1}` }));
    }
    await expect(saveAddress(accountId, input({ label: "One too many" }))).rejects.toBeInstanceOf(AddressLimitError);
    await client.query(`DELETE FROM sellers WHERE id = $1`, [accountId]);
  });

  it("keeps exactly one default across saves and updates", async () => {
    const accountId = await seedAccount();
    const first = await saveAddress(accountId, input(), { isDefault: true });
    const second = await saveAddress(accountId, input({ label: "Work", city: "Roma" }), { isDefault: true });
    const listed = await listAddresses(accountId);
    expect(listed.filter((a) => a.is_default)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: second.id, is_default: true })]),
    );
    expect(listed.filter((a) => a.is_default)).toHaveLength(1);
    expect(listed[0].id).toBe(second.id); // default sorts first

    const promoted = await updateAddress(accountId, first.id, { address: input(), is_default: true });
    expect(promoted.is_default).toBe(true);
    const after = await listAddresses(accountId);
    expect(after.filter((a) => a.is_default)).toEqual([expect.objectContaining({ id: first.id })]);

    await client.query(`DELETE FROM sellers WHERE id = $1`, [accountId]);
  });

  it("hard-deletes with the account (ON DELETE CASCADE)", async () => {
    const accountId = await seedAccount();
    await saveAddress(accountId, input());
    await client.query(`DELETE FROM sellers WHERE id = $1`, [accountId]);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM account_addresses WHERE account_id = $1`,
      [accountId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("rejects a non-ISO country at the schema surface too", async () => {
    const accountId = await seedAccount();
    await expect(saveAddress(accountId, input({ country: "XX" }))).rejects.toBeInstanceOf(CountryCodeError);
    await client.query(`DELETE FROM sellers WHERE id = $1`, [accountId]);
  });
});
