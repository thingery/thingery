# Admin UI — reports moderation queue

> Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.

This is the operator guide to the admin UI: the browser surface at `/admin/*` for
handling dispute and abuse queues without SQL. Today it has two queues —
`/admin/disputes` (order disputes, documented in the dispute sections of
[security.md](security.md)) and `/admin/reports` (item reports, this document).
The audience is a self-hoster holding the admin key. The SQL fallback for
everything the UI does not cover yet (disabling a seller, mass takedowns)
stays in the [moderation runbook](moderation-runbook.md).

The page and the JSON admin routes run the **same server-side state machine**
(`src/routes.ts`) — the UI is transport, not a second brain. What you do here,
`curl` could do too; the table at the bottom lists the script path.

## Enable it (fail-closed)

The admin UI boots only when **both** of these are set in the environment:

- `ADMIN_API_KEY` — at least 32 characters (`openssl rand -hex 32`);
- `SESSION_SECRET` — at least 32 characters, set explicitly. The ephemeral
  random fallback that login sessions use does **not** count for the admin UI:
  admin sessions and their CSRF tokens would silently invalidate on every
  restart.

If either is missing or short, every `/admin` page returns **404** — a disabled
admin surface is indistinguishable from an absent one. The boot log tells you
which side failed:

```text
[config] Admin dispute route disabled (ADMIN_API_KEY unset or shorter than 32 chars)
```

```text
[config] SESSION_SECRET unset or shorter than 32 chars — the admin UI stays disabled
(all /admin pages 404). The JSON admin endpoint is unaffected. Set SESSION_SECRET
explicitly (`openssl rand -hex 32`) so admin sessions survive restarts.
```

Run behind TLS (the session cookie is marked `Secure` and will not survive a
plain-HTTP hop anyway). The key itself is a bearer credential for two humans on
a two-person moderation team. Rotating it (change the env value, redeploy)
blocks any *new* login with the old key, but sessions issued before the
rotation stay valid for up to 8 hours — to sign everyone out **now**, rotate
`SESSION_SECRET` instead (that invalidates every admin session immediately).

## Sign in

Open `/admin/login`, paste the admin key, submit. The page is unlinked and
`noindex`-ed; nothing on the public site points at it. On a timing-safe key
match the server sets an HMAC session cookie:

- name `admin_session`, **8-hour** expiry;
- `HttpOnly`, `Secure`, `SameSite=Strict`, scoped to the `/admin` path;
- signed with `SESSION_SECRET` — restarts keep sessions only if the secret is
  stable, and rotating the secret signs everyone out (rotating the admin key
  does not — it only blocks new logins; see above).

A wrong key returns 401 and consumes one slot of the strict action limiter
(see [rate limits](#rate-limits)). Every admin page has a **Sign out** button;
it is a CSRF-stamped form that clears the cookie.

## The queue: `/admin/reports`

The reports queue lists **open, item-targeted reports**, newest first. (Reports
against order reviews never appear here — they keep their own triage path.)
Anonymous visitors are redirected to the login page; expired sessions likewise.

Each report card shows, top to bottom:

- the report id (first 8 characters), the reporter's chosen **reason** as a
  badge (`explicit_images`, `scam_fraud`, or `other`), the creation time in
  UTC, and the reporter's account id (first 8 characters);
- the reported item's title with a link to the listing as it currently stands
  (a suspended or deleted item's link 404s for everyone, including you);
- the **motivation** — the free text the reporter wrote, verbatim, in a
  distinct block. This is the content the reporter wrote *for the moderation
  reader*; treat it as untrusted input that happens to be displayed to you
  (it is HTML-escaped by the server).

With no open reports the page says exactly that: `No open reports right now.`

The page shows at most the **100 most recent** open reports. When more exist,
a note at the bottom says so (`More than 100 open reports — showing the 100
most recent.`); there is no pagination in v1 — the oldest beyond 100 stay open
and are reachable once the queue drains.

Page reads are metered separately and generously (300/hour per IP), so keeping
the queue open on a second monitor never eats the action budget below.

## The three actions

Every card carries three CSRF-stamped forms:

| Form | Effect on the listing | Effect on the report | Owner email |
|---|---|---|---|
| **Suspend listing (reversible)** | `active`/`stored` → `suspended`: hidden from every public surface (search, `/browse`, item page), row preserved | open → `resolved`, resolution recorded as `suspended` | planned — with the reason you typed, subject to the owner's notification prefs |
| **Delete listing (permanent)** | `active`/`stored`/`suspended` → `deleted` (terminal) | open → `resolved`, resolution recorded as `deleted` | planned — with the reason you typed, subject to the owner's notification prefs |
| **Dismiss report** | none — the listing is untouched | open → `dismissed` (terminal) | no |

Two fields, both capped at 500 characters:

- **Suspend** and **delete** require a reason (1–500 chars) — it is sent to the
  listing owner verbatim in the notification email, so write it as a message to
  them, not as an internal note.
- **Dismiss** takes an optional note (≤500 chars) — stored as the audit trail,
  never emailed.

The owner email is ordered *after* the database transaction commits and is sent
at most once per item and event (`suspended:<item-id>` / `takedown:<item-id>`
dedupe keys — re-suspending after a reinstate does not re-notify). As always
with listings, nothing is row-deleted: a deleted item keeps its history in the
database and in backups.

**Auto-resolution is part of the same transaction as the status change:** a
report can never stay open under a hidden or deleted listing, and it never
re-opens. Dismissal is the reviewed-no-action leg — the report resolves without
anything happening to the listing. Resolved and dismissed reports leave the
queue and cannot re-enter it; acting on a report id that is no longer open
returns the same uniform 404 as an unknown id (no existence oracle).

After a successful action the browser is redirected back to the queue
(`303 → /admin/reports?done=<report-id>&action=<verb>`) and the queue renders a
one-line confirmation, e.g.:

```text
Report 1ee90a57… — listing suspended — hidden from every public surface, owner notified. It has left the queue.
```

This redirect pattern means refreshing the page or re-submitting the form
cannot double-apply the action. Validation failures (empty or over-long
reason) return a 400 page and change nothing.

**Undo:** suspend is the only reversible action — reinstate over the JSON
route (`POST /api/admin/items/<item-id>/reinstate` with the Bearer admin key,
empty body) puts the listing back to `active`. Delete is terminal; the
evidence lives in your nightly backups.

## Rate limits

Two per-IP buckets, both in-memory (a restart resets them):

| Bucket | Limit | Covers |
|---|---|---|
| Page reads | **300/hour** | every `/admin` page GET — queue, login, disputes pages |
| Actions | **10/hour** | login POST, suspend, takedown, dismiss (the same budget the JSON admin routes share) |

Exhausting the action bucket returns 429 `Too many attempts` — including on
failed logins, which is the point: brute-forcing the key and working the queue
draw from the same strict budget. The read bucket is deliberately separate so
routine queue polling cannot starve it.

## Script path (same semantics, Bearer key)

Every queue action exists as a JSON route for scripts and rehearsals. Same
state machine, same validation, same auto-resolution, same owner email — only
the transport differs (Bearer key instead of session; JSON responses instead of
PRG redirects):

| Endpoint | Body | Notes |
|---|---|---|
| `GET /api/admin/reports` | — | queue rows, capped at the same 100 most recent (no pagination) |
| `POST /api/admin/reports/:id/dismiss` | `{"note": "..."}` (note optional) | |
| `POST /api/admin/items/:id/suspend` | `{"reason": "..."}` (1–500 chars) | |
| `POST /api/admin/items/:id/takedown` | `{"reason": "..."}` (1–500 chars) | |
| `POST /api/admin/items/:id/reinstate` | `{}` (empty) | only route that leaves `suspended` |

All take `Authorization: Bearer <ADMIN_API_KEY>`. They are gated by the admin
key alone — they work even when the UI's `SESSION_SECRET` gate is closed.
There is deliberately no example key or prod endpoint in this document.

## Tested how

Executed end-to-end against a clean local environment (fresh database,
`npm run db:migrate` + `npm run db:seed` — 3 seeded items) with
`ADMIN_API_KEY` and `SESSION_SECRET` both set, on 2026-11-28:

- boot gate: with `SESSION_SECRET=too-short`, `/admin/login` and
  `/admin/reports` both 404 and the boot warning above is logged; fully set,
  both mount;
- login: anonymous `/admin/reports` → 303 to `/admin/login`; wrong key → 401;
  correct key → 303 to `/admin/disputes` with the `HttpOnly`/`Secure`/
  `SameSite=Strict` cookie expiring 8h out;
- queue: an account created via signup filed three item reports through the
  public `POST /api/items/:id/report`; all three cards rendered newest-first
  with reason badge, UTC time, reporter prefix, item title, and the motivation
  verbatim; empty state rendered after the queue drained;
- suspend → 303 PRG, confirmation line, item `suspended`, report `resolved`
  with `resolution_action = suspended`, suspended item 404s on its public item
  page and is absent from `/browse`;
- takedown: empty reason → 400 page (`Provide a 1–500 character removal
  reason…`, nothing changed); valid reason → item `deleted`, report `resolved`
  with `resolution_action = deleted`;
- dismiss → report `dismissed` with the optional note stored, listing
  untouched, no owner email;
- re-acting on a resolved report → uniform 404; a forged `?done=`/`?action=`
  renders no confirmation line;
- overflow: 102 open reports → exactly 100 cards plus the
  `More than 100 open reports — showing the 100 most recent.` note;
- limits: repeated wrong logins returned 401 then 429 within the same hour
  while queue page reads kept returning 200 (separate buckets observed live);
- reinstate over JSON returned the suspended item to `active`.

Re-test after any change to `src/routes.ts` admin sections or the reports
state machine (`docs drift` rule: this document must describe the code that is
actually deployed).
