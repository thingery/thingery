# Moderation Runbook v1 — SQL takedowns

> Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.

This is the v1 stopgap for security hardening item [H4](security.md#h4--spam-and-fake-seller-controls--security-event-logging):
Thingery has no admin surface yet, so removing a spam or illegal listing or cutting off an
abusive seller means an operator running SQL against the database. Until the admin surface
exists, **this document is the takedown path** — so it is written to be executed, not read.
Every command below was tested end-to-end against a freshly seeded local database; see
[Tested how](#tested-how) at the bottom.

The procedures describe *database state changes*, not product behavior — they stay true
even after an admin UI replaces them.

## Safety rails — read before touching anything

- **Soft-delete only. Never `DELETE` rows.** `items.seller_id` has `ON DELETE CASCADE`
  (`db/schema.sql`): deleting one seller row destroys **all** of that seller's listings —
  exactly the evidence you are trying to preserve.
- **Always `WHERE id = '<exact uuid>'`.** Copy the UUID from a `SELECT` you just ran —
  never paste an id from a report or chat message without re-selecting it.
- **Run inside a transaction, `SELECT` before `UPDATE`.** You must see the row you are
  about to change (right title, right seller) before the `UPDATE` runs.
- **Snapshot before you change anything.** A moderation action may end up in a dispute or
  a legal request; the snapshot is your evidence. See [step 1](#1-preserve-evidence-first).
- **Use `psql` with `-v ON_ERROR_STOP=1`** so a failed statement aborts the transaction
  instead of leaving half of it applied (tested: a mid-transaction error rolls back cleanly).
- **Where this runs:** on the production VPS, inside the compose network — see
  [Where these commands run](#where-these-commands-run). Local testing setup is at the bottom.

## Where these commands run

On the VPS (`ssh` in as the `thingery` user, from `/opt/thingery` — see
[deploy-vps.md](deploy-vps.md)):

```bash
docker compose -f docker-compose.prod.yml exec db psql -U thingery -d thingery
```

For piped SQL (the transaction blocks below), add `-T`:

```bash
docker compose -f docker-compose.prod.yml exec -T db psql -U thingery -d thingery -v ON_ERROR_STOP=1 <<'SQL'
...
SQL
```

Locally (self-host or rehearsal), plain `psql` against `DATABASE_URL` works the same:
`psql "$DATABASE_URL" -v ON_ERROR_STOP=1`.

## 1. Preserve evidence first

Before any destructive change, take a snapshot with the same tooling as the nightly
backups ([deploy-vps.md §4](deploy-vps.md#4-nightly-backups-do-not-skip)):

```bash
# VPS
docker exec $(docker ps -qf name=db) pg_dump -U thingery thingery \
  | gzip > /var/backups/thingery-evidence-$(date +%F-%H%M).sql.gz
ls -l /var/backups/thingery-evidence-*.sql.gz   # size must be plausible, not ~20 bytes
```

Two checks that matter (both burned someone already):

- **Verify the dump is not empty.** If `pg_dump` fails (e.g. client/server version
  mismatch), the pipe still writes a tiny valid-gzip file. `gzip -t` passes on an empty
  stream — check the file *size*, and prefer `set -o pipefail` so the pipeline fails.
- **A backup that was never restored is not a backup.** Spot-restore it into a scratch
  container using the [monthly restore test](deploy-vps.md#restore-test-monthly-5-minutes)
  before you rely on it for a dispute.
- **Handle the snapshot like the secret it is.** The dump contains every seller API key
  and password hash in plaintext (until [H2](security.md#h2--secrets-at-rest-hash-api-keys-encrypt-backups-wire-prod-secrets-properly)
  ships encrypted backups): `chmod 600` the file, and delete it or move it to encrypted
  storage once the dispute closes. Do not leave extra plaintext copies lying around.

## 2. Take down a listing

Takedown = soft-delete: `items.status` moves to `'deleted'` (allowed values are defined by
the `CHECK` constraint in `db/schema.sql`: `active`, `reserved`, `sold`, `deleted`).
The row, its history and its attributes stay in the database; it disappears from
`search_items`, `get_item` returns `not_found`, and it is hidden from the seller's own
`my_listings`. No restart or cache flush is needed — the next request already sees it.

First find the exact item and copy its `id`:

```sql
SELECT i.id, i.title, i.status, i.seller_id, s.display_name
  FROM items i JOIN sellers s ON s.id = i.seller_id
 WHERE i.title ILIKE '%<title fragment>%';
```

Then take it down (paste the `id` into both statements — the `SELECT` must show the
row you expect **before** the `UPDATE` runs):

```sql
BEGIN;
SELECT id, title, status FROM items WHERE id = '<item-uuid>';
UPDATE items SET status = 'deleted' WHERE id = '<item-uuid>';
SELECT id, title, status, updated_at FROM items WHERE id = '<item-uuid>';
COMMIT;
```

`UPDATE 1` on the update and `status | deleted` on the final select mean success. If the
`SELECT` shows zero rows, the UUID is wrong: `ROLLBACK` and re-find it. A mistaken
takedown is reversible (`SET status = 'active'`) — do that only after a review, and keep
the evidence snapshot either way. To take down many listings from one seller, run the
same transaction once per item id — no `WHERE title ILIKE` shortcuts on the `UPDATE`.

## 3. Disable a seller without deleting their data

Two credentials can bring a seller back: their `thg_...` API key, and — for sellers who
signed up with email + password — their account login, which also **displays the current
API key** on the account page (`GET /api/me`). **Rotating the key alone only disables
key-only sellers**: an account holder simply logs in again and reads the fresh key, so
for them the password must be scrambled in the same transaction. The single `UPDATE`
below does both and is safe for key-only sellers too (a scrambled password on a seller
with no email can never match anything).

What this disables: the seller's API key **and** their password, immediately — no data
is deleted and existing listings stay searchable (take them down individually with
step 2 if needed). What it does **not** do: kill an already-active browser session —
see [Residual risk: live sessions](#residual-risk-live-sessions) below.

First find the seller and copy their `id` (keys are masked on purpose — never print
full `thg_...` values to a terminal that may be shared, screenshotted, or in scrollback):

```sql
SELECT id, display_name, email,
       password_hash IS NOT NULL AS has_account,
       left(api_key, 12) || '…' AS api_key_prefix
  FROM sellers
 WHERE display_name ILIKE '%<name fragment>%' OR email ILIKE '%<email fragment>%';
```

Then disable their credentials (core Postgres functions only — works on any Postgres 13+;
the `disabled:` password value fails `verifyPassword` for every password, so login is
denied):

```sql
BEGIN;
SELECT id, display_name, password_hash IS NOT NULL AS has_account
  FROM sellers WHERE id = '<seller-uuid>';
UPDATE sellers
   SET api_key = 'thg_rotated_' || replace(gen_random_uuid()::text, '-', '')
                      || replace(gen_random_uuid()::text, '-', ''),
       password_hash = 'disabled:' || replace(gen_random_uuid()::text, '-', '')
 WHERE id = '<seller-uuid>';
SELECT id, display_name,
       api_key LIKE 'thg_rotated_%' AS key_rotated,
       password_hash LIKE 'disabled:%' AS password_disabled
  FROM sellers WHERE id = '<seller-uuid>';
COMMIT;
```

`key_rotated | t` and `password_disabled | t` mean success. The new `thg_rotated_...`
value is random and known to no one (including you — and you do not need it). There is
no key-recovery flow (that is [H2](security.md#h2--secrets-at-rest-hash-api-keys-encrypt-backups-wire-prod-secrets-properly)
work); for a legitimate seller locked out by mistake, the answer is a new account, not
an un-rotation.

If your database has the `pgcrypto` extension, `encode(gen_random_bytes(24), 'hex')` is
an equivalent source of randomness for the key — but remember `gen_random_bytes()` is
**pgcrypto-only**, not a core function even on Postgres 18 — and keep the
`password_hash` scramble exactly as above.

### Residual risk: live sessions

Sessions are stateless HMAC cookies carrying only the seller id, with a 30-day
lifetime and no per-seller revocation (that is H4/H2 work). A seller with an
**already logged-in** browser keeps write access after this procedure — image upload
and chat — and `/api/me` will show them the *new* rotated key. If a live session must
die now, the only lever today is rotating `SESSION_SECRET` in the VPS `.env` and
restarting the app, which logs **everyone** out — a leadership call during an
incident, not a default.

Verify after the change: an MCP call with the old key returns `unauthorized`, a login
attempt with the old password fails, and `search_items` still returns their listings.

## What never to do

- **Never `DELETE FROM items` or `DELETE FROM sellers`.** Hard-delete destroys evidence
  and (for sellers) cascade-deletes every listing they ever had.
- **Never run an `UPDATE` without `WHERE id = '<exact uuid>'`** — no title matches, no
  email matches, nothing fuzzy on the write path.
- **Never moderate without a snapshot** taken in step 1, first.
- **Never rotate or paste real `thg_...` keys into issues, chats, or PRs.** If you need to
  reference one in a report, the seller UUID is enough.

## Tested how

Every procedure above was executed against a clean local environment on 2026-10-12 —
twice: once when the runbook was written, and again after the security review, which
added the password scramble, key masking, and the live-session caveat to §3.

Environment: fresh database, `npm run db:migrate` + `npm run db:seed` (3 items, 1
demo seller), plus one account seller created through `POST /api/signup` so the
account-holder path was exercised for real. Sequence and results:

- evidence snapshot + restore check into a scratch database (1 seller / 3 items);
- takedown transaction: `search_items` 3 → 2, `get_item` → `not_found`, row preserved;
- disable procedure: old password login → 401, old MCP key → `unauthorized`,
  listings count unchanged, and a pre-existing browser session still valid and shown
  the *new* rotated key via `/api/me` — the residual risk documented above, observed
  exactly as described.

The transcripts are in the PR that added this file.

Re-test after any schema change to `items.status`, `sellers.api_key`, or the auth lookup
in `src/auth.ts` (`docs drift` rule: this runbook must describe the code that is actually
deployed). Rehearse locally with:

```bash
npm run db:migrate && npm run db:seed
psql "postgres://thingery:thingery@localhost:5432/thingery"   # or "$DATABASE_URL" if exported
```

When the admin surface from H4 lands, replace the procedures here with the UI path and
keep the safety rails — the rails outlive the tooling.
