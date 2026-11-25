# Ops smoke-test policy — no synthetic sellers left in prod

> Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.

Deployments with real traffic sometimes run smoke tests, deploy verifications,
and probes that need an authenticated seller against **production** — that is
allowed, but they must leave nothing behind. Audits of live deployments have
found synthetic seller accounts accumulated in the `sellers` table from
untracked ops runs (in one case dozens of synthetic accounts against a handful
of real ones), and purging them needed a scoped, deliberately-approved deletion
task. This document exists so that never needs to happen again.

## Rules — every smoke test that creates a seller in prod

1. **Disposable, traceable email.** The account must be created with an email
   of the form `ops+thiXXX+<UTC timestamp>@thingery.test`, where `thiXXX` is
   the issue the run belongs to (e.g. `ops+thi388+20261027T1030Z@thingery.test`).
   Never reuse a previous run's account, never use a real-looking domain, and
   never use `@example.com` or the bare domain of a real mailbox provider —
   the tag + fake domain is what makes future audits easy.
2. **Delete the account before the run ends.** The same heartbeat that created
   the account deletes it. If the run created items, decide first:
   - **Items that only exist to prove the smoke test worked** → they are
     deleted together with the account: `items.seller_id` is
     `ON DELETE CASCADE` (`db/schema.sql`), so `DELETE FROM sellers` removes
     them — but **verify the item count matches what you created** before
     deleting, so the cascade deletes exactly your rows and nothing else.
   - **Items someone may still want** (demo/walkthrough data) → archive or
     delete the items explicitly first, then delete the seller. Record in the
     issue what was kept and why.
3. **Record the cleanup in the task comment** — account email, seller id,
   item count at deletion, and the after-state. A cleanup that is not
   documented did not happen.
4. **If deletion is blocked, report it — never force it.** A seller that has
   rows in `orders` as buyer (`orders.buyer_id`, no cascade) cannot be
   hard-deleted without touching order history. Do not cascade or truncate
   anything to work around it; leave the account, and note it in the issue for
   a scoped purge decision instead.

## Cleanup SQL (run on the VPS, per [deploy-vps.md](deploy-vps.md))

Same shape as the moderation runbook: `SELECT` before `DELETE`, exact uuid,
`ON_ERROR_STOP`, single transaction. The guard skips — never forces — anything
with items or foreign-key references:

```bash
docker exec -it thingery-db-1 psql -U thingery -d thingery -v ON_ERROR_STOP=1
```

```sql
BEGIN;
-- must return exactly the account you created, with the item count you expect
SELECT id, email FROM sellers WHERE email = 'ops+thiXXX+<ts>@thingery.test';
SELECT count(*) FROM items WHERE seller_id = '<uuid>';

DELETE FROM sellers WHERE id = '<uuid>';
-- FK violation (orders as buyer)? -> ROLLBACK and report per rule 4
COMMIT;
```

## Audit query — leftovers are findable

Any run can sweep for synthetic leftovers (read-only). The `WHERE` clause is
the **canonical synthetic-seller predicate** (first codified in the THI-1501
audit, 2026-11-25): ops-tagged accounts plus every test domain actually
observed in prod. An earlier four-domain version of this query missed 13
untagged synthetic sellers on other test domains — treat the list below as
the source of truth and extend it whenever a new run introduces a new domain.

```sql
SELECT id, email, created_at,
       (SELECT count(*) FROM items i WHERE i.seller_id = s.id) AS items
FROM sellers s
WHERE email LIKE 'ops+%'
   OR email LIKE '%@thingery.test'      OR email LIKE '%@test.thingery.dev'
   OR email LIKE '%@demo.thingery.dev'  OR email LIKE '%@example.com'
   OR email LIKE '%@example.test'       OR email LIKE '%@e2e-test.invalid'
   OR email LIKE '%mail-tester.com'
ORDER BY created_at;
```

Notes: sellers with `NULL` email are legacy API-key-era accounts and count as
organic (the `LIKE` predicates exclude them naturally). Do **not** classify
by item-title markers — titles are mutable; the email tag is the identity
anchor.

Anything this returns that is not covered by an open ops issue is exactly the
kind of debt those audits found — file it, do not silently delete it.

## Tested how

The SQL guard above is the exact pattern executed end-to-end during a real
production purge: 20/21 targets deleted, 1 correctly skipped on
`orders_buyer_id_fkey`, with before/after counts recorded in the run's task.
The extended audit predicate above is the one used for the 2026-11-25 source
audit (THI-1501), where it surfaced the 13 untagged misses the four-domain
version had let accumulate.
