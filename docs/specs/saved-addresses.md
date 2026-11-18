# Spec: saved shipping addresses

Status: accepted (rollout in progress — thingery steps 1–4 shipped; platform steps
pending). Touches protected paths
`db/schema.sql`, `src/tools.ts`, `src/routes.ts`. See
AGENTS.md for the review those need.

## Problem

A buyer types the full shipping address on every order, in the chat and on the web buy form. Nothing
is remembered, and nothing checks the address: a typo or a wrong postal code only surfaces when the
seller buys a label, or when the parcel comes back. People also have no place to see, fix or remove
an address.

## Context

- Orders are created through one path, the `create_order` MCP tool (`src/tools.ts`). The chat calls it only after the user confirms the
  write. The web buy form calls it through the platform's tool client.
- `create_order` takes `shipping_address` (`name`, `line1`, `line2?`, `city`, `postal_code`,
  `country`), checked by zod for presence and length only, with unknown keys rejected. `country` must
  be two letters; it is not checked against ISO 3166-1, so `XX` passes.
- The order stores its own copy in `orders.shipping_address` (JSONB). Only the order's parties can
  read it, and on off-platform orders the seller sees it only after the buyer agrees to share it.
- Accounts are the `sellers` table. It has no address columns.
- EasyPost (`src/easypost.ts`) already receives the order's address when the seller buys a label
  (`buy_shipping_label`). With `EASYPOST_API_KEY` unset, carrier features run in degraded mode.
- The seller's from-address for a label is typed on each purchase and not stored either.
- Emails, notifications and logs never carry addresses (docs/security.md, PII minimization).
- There is no account deletion endpoint today.

## Goals

1. A signed-in user can save addresses, pick one when ordering (chat or web), and see, edit, set a
   default or delete them.
2. Addresses are checked when saved, and a likely mistake is shown with a suggested fix. The check
   warns; it never blocks.
3. No new copies of the address in places that do not need it: not in logs, emails, notifications, or
   the language model's context.

Non-goals for this spec: the seller's from-address for labels (a follow-up can reuse the same store),
address autocomplete while typing, and account deletion.

## Proposed design

### Storage

A new table, additive, owned by the account:

```sql
CREATE TABLE IF NOT EXISTS account_addresses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  label         TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),  -- "Home", "Work"
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  line1         TEXT NOT NULL CHECK (char_length(line1) BETWEEN 1 AND 200),
  line2         TEXT CHECK (line2 IS NULL OR char_length(line2) <= 200),
  city          TEXT NOT NULL CHECK (char_length(city) BETWEEN 1 AND 80),
  postal_code   TEXT NOT NULL CHECK (char_length(postal_code) BETWEEN 1 AND 20),
  country       CHAR(2) NOT NULL,                  -- ISO 3166-1 alpha-2, checked in code
  is_default    BOOLEAN NOT NULL DEFAULT false,
  verification  JSONB NOT NULL DEFAULT '{"status":"not_checked"}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS account_addresses_one_default
  ON account_addresses (account_id) WHERE is_default;
```

- **At most 10 addresses per account**, enforced in code before insert.
- **`country` is checked against the ISO 3166-1 alpha-2 list.** That check also applies to
  `create_order`'s typed address, which today accepts any two letters.
- **Editing changes the saved address only.** A past order keeps its own copy, exactly as today.
- **Delete is a hard delete.** Deleting the account removes its addresses (`ON DELETE CASCADE`), ready
  for when account deletion exists.

### Saving is always explicit

An address is never saved as a side effect of an order.
- **Web:** the buy form gains a "Save this address" checkbox, off by default. The settings screen adds,
  edits and deletes addresses.
- **Chat:** after an order with a typed address, the assistant may offer to save it. Saving asks
  the user to confirm in chat, like every other chat write.

### Using a saved address

`create_order` gains `address_id` (UUID), mutually exclusive with `shipping_address`:
- The server loads the address. It must belong to the caller; otherwise it answers 404, never 403, so
  no other account's ids are revealed.
- The server copies the address into `orders.shipping_address`, as if it had been typed, and sets
  `last_used_at`.
- Everything downstream of the order (sharing, labels, the seller's view) is unchanged.

### The model never sees a full saved address

A new read tool, `list_addresses`, returns a summary only:

```json
{ "addresses": [ { "id": "…", "label": "Home", "city": "Milano", "country": "IT",
                   "is_default": true, "verification": "verified" } ] }
```

- The assistant asks "Ship to Home (Milano, IT)?" and orders with `address_id`.
- Name, street and postal code stay on the server. They never reach the model provider or the chat
  history, unless the user types them.
- The tool result is wrapped in `<tool_data>` like any other. `label` is user-written text, so the
  existing injection rules apply.

### New MCP tools (protected surface)

| Tool | Auth | Notes |
|---|---|---|
| `list_addresses` | account | Summary only, as above |
| `save_address` | account | Chat: user confirms the write. Returns the verification result |
| `delete_address` | account | Chat: user confirms the write |
| `create_order` | account | Adds optional `address_id` (additive; no existing field changes) |

Setting the default and editing are web-only in the first version: one form, no chat flow to design.

### HTTP routes for the web settings screen (protected)

`GET /api/me/addresses`, `POST /api/me/addresses`, `PATCH /api/me/addresses/:id`,
`DELETE /api/me/addresses/:id`. Session-authenticated, owner-only (404 otherwise), `asyncHandler`
wrapped. Unlike the model-facing tool, they return full addresses: the owner's own screen needs them.

### Verification (advisory)

When `EASYPOST_API_KEY` is set, saving or editing an address calls EasyPost's address verification
(the delivery check) once. The result is stored in `verification`:

| `status` | Meaning | UI |
|---|---|---|
| `verified` | Deliverable as written | Nothing extra |
| `suggested` | Deliverable with corrections | "Did you mean …?" with the suggestion; one tap to accept it |
| `unverified` | The carrier could not confirm it | A warning; the address can still be saved and used |
| `not_checked` | No key, provider down, or limit reached | Nothing extra |

Rules for the check:
- **Advisory only:** carrier data has gaps in some countries, so a valid address must never be
  refused.
- **When it runs:** on save and edit only. Never on list, and never on every order.
- **Limits:** 20 checks per account per day, as a `RateLimiter` bucket. Over the limit means
  `not_checked`, not an error.
- **Failure:** a timeout or an error from the provider means `not_checked`. Saving never fails
  because of verification.
- **Storage:** only the status, the time of the check and a suggested correction. Never the
  provider's raw response.
- **Privacy:** this sends an address to EasyPost before any label exists, and possibly for an address
  never shipped to. The privacy page must say so. Self-hosters without the key never send anything.

Typed addresses in `create_order` are not verified in the first version. The typed path stays as fast
as today; the same check can be added there later as a warning.

### Security and privacy

- Addresses never appear in logs, `security_events`, emails or notifications. Errors name the field,
  not its value.
- **Rate limits per account:**
  - 30 address writes per hour;
  - the verification limit above;
  - reads share the existing authenticated limits.
- `label` and every field are plain text. The web escapes them on render, and the chat treats them as
  `<tool_data>`.
- docs/security.md gains a short entry: the new PII store, who can read it, the EasyPost disclosure,
  and deletion.

## Rollout

Each step is one PR and ships on its own. Repos follow the two-repo split (open-source
core vs company side): the core ships in `thingery/thingery`; the website and
consumer app ship in `thingery/platform`.

1. ✅ Schema, the address module (`src/addresses.ts`), the ISO country check, tests.
   (thingery, #301)
2. ✅ MCP tools (`list_addresses`, `save_address`, `delete_address`) and `address_id` on
   `create_order`, then `npm run docs:tools`. (thingery, #303)
3. ✅ HTTP routes for the web. (thingery, #306)
4. ✅ EasyPost verification, the advisory statuses and the privacy-page text — **split**:
   the verification code, the advisory statuses and the docs/security.md entry shipped in
   thingery together (#310); the privacy-page text ships in platform (pending).
5. Web: the settings screen and the buy form's picker and "Save this address" checkbox.
   The design is drawn and approved first. (platform)
6. Chat prompt: offer saved addresses before asking for a typed one. (platform)

## Open questions

1. Should the buy form's "Save this address" checkbox stay off by default? This spec says off, to
   keep saving deliberate.
2. Is 10 addresses per account right?
3. Should the chat ever show the street line, for example "Via Roma 1, Milano"? Showing it would let
   users tell apart two addresses in one city. The cost is sending part of the address to the model.
4. What should verification cost per account? EasyPost charges per check, and 20 a day is a ceiling,
   not an expected rate.
