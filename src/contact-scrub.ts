// Contact-info screening (spec THI-439 §3.3): wanted items are public,
// buyer-authored content, and the marketplace's no-off-platform rule means
// they must not carry contact info — responses happen exclusively through
// listings (ADR 0007). This module is the single choke point applied to
// title + notes at create AND edit, on both the MCP and HTTP paths.
//
// Decision (spec, reviewed): REJECT, never rewrite. A tripped rule returns a
// typed `contact_info` error naming the rule and field — the caller (a model
// or the web form) rephrases. Silent scrubbing corrupts user content;
// blocking is agent-friendly. Over-blocking direction accepted: false
// positives are rephraseable, false negatives are a fraud vector. The list
// is deliberately small — a fraud-cost raiser, not a parser. Security owns
// the rules (THI-442 review gate); they are module constants so changing
// them is one reviewed edit.

/** Rule slugs — fixed list, one per detection family (spec §3.3). */
export type ContactScrubRule =
  | "email"
  | "phone"
  | "url"
  | "handle"
  | "service_word"
  | "contact_link";

export type ScreenedField = "title" | "notes" | "reference_images";

export interface ContactScrubHit {
  rule: ContactScrubRule;
  field: ScreenedField;
  /** The matched substring — used only to build the rejection message shown
   *  back to the same author; never logged (no-payload rule, THI-112). */
  match: string;
}

// Fixed service-word list (case-insensitive, word-bounded).
const SERVICE_WORDS = [
  "whatsapp", "telegram", "signal", "viber", "discord", "snapchat",
  "dm me", "text me", "call me",
] as const;

// x@y.tld — one local@domain pair, both parts at least one char, TLD ≥ 2.
const EMAIL = /\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/;

// http(s)://… or www.… up to whitespace.
const URL = /\b(?:https?:\/\/|www\.)\S+/i;

// @handle: @ + 2–30 handle chars (letters/digits/underscore), not part of a
// longer token (so it does not re-catch the domain side of an email — the
// email rule fires first anyway; ordering below is url → email → phone →
// handle → service words).
const HANDLE = /(?:^|[^@\w])@([A-Za-z0-9_]{2,30})\b/;

// Phone-shaped: a run of ≥ 7 digits with optional +/space/dot/dash/paren
// separators. Digit count is re-checked in code so separator-heavy short
// runs (dates, "size 43") never trip.
const PHONE = /\+?[0-9][0-9\s().-]{5,}[0-9]/g;

const RULE_PATTERNS: Array<{ rule: ContactScrubRule; re: RegExp }> = [
  { rule: "url", re: URL },
  { rule: "email", re: EMAIL },
  { rule: "handle", re: HANDLE },
];

/** Screens one field's text; returns the first hit or null. */
function screenText(text: string, field: ScreenedField): ContactScrubHit | null {
  for (const { rule, re } of RULE_PATTERNS) {
    const m = text.match(re);
    if (m) return { rule, field, match: m[0] };
  }
  // Phone: candidate runs whose digit count is >= 7.
  for (const m of text.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, "").length;
    if (digits >= 7) return { rule: "phone", field, match: m[0] };
  }
  const lowered = text.toLowerCase();
  for (const word of SERVICE_WORDS) {
    const idx = lowered.indexOf(word);
    if (idx !== -1) {
      const before = idx === 0 ? " " : lowered[idx - 1];
      const after = idx + word.length >= lowered.length ? " " : lowered[idx + word.length];
      if (!/\w/.test(before) && !/\w/.test(after)) {
        return { rule: "service_word", field, match: text.slice(idx, idx + word.length) };
      }
    }
  }
  return null;
}

/** Screens the wanted-item text fields (title + notes). Returns the first
 *  hit, or null when the text is clean. URL/email/handle/phone rules run
 *  before service words so the most specific rule names the problem. */
export function screenContactInfo(fields: { title: string; notes: string }): ContactScrubHit | null {
  return screenText(fields.title, "title") ?? screenText(fields.notes, "notes");
}

// THI-442 rider W1: reference_images are http(s) URLs by construction, so
// the text-field URL rule would reject all of them — the contact risk is a
// URL whose host/path IS a contact channel (messaging/meeting deep links,
// encoded phones/handles). Screened separately, same typed error.

/** Messaging/meeting deep-link host+path prefixes (fixed list, Security-
 *  owned). Any reference-image URL matching one is a contact link by design. */
const CONTACT_LINK_HOSTS = [
  "wa.me",
  "t.me",
  "telegram.me",
  "discord.gg",
  "discord.com/invite",
  "signal.me",
  "snapchat.com/add",
  "meet.google.com",
  "zoom.us/j",
  "calendly.com",
  "cal.com",
] as const;

/** Contiguous digit run anywhere in the URL (phone encoding; ≥ 8 digits —
 *  W1, over-blocking direction accepted, same posture as the text rules). */
const DIGIT_RUN = /\d{8,}/;

/** Screens one reference-image URL (W1): returns a hit when the URL encodes
 *  an off-platform contact channel, else null. Order: deep-link hosts →
 *  service word anywhere in host+path (substring, not word-bounded — a
 *  URL has no word boundaries to respect) → email shape → digit run. */
export function screenReferenceImage(url: string): ContactScrubHit | null {
  let parsed: URL;
  try {
    // globalThis.URL: the module-level URL *regex* shadows the constructor
    // name — an unqualified `new URL` here would always throw.
    parsed = new globalThis.URL(url);
  } catch {
    return { rule: "url", field: "reference_images", match: url.slice(0, 60) }; // unreachable: shape checks run first
  }
  const hostPath = `${parsed.host}${parsed.pathname}`.toLowerCase();
  for (const prefix of CONTACT_LINK_HOSTS) {
    if (hostPath.startsWith(prefix)) {
      return { rule: "contact_link", field: "reference_images", match: prefix };
    }
  }
  const lowered = `${parsed.host}${parsed.pathname}${parsed.search}`.toLowerCase();
  for (const word of SERVICE_WORDS) {
    if (lowered.includes(word)) {
      return { rule: "service_word", field: "reference_images", match: word };
    }
  }
  const email = lowered.match(EMAIL);
  if (email) return { rule: "email", field: "reference_images", match: email[0] };
  const digits = lowered.match(DIGIT_RUN);
  if (digits) return { rule: "phone", field: "reference_images", match: digits[0] };
  return null;
}

/** Human-facing rejection message for a hit — names the rule family and the
 *  field, then states the rule (responses happen through listings). */
export function contactInfoMessage(hit: ContactScrubHit): string {
  const ruleText: Record<ContactScrubRule, string> = {
    email: "an email address",
    phone: "a phone number",
    url: "a link/URL",
    handle: "a social handle (@…)",
    service_word: "a contact-service word",
    contact_link: "a messaging/meeting link",
  };
  return (
    `${hit.field} looks like it contains ${ruleText[hit.rule]} — ` +
    "responses happen through listings; describe what you want in words"
  );
}
