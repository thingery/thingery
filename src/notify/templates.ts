// Email templates (THI-760 plan §6): pure TypeScript functions — subject +
// text + HTML, no framework (YAGNI), English-only in Phase 1 with the
// `locale` field reserved for later phases. Keys follow the plan's
// `{role}.{event}.v1` convention (account-level mail uses the `account`
// role namespace): renaming content later means issuing a new key, never
// mutating meaning — the API-evolution rule applied to humans' inboxes.
//
// THI-1586 PR (b): HTML renders through the board-approved layout
// (layoutHtml below — THI-1584, canvas wins on anything visual). Plain-text
// versions keep their THI-1585 wording; every email keeps the canonical
// footer and all escaping. Operator and ops alerts stay plain by design.

/** Rendered template — exactly what a Mailer receives. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Stable template keys (record on sends when the Phase 1 outbox exists). */
export const EMAIL_TEMPLATE_KEYS = {
  emailVerification: "account.email_verification.v1",
} as const;

/** THI-780 PR 2 (plan §5 + §6): digest line items — public listing data
 * only (item title + link), no counterparties, no addresses (F6). */
export interface DigestItem {
  eventType: string;
  itemTitle?: string;
  url?: string;
}

/** `digest.daily.v1` / `digest.weekly.v1` — one renderer, the frequency is
 * a parameter. Opt-in mail: every digest carries a working one-click
 * unsubscribe link in the body (plus the List-Unsubscribe header the
 * delivery sweep stamps from payload.unsubscribe_url — belt and braces in
 * case the provider strips headers). */
export function renderDigest(p: {
  frequency: "daily" | "weekly";
  count: number;
  items: DigestItem[];
  unsubscribeUrl: string;
}): RenderedEmail {
  const label = p.frequency;
  const subject = subjectSafe(
    p.count > p.items.length
      ? `Your ${label} Thingery digest — ${p.count} updates`
      : `Your ${label} Thingery digest`,
  );
  const lines = p.items.map(
    (it) => `${it.itemTitle ?? it.eventType}${it.url ? ` — ${it.url}` : ""}`,
  );
  const more = p.count > p.items.length ? [`… and ${p.count - p.items.length} more` ] : [];
  const text =
    `Here is what happened on Thingery since your last digest:

` +
    [...lines, ...more].join("\n") +
    `\n\nManage or turn off digests: ${p.unsubscribeUrl}\n` +
    `\n— ${CANONICAL_SENTENCE}\n`;
  const origin = safeOrigin(p.unsubscribeUrl);
  const html = layoutHtml({
    tag: p.frequency === "daily" ? "Daily digest" : "Weekly digest",
    tone: "info",
    heading: "Since your last digest.",
    paragraph: "Here is what happened on Thingery since your last digest.",
    origin,
    digestRows: [
      ...p.items.map((it) => ({ title: it.itemTitle ?? it.eventType, url: it.url })),
      ...(p.count > p.items.length ? [{ moreCount: p.count - p.items.length } as DigestRow] : []),
    ],
    button: origin ? { label: "Browse Thingery", url: `${origin}/browse` } : undefined,
    footerLinks: [{ label: `Turn off ${label} digests`, url: p.unsubscribeUrl }],
  });
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Canonical footer sentence (AGENTS.md — verbatim, never paraphrased). */
const CANONICAL_SENTENCE =
  "Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.";

// ---------------------------------------------------------------------------
// THI-1586 PR (b): the board-approved email layout (THI-1584, approved
// 2026-11-26; the brand canvas wins on anything visual). One column, 600px
// max (fluid on phone), table-based with inline styles only — no flexbox,
// no SVG, no web fonts loaded by the mail itself (the font stacks name the
// brand faces first and fall back to system faces). One hosted image per
// email: the Thread mark PNG, served from the deployment's own base URL so
// self-hosters never reference thingery.dev. Every email keeps its
// plain-text twin and all escaping; layout changes HTML only.

const COLORS = {
  page: "#F6F6F3",
  ink: "#14151A",
  muted: "#565A63",
  panel: "#FFFFFF",
  divider: "#D9DAD6",
  yellow: "#FFCE1F",
  blue: "#2438D6",
  problem: "#A84A00",
} as const;

const FONTS = {
  display: `"Bricolage Grotesque","Arial Black",Arial,sans-serif`,
  body: `"Schibsted Grotesk",Helvetica,Arial,sans-serif`,
  mono: `"Martian Mono",Menlo,Consolas,monospace`,
} as const;

/** Hosted Thread-mark PNG (public/assets/email-logo.png), 128×128, ink,
 *  displayed at the 30px lockup size (retina-sharp, one image per email). */
const LOGO_PATH = "/assets/email-logo.png";

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Status-tag tones (board spec): yellow/ink normal, blue/white info,
 *  burnt-orange/white problem (cancelled, dispute, chargeback, removal). */
type TagTone = "normal" | "info" | "problem";

const TAG_TONES: Record<TagTone, { bg: string; fg: string }> = {
  normal: { bg: COLORS.yellow, fg: COLORS.ink },
  info: { bg: COLORS.blue, fg: "#FFFFFF" },
  problem: { bg: COLORS.problem, fg: "#FFFFFF" },
};

interface PanelRow {
  label: string;
  value: string;
}

/** Digest list rows: a linked item title, or a muted "… and N more" row. */
type DigestRow = { title: string; url?: string } | { moreCount: number };

/** Everything one rendered email needs: approved layout, one column. */
interface EmailLayout {
  tag: string;
  tone: TagTone;
  heading: string;
  paragraph: string;
  /** Deployment base (absolute URL) — logo, and relative links when no
   *  deep link exists. Empty = no logo/CTA can be built. */
  origin: string;
  panelTitle?: string;
  panelAmount?: string;
  panelRows?: PanelRow[];
  digestRows?: DigestRow[];
  button?: { label: string; url: string };
  secondary?: Array<{ label: string; url: string }>;
  /** Verify-email extras: mono link box + expiry/safety note under the CTA. */
  linkFallback?: { lead: string; url: string; note?: string };
  /** Footer links (digest unsubscribe). Label must stay stable — tests and
   *  one-click unsubscribe flows pin it. */
  footerLinks?: Array<{ label: string; url: string }>;
}

/** Renders the approved layout. Table-based, inline styles, phone tweaks via
 *  one small media query (Gmail/Apple Mail honor it; Outlook desktop keeps
 *  the desktop sizes — the graceful default). */
function layoutHtml(l: EmailLayout): string {
  const pad = `class="th-pad" style="padding-left:32px;padding-right:32px"`;
  const rows: string[] = [];

  // 1. Header: Thread mark + wordmark (30px lockup, gap 8).
  const logo = l.origin
    ? `<img src="${escapeHtml(`${l.origin}${LOGO_PATH}`)}" width="30" height="30" alt="Thingery" style="display:block;border:0;width:30px;height:30px">`
    : `<span style="display:inline-block;width:30px;height:30px">&nbsp;</span>`;
  rows.push(
    `<tr><td ${pad} style="padding-top:0;padding-bottom:24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td style="padding:0 8px 0 0;vertical-align:middle">${logo}</td>` +
      `<td style="padding:0;vertical-align:middle;font-family:${FONTS.display};font-size:26px;font-weight:800;letter-spacing:-0.5px;color:${COLORS.ink}">thingery</td>` +
      `</tr></table></td></tr>`,
  );

  // 2. Status tag: flat rectangle, mono 12px bold.
  const tone = TAG_TONES[l.tone];
  rows.push(
    `<tr><td ${pad} style="padding-bottom:16px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
      `<td bgcolor="${tone.bg}" style="background-color:${tone.bg};padding:7px 12px;font-family:${FONTS.mono};font-size:12px;font-weight:700;line-height:1;color:${tone.fg}">${escapeHtml(l.tag)}</td>` +
      `</tr></table></td></tr>`,
  );

  // 3. H1: display 800, 44px desktop / 34px phone (media query).
  rows.push(
    `<tr><td ${pad} style="padding-bottom:12px"><h1 class="th-h1" style="margin:0;font-family:${FONTS.display};font-weight:800;font-size:44px;line-height:1.05;color:${COLORS.ink}">${escapeHtml(l.heading)}</h1></td></tr>`,
  );

  // 4. One short paragraph.
  rows.push(
    `<tr><td ${pad} style="padding-bottom:20px"><p style="margin:0;font-family:${FONTS.body};font-size:15px;line-height:1.55;color:${COLORS.muted}">${escapeHtml(l.paragraph)}</p></td></tr>`,
  );

  // 5. White panel (radius 0): title, mono amount, label/value rows over #D9DAD6.
  const panelRows = [
    ...(l.panelTitle !== undefined
      ? [`<tr><td style="padding:20px 24px 4px;font-family:${FONTS.body};font-size:18px;font-weight:700;line-height:1.3;color:${COLORS.ink}">${escapeHtml(l.panelTitle)}</td></tr>`]
      : []),
    ...(l.panelAmount !== undefined
      ? [`<tr><td style="padding:2px 24px 16px;font-family:${FONTS.mono};font-size:20px;font-weight:700;color:${COLORS.ink}">${escapeHtml(l.panelAmount)}</td></tr>`]
      : []),
    ...(l.panelRows ?? []).map(
      (r) =>
        `<tr><td style="border-top:1px solid ${COLORS.divider};padding:12px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td style="font-family:${FONTS.body};font-size:13px;color:${COLORS.muted}">${escapeHtml(r.label)}</td>` +
        `<td align="right" style="font-family:${FONTS.body};font-size:14px;color:${COLORS.ink}">${escapeHtml(r.value)}</td>` +
        `</tr></table></td></tr>`,
    ),
    ...(l.digestRows ?? []).map((r, i) => {
      const border = i === 0 ? "" : `border-top:1px solid ${COLORS.divider};`;
      if ("moreCount" in r) {
        return `<tr><td style="${border}padding:14px 24px;font-family:${FONTS.body};font-size:14px;color:${COLORS.muted}">… and ${r.moreCount} more</td></tr>`;
      }
      const title = escapeHtml(r.title);
      return r.url
        ? `<tr><td style="${border}padding:14px 24px"><a href="${escapeHtml(r.url)}" style="font-family:${FONTS.body};font-size:15px;font-weight:600;color:${COLORS.ink};text-decoration:none">${title}</a></td></tr>`
        : `<tr><td style="${border}padding:14px 24px;font-family:${FONTS.body};font-size:15px;font-weight:600;color:${COLORS.ink}">${title}</td></tr>`;
    }),
  ];
  if (panelRows.length > 0) {
    rows.push(
      `<tr><td ${pad} style="padding-bottom:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.panel}" style="background-color:${COLORS.panel}">${panelRows.join("")}</table></td></tr>`,
    );
  }

  // 6. ONE primary button: yellow, ink text, radius 6, full width
  //  (bulletproof table button).
  if (l.button) {
    rows.push(
      `<tr><td ${pad} style="padding-top:24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td bgcolor="${COLORS.yellow}" align="center" style="background-color:${COLORS.yellow};border-radius:6px">` +
        `<a href="${escapeHtml(l.button.url)}" style="display:block;padding:14px 24px;border-radius:6px;font-family:${FONTS.body};font-size:16px;font-weight:700;color:${COLORS.ink};text-decoration:none;text-align:center">${escapeHtml(l.button.label)}</a>` +
        `</td></tr></table></td></tr>`,
    );
  }

  // Verify email: paste-link mono box + expiry/safety note.
  if (l.linkFallback) {
    rows.push(
      `<tr><td ${pad} style="padding-top:20px"><p style="margin:0 0 10px;font-family:${FONTS.body};font-size:13px;line-height:1.6;color:${COLORS.muted}">${escapeHtml(l.linkFallback.lead)}</p>` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${COLORS.panel}" style="background-color:${COLORS.panel};border:1px solid ${COLORS.divider};padding:12px 14px;font-family:${FONTS.mono};font-size:12px;line-height:1.6;color:${COLORS.ink};word-break:break-all">${escapeHtml(l.linkFallback.url)}</td></tr></table>` +
        (l.linkFallback.note
          ? `<p style="margin:12px 0 0;font-family:${FONTS.body};font-size:13px;line-height:1.6;color:${COLORS.muted}">${escapeHtml(l.linkFallback.note)}</p>`
          : "") +
        `</td></tr>`,
    );
  }

  // 7. Secondary links, clearly separated.
  if (l.secondary && l.secondary.length > 0) {
    const links = l.secondary
      .map(
        (s) =>
          `<a href="${escapeHtml(s.url)}" style="color:${COLORS.muted};text-decoration:underline">${escapeHtml(s.label)}</a>`,
      )
      .join(`<span style="color:${COLORS.divider}"> &nbsp;·&nbsp; </span>`);
    rows.push(
      `<tr><td ${pad} align="center" style="padding-top:16px"><p style="margin:0;font-family:${FONTS.body};font-size:14px;line-height:1.6;color:${COLORS.muted}">${links}</p></td></tr>`,
    );
  }

  // 8. Footer under a 2px ink rule: support line, unsubscribe where it
  //  applies, canonical sentence verbatim.
  const footerLines = [
    `<p style="margin:0 0 12px">Questions? Reply to this email and it reaches support.</p>`,
    ...(l.footerLinks ?? []).map(
      (f) =>
        `<p style="margin:0 0 12px"><a href="${escapeHtml(f.url)}" style="color:${COLORS.muted};text-decoration:underline">${escapeHtml(f.label)}</a></p>`,
    ),
    `<p style="margin:0">${CANONICAL_SENTENCE}</p>`,
  ];
  rows.push(
    `<tr><td ${pad} style="padding-top:28px;padding-bottom:28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:2px solid ${COLORS.ink};padding-top:16px;font-family:${FONTS.body};font-size:13px;line-height:1.6;color:${COLORS.muted}">${footerLines.join("")}</td></tr></table></td></tr>`,
  );

  return (
    `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" lang="en">\n<head>\n` +
    `<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>${escapeHtml(l.heading)}</title>\n` +
    `<style type="text/css">\n` +
    `body{margin:0;padding:0;background-color:${COLORS.page}}\n` +
    `@media only screen and (max-width:600px){.th-pad{padding-left:20px !important;padding-right:20px !important}.th-h1{font-size:34px !important}}\n` +
    `</style>\n</head>\n` +
    `<body style="margin:0;padding:0;background-color:${COLORS.page}">\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="background-color:${COLORS.page}"><tr><td align="center" style="padding:24px 0">\n` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">\n${rows.join("\n")}\n</table>\n` +
    `</td></tr></table>\n</body>\n</html>\n`
  );
}

/** `account.email_verification.v1` — sent at signup and on resend while the
 * address is unverified. `verifyUrl` is server-built (token is the only
 * secret in it); `ttlHours` matches EMAIL_VERIFICATION_TTL_S. */
export function renderEmailVerification(params: {
  verifyUrl: string;
  ttlHours: number;
}): RenderedEmail {
  const { verifyUrl, ttlHours } = params;
  const subject = "Verify your email — Thingery";
  const text =
    `Welcome to Thingery!\n\n` +
    `Confirm your email address to make sure marketplace notifications reach you:\n\n` +
    `${verifyUrl}\n\n` +
    `This link expires in ${ttlHours} hours and can be used once. If you did not create a ` +
    `Thingery account, you can ignore this email.\n\n` +
    `— ${CANONICAL_SENTENCE}\n`;
  const html = layoutHtml({
    tag: "One step left",
    tone: "normal",
    heading: "Confirm your email.",
    paragraph:
      "Welcome to Thingery! Confirm your email address to make sure marketplace notifications reach you.",
    origin: safeOrigin(verifyUrl),
    button: { label: "Verify your email", url: verifyUrl },
    linkFallback: {
      lead: "Button not working? Paste this link into your browser:",
      url: verifyUrl,
      note: `The link expires in ${ttlHours} hours and works once. If you didn't create an account, ignore this email.`,
    },
  });
  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Phase 1 order emails (THI-760 plan §1/§6, THI-763 PR 2). One pure function
// per `{role}.{event}.v1` key — the notifications.event_type carries the key
// without the `.v1`, so template = `${event_type}.v1` (outbox column).
// F6 everywhere: params and bodies carry item title, amount, status and deep
// links ONLY — never shipping addresses or counterparty contact data. Every
// email links /order/:id (primary) and /browse (footer); item-linked events
// also link /item/:id. English-only (plan §6 — `locale` reserved).

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", CHF: "Fr " };

/** Deterministic money formatting — no Intl/ICU so snapshots are stable. */
export function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol ? `${symbol}${amount}` : `${currency.toUpperCase()} ${amount}`;
}

// ---------------------------------------------------------------------------
// THI-1585 PR (a): plain-English text fixes. Raw internal values — reason
// codes, dispute outcomes, order statuses, ISO deadlines — must never reach
// an inbox: each renders through the maps below in plain English, and an
// unknown code falls back to neutral copy, never the raw code. The maps
// cover exactly what the fan-out emits (src/notify/fanout.ts) plus the 12
// statuses CHECK-constrained in db/schema.sql. Moderator reasons are free
// text and stay untouched (seller.item_taken_down, buyer.review_hidden).
// Formatting is deterministic — no Intl/ICU (same standard as formatMoney);
// deadlines render in UTC with an explicit suffix so snapshots never drift.

/** The 12 order statuses of db/schema.sql → user-facing English. */
const ORDER_STATUS_TEXT: Record<string, string> = {
  pending: "Awaiting payment",
  sold: "Paid — awaiting shipment",
  label_issued: "Label issued — awaiting carrier pickup",
  in_transit: "In transit",
  delivered: "Delivered — dispute window open",
  disputed: "Under dispute review",
  refunding: "Refund in progress",
  refunded: "Refunded",
  payout_pending: "Seller payout scheduled",
  paid_out: "Seller paid",
  cancelled: "Cancelled",
  completed: "Completed",
};

/** Fan-out cancel/refund reason codes → user-facing English. */
const ORDER_REASON_TEXT: Record<string, string> = {
  payment_deadline_passed: "The payment deadline passed",
  you_cancelled: "You cancelled the order",
  buyer_cancelled: "The buyer cancelled the order",
  seller_cancelled: "The seller cancelled the order",
  dispute_refund: "The dispute was resolved with a refund",
  buyer_requested_refund: "The buyer requested a refund",
  you_requested_refund: "You requested a refund",
  seller_initiated_refund: "The seller initiated a refund",
  not_shipped_or_transit_issue:
    "The item was not shipped in time, or the shipment stalled in transit",
  dispute_released: "The dispute was resolved with the funds released to the seller",
};

/** Fan-out dispute outcome codes → user-facing English. */
const DISPUTE_OUTCOME_TEXT: Record<string, string> = {
  cancelled: "Refund to the buyer — order cancelled",
  refunded: "Refund to the buyer",
  released_to_seller: "Funds released to the seller",
};

export function orderStatusText(status: string): string {
  return ORDER_STATUS_TEXT[status] ?? "In progress";
}

export function orderReasonText(reason: string): string {
  return ORDER_REASON_TEXT[reason] ?? "Not specified";
}

export function disputeOutcomeText(outcome: string): string {
  return DISPUTE_OUTCOME_TEXT[outcome] ?? "Resolved";
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Deadline formatting: fixed UTC calendar format with an explicit time-zone
 *  suffix, no Intl/ICU (same determinism standard as formatMoney). Returns
 *  "" for an unparseable value so callers fall back to date-free copy — a
 *  raw timestamp never reaches the body. */
export function formatDeadlineUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** Shared facts every order email states (plan §6: title, amount, status). */
interface OrderFacts {
  itemTitle: string;
  amountCents: number;
  currency: string;
  orderStatus: string;
  orderUrl: string;
  itemUrl?: string;
}

/** Subject-line hardening: subjects are plain text rendered by mail clients
 * with unknown strictness — strip angle brackets (no HTML) and CR/LF (no
 * header-injection surface, belt-and-braces even with a JSON API provider).
 * Exported for outbox-subject builders that embed DB strings (THI-780 PR 3). */
export function subjectSafe(s: string): string {
  return s.replaceAll("<", "").replaceAll(">", "").replaceAll("\r", " ").replaceAll("\n", " ");
}

function orderEmail(o: {
  subject: string;
  /** Text-version opener (unchanged by the layout work). */
  intro: string;
  /** Approved-layout parts (THI-1586): status tag + heading + one paragraph. */
  layout: { tag: string; tone: TagTone; heading: string; paragraph: string };
  facts: OrderFacts;
  /** Extra context rows after the facts (carrier, tracking, reason, outcome). */
  details?: Array<[string, string]>;
  /** Closing note (text version; the layout paragraph carries the same info). */
  outro?: string;
}): RenderedEmail {
  const { intro, facts, details = [], outro } = o;
  const subject = subjectSafe(o.subject);
  // Browse link derives from the (always absolute, server-built) order URL's
  // origin — templates receive trusted input and stay pure functions.
  const origin = new URL(facts.orderUrl).origin;
  const browseUrl = `${origin}/browse`;
  const lines = [
    `Item: ${facts.itemTitle}`,
    `Amount: ${formatMoney(facts.amountCents, facts.currency)}`,
    `Order status: ${orderStatusText(facts.orderStatus)}`,
    ...details.map(([label, value]) => `${label}: ${value}`),
  ];
  const linkLines = [facts.orderUrl, ...(facts.itemUrl ? [facts.itemUrl] : []), browseUrl];
  const text =
    `${intro}\n\n` +
    lines.join("\n") +
    `\n\n${linkLines.join("\n")}\n` +
    (outro ? `\n${outro}\n` : "\n") +
    `\n— ${CANONICAL_SENTENCE}\n`;
  const html = layoutHtml({
    ...o.layout,
    origin,
    panelTitle: facts.itemTitle,
    panelAmount: formatMoney(facts.amountCents, facts.currency),
    panelRows: [
      { label: "Order status", value: orderStatusText(facts.orderStatus) },
      ...details.map(([label, value]) => ({ label, value })),
    ],
    button: { label: "Open the order", url: facts.orderUrl },
    secondary: [
      ...(facts.itemUrl ? [{ label: "View the item", url: facts.itemUrl }] : []),
      { label: "Browse", url: browseUrl },
    ],
  });
  return { subject, text, html };
}

export const ORDER_EMAIL_KEYS = [
  "buyer.order_placed",
  "buyer.payment_deadline_reminder",
  "buyer.order_cancelled",
  "buyer.payment_received",
  "buyer.item_shipped",
  "buyer.order_delivered",
  "buyer.refund_initiated",
  "buyer.refund_confirmed",
  "buyer.dispute_outcome",
  "seller.off_platform_order",
  "seller.item_sold",
  "seller.order_cancelled_by_buyer",
  "seller.dispute_opened",
  "seller.chargeback",
  "seller.dispute_resolved",
  "seller.payout_paid",
] as const;
export type OrderEmailEvent = (typeof ORDER_EMAIL_KEYS)[number];
/** Template column value for an event type: `{role}.{event}.v1` (plan §6). */
export function templateKeyFor(eventType: OrderEmailEvent | string): string {
  return `${eventType}.v1`;
}

/** Payment-deadline outro: a readable UTC deadline when the payload carries
 *  one; date-free copy when it is missing/unparseable. A raw ISO timestamp
 *  never reaches the body. (THI-1585) */
function paymentOutro(paymentDeadline?: string): string | undefined {
  if (paymentDeadline === undefined) return undefined;
  const fmt = paymentDeadline ? formatDeadlineUtc(paymentDeadline) : "";
  return fmt
    ? `Complete payment by ${fmt} or the order is cancelled automatically.`
    : "Complete payment before the deadline or the order is cancelled automatically.";
}

export function renderBuyerOrderPlaced(p: OrderFacts & { paymentDeadline?: string }): RenderedEmail {
  const deadline = paymentOutro(p.paymentDeadline);
  return orderEmail({
    subject: `Order placed: ${p.itemTitle} — Thingery`,
    intro: "You placed an order on Thingery. Here are the details:",
    layout: {
      tag: "Order placed",
      tone: "normal",
      heading: "Your order is placed.",
      paragraph: deadline ? `Here are the details of your order. ${deadline}` : "Here are the details of your order.",
    },
    facts: p,
    outro: paymentOutro(p.paymentDeadline),
  });
}

export function renderBuyerPaymentDeadlineReminder(p: OrderFacts & { paymentDeadline: string }): RenderedEmail {
  return orderEmail({
    subject: `Payment deadline soon: ${p.itemTitle} — Thingery`,
    intro: "Your order is still awaiting payment. The deadline is approaching:",
    layout: {
      tag: "Payment due",
      tone: "normal",
      heading: "Your order awaits payment.",
      paragraph: paymentOutro(p.paymentDeadline) ?? "Your order is still awaiting payment.",
    },
    facts: p,
    outro: paymentOutro(p.paymentDeadline),
  });
}

export function renderBuyerOrderCancelled(p: OrderFacts & { reason: string }): RenderedEmail {
  // Refund follow-up decided on the RAW reason code (the fan-out contract),
  // never on the translated display text. (THI-1585)
  const refundFollows = p.reason.toLowerCase().includes("refund");
  return orderEmail({
    subject: `Order cancelled: ${p.itemTitle} — Thingery`,
    intro: "An order you are part of has been cancelled:",
    layout: {
      tag: "Cancelled",
      tone: "problem",
      heading: "This order was cancelled.",
      paragraph:
        orderReasonText(p.reason) +
        (refundFollows ? " A refund to your original payment method will follow; no action is needed." : ""),
    },
    facts: p,
    details: [["Reason", orderReasonText(p.reason)]],
    outro: refundFollows
      ? "A refund to your original payment method will follow; no action is needed."
      : undefined,
  });
}

export function renderBuyerPaymentReceived(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Payment received: ${p.itemTitle} — Thingery`,
    intro: "Your payment was received. The seller has been notified and will ship the item:",
    layout: {
      tag: "Paid",
      tone: "normal",
      heading: "Payment received.",
      paragraph: "The seller has been notified and will ship your item.",
    },
    facts: p,
  });
}

export function renderBuyerItemShipped(p: OrderFacts & { carrier?: string; trackingCode?: string }): RenderedEmail {
  // The shipped paragraph mentions the tracking code only when there is one
  // (approved shipped design, THI-1584).
  const tracking = p.trackingCode
    ? `Tracking code ${p.trackingCode}${p.carrier ? ` via ${p.carrier}` : ""}. `
    : "";
  return orderEmail({
    subject: `Your item shipped: ${p.itemTitle} — Thingery`,
    intro: "The seller shipped your order:",
    layout: {
      tag: "On its way",
      tone: "normal",
      heading: "Your order shipped.",
      paragraph: `${tracking}You can follow the shipment on the order page.`,
    },
    facts: p,
    details: [
      ...(p.carrier ? ([["Carrier", p.carrier]] as Array<[string, string]>): []),
      ...(p.trackingCode ? ([["Tracking code", p.trackingCode]] as Array<[string, string]>): []),
    ],
  });
}

export function renderBuyerOrderDelivered(p: OrderFacts & { disputeWindowHours: number }): RenderedEmail {
  const disputeNote =
    `If something is wrong, open a dispute within ${p.disputeWindowHours} hours of delivery ` +
    `from the order page — after that the sale is final.`;
  return orderEmail({
    subject: `Delivered: ${p.itemTitle} — Thingery`,
    intro: "Your order was marked delivered:",
    layout: {
      tag: "Delivered",
      tone: "normal",
      heading: "Your order was delivered.",
      paragraph: disputeNote,
    },
    facts: p,
    outro: disputeNote,
  });
}

export function renderBuyerRefundInitiated(p: OrderFacts & { reason: string }): RenderedEmail {
  return orderEmail({
    subject: `Refund initiated: ${p.itemTitle} — Thingery`,
    intro: "A refund has been initiated for your order:",
    layout: {
      tag: "Refund in progress",
      tone: "info",
      heading: "A refund is on its way.",
      paragraph: "The refund is processing; no action is needed.",
    },
    facts: p,
    details: [["Reason", orderReasonText(p.reason)]],
    outro: "The refund is processing; no action is needed.",
  });
}

export function renderBuyerRefundConfirmed(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Refund completed: ${p.itemTitle} — Thingery`,
    intro: "Your refund has completed. The amount returns to your original payment method:",
    layout: {
      tag: "Refunded",
      tone: "info",
      heading: "Your refund is complete.",
      paragraph: "The amount returns to your original payment method.",
    },
    facts: p,
  });
}

export function renderBuyerDisputeOutcome(p: OrderFacts & { outcome: string }): RenderedEmail {
  return orderEmail({
    subject: `Dispute resolved: ${p.itemTitle} — Thingery`,
    intro: "Your dispute has been resolved:",
    layout: {
      tag: "Dispute resolved",
      tone: "info",
      heading: "Your dispute has been resolved.",
      paragraph: "The order page shows the final state of the order.",
    },
    facts: p,
    details: [["Outcome", disputeOutcomeText(p.outcome)]],
    outro: "The order page shows the final state of the order.",
  });
}

export function renderSellerOffPlatformOrder(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `New order awaiting confirmation: ${p.itemTitle} — Thingery`,
    intro: "A buyer placed an off-platform order for your item and it awaits your confirmation:",
    layout: {
      tag: "New order",
      tone: "normal",
      heading: "A buyer placed an order.",
      paragraph: "An off-platform order for your item awaits your confirmation.",
    },
    facts: p,
  });
}

export function renderSellerItemSold(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Sold: ${p.itemTitle} — Thingery`,
    intro: "Your item sold. Payment was received — time to ship:",
    layout: {
      tag: "Sold",
      tone: "normal",
      heading: "Your item sold.",
      paragraph:
        "Payment was received — time to ship. Record tracking on the order page so the buyer can follow the shipment.",
    },
    facts: p,
    outro: "Record tracking on the order page so the buyer can follow the shipment.",
  });
}

export function renderSellerOrderCancelledByBuyer(p: OrderFacts & { reason: string }): RenderedEmail {
  // Refund follow-up decided on the RAW reason code, never the translated
  // display text. (THI-1585)
  const refundFollows = p.reason.toLowerCase().includes("refund");
  return orderEmail({
    subject: `Order cancelled by buyer: ${p.itemTitle} — Thingery`,
    intro: "A buyer cancelled an order for your item:",
    layout: {
      tag: "Cancelled",
      tone: "problem",
      heading: "This order was cancelled.",
      paragraph:
        orderReasonText(p.reason) +
        (refundFollows ? " A refund to the buyer will follow automatically; no action is needed." : ""),
    },
    facts: p,
    details: [["Reason", orderReasonText(p.reason)]],
    outro: refundFollows
      ? "A refund to the buyer will follow automatically; no action is needed."
      : undefined,
  });
}

export function renderSellerDisputeOpened(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Dispute opened: ${p.itemTitle} — Thingery`,
    intro: "The buyer opened a dispute on this order:",
    layout: {
      tag: "Dispute opened",
      tone: "problem",
      heading: "A dispute was opened.",
      paragraph: "Open the order page to review the case. Disputes are resolved by Thingery admins.",
    },
    facts: p,
    outro: "Open the order page to review the case. Disputes are resolved by Thingery admins.",
  });
}

export function renderSellerChargeback(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Chargeback filed: ${p.itemTitle} — Thingery`,
    intro: "A chargeback was filed on this order:",
    layout: {
      tag: "Chargeback",
      tone: "problem",
      heading: "A chargeback was filed.",
      paragraph:
        "Thingery will represent the case with the recorded evidence. No action is needed unless we contact you.",
    },
    facts: p,
    outro: "Thingery will represent the case with the recorded evidence. No action is needed unless we contact you.",
  });
}

export function renderSellerDisputeResolved(p: OrderFacts & { outcome: string }): RenderedEmail {
  return orderEmail({
    subject: `Dispute resolved: ${p.itemTitle} — Thingery`,
    intro: "The dispute on this order has been resolved:",
    layout: {
      tag: "Dispute resolved",
      tone: "info",
      heading: "The dispute has been resolved.",
      paragraph: "The order page shows the final state of the order.",
    },
    facts: p,
    details: [["Outcome", disputeOutcomeText(p.outcome)]],
  });
}

export function renderSellerPayoutPaid(p: OrderFacts): RenderedEmail {
  return orderEmail({
    subject: `Payout sent: ${p.itemTitle} — Thingery`,
    intro: "Your payout for this sale was sent to your connected account:",
    layout: {
      tag: "Payout sent",
      tone: "normal",
      heading: "Your payout was sent.",
      paragraph: "The payout for this sale was sent to your connected account.",
    },
    facts: p,
  });
}

// THI-780 PR 3: item/account-level events (plan §6). All orders-class
// (prefs-gated transactional), PII-free bodies.

/** `seller.payouts_enabled.v1` — account.updated flipped transfers on.
 *  `baseUrl` (from the deployment base URL) adds the logo + CTA; without it
 *  the layout degrades to header + copy (no absolute link can be built). */
export function renderSellerPayoutsEnabled(baseUrl?: string): RenderedEmail {
  const subject = "Payouts enabled — Thingery";
  const text =
    "Your payout account is set up. Money from your sales can now reach you automatically.\n\n" +
    `— ${CANONICAL_SENTENCE}\n`;
  const html = layoutHtml({
    tag: "Payouts ready",
    tone: "normal",
    heading: "Payouts are set up.",
    paragraph: "Money from your sales can now reach you automatically.",
    origin: baseUrl ?? "",
    button: baseUrl ? { label: "Open Thingery", url: baseUrl } : undefined,
  });
  return { subject, text, html };
}

/** `seller.stale_sale_warning.v1` / `seller.stuck_transit_warning.v1` — the
 * sweep's early warning before the hard deadline cancels/refunds. */
export function renderSellerDeadlineWarning(p: OrderFacts & { kind: "stale_sale" | "stuck_transit" }): RenderedEmail {
  const intro =
    p.kind === "stale_sale"
      ? "You sold this item but no shipping has been recorded. If nothing is shipped in time, the order is cancelled and the buyer refunded automatically."
      : "This shipment has not moved for a while. If no carrier event arrives in time, the order is refunded to the buyer automatically.";
  return orderEmail({
    subject:
      p.kind === "stale_sale"
        ? `Action needed: ship your sale — ${p.itemTitle} — Thingery`
        : `Shipping stalled: ${p.itemTitle} — Thingery`,
    intro,
    layout: {
      tag: "Action needed",
      tone: "problem",
      heading: p.kind === "stale_sale" ? "Ship your sale." : "Your shipment has stalled.",
      paragraph: intro,
    },
    facts: p,
  });
}

/** `seller.item_taken_down.v1` — moderation removed a listing. */
export function renderSellerItemTakenDown(p: { itemTitle: string; itemUrl: string; reason: string }): RenderedEmail {
  const subject = subjectSafe(`Listing removed: ${p.itemTitle} — Thingery`);
  const text =
    "A moderator removed your listing from Thingery:\n\n" +
    `Item: ${p.itemTitle}\nReason: ${p.reason}\n` +
    `\n${p.itemUrl}\n\n` +
    `If you believe this was a mistake, contact the marketplace operators.\n\n` +
    `— ${CANONICAL_SENTENCE}\n`;
  const html = layoutHtml({
    tag: "Listing removed",
    tone: "problem",
    heading: "Your listing was removed.",
    paragraph:
      "A moderator removed your listing from Thingery. If you believe this was a mistake, contact the marketplace operators.",
    origin: safeOrigin(p.itemUrl),
    panelTitle: p.itemTitle,
    panelRows: [{ label: "Reason", value: p.reason }],
    button: { label: "View the item", url: p.itemUrl },
  });
  return { subject, text, html };
}

/** `buyer.review_hidden.v1` — moderation hid a review the buyer wrote
 *  (order-reviews spec PR 3). */
export function renderBuyerReviewHidden(p: { itemTitle: string; sellerUrl: string; reason: string }): RenderedEmail {
  const subject = subjectSafe(`Review removed: ${p.itemTitle} — Thingery`);
  const text =
    "A moderator removed your review from Thingery:\n\n" +
    `Item: ${p.itemTitle}\nReason: ${p.reason}\n` +
    `\n${p.sellerUrl}\n\n` +
    `If you believe this was a mistake, contact the marketplace operators.\n\n` +
    `— ${CANONICAL_SENTENCE}\n`;
  const html = layoutHtml({
    tag: "Review removed",
    tone: "problem",
    heading: "Your review was removed.",
    paragraph:
      "A moderator removed your review from Thingery. If you believe this was a mistake, contact the marketplace operators.",
    origin: safeOrigin(p.sellerUrl),
    panelTitle: p.itemTitle,
    panelRows: [{ label: "Reason", value: p.reason }],
    button: { label: "View the seller page", url: p.sellerUrl },
  });
  return { subject, text, html };
}

/** `operator.*.v1` — internal alerts (THI-780 PR 4). Plain, id-first,
 * PII-free: ids, statuses, error strings only. */
export function renderOperatorAlert(p: { title: string; lines: string[] }): RenderedEmail {
  const subject = subjectSafe(p.title);
  const text = p.lines.join("\n") + `\n\n— ${CANONICAL_SENTENCE}\n`;
  const html =
    `<p>${escapeHtml(p.title)}</p>\n<ul>\n${p.lines.map((l) => `  <li>${escapeHtml(l)}</li>`).join("\n")}\n</ul>\n` +
    `<p style="color:#666;font-size:12px">— ${CANONICAL_SENTENCE}</p>\n`;
  return { subject, text, html };
}

/** Registry: a notification payload (the PII-free JSONB the fan-out stores)
 *  → the rendered email for its event type, with deep links built from the
 *  deployment base URL. One source of truth for content: fan-out stores the
 *  subject snapshot, the delivery sweep renders subject+body identically.
 *  Unknown keys throw — the fan-out only emits ORDER_EMAIL_KEYS events, so an
 *  unknown key is a programming error to surface, not silently mail. */
export function renderOrderEmail(
  eventType: string,
  payload: Record<string, unknown>,
  baseUrl: string,
): RenderedEmail {
  const str = (k: string): string | undefined => (typeof payload[k] === "string" ? (payload[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof payload[k] === "number" ? (payload[k] as number) : undefined);
  // THI-780 PR 2: digest rows carry their own payload shape (items list),
  // not order facts.
  if (eventType === "digest.daily" || eventType === "digest.weekly") {
    return renderDigest({
      frequency: eventType === "digest.daily" ? "daily" : "weekly",
      count: num("count") ?? 0,
      items: Array.isArray(payload.items)
        ? (payload.items as Array<Record<string, unknown>>).map((it) => ({
            eventType: typeof it.event_type === "string" ? it.event_type : "",
            itemTitle: typeof it.item_title === "string" ? it.item_title : undefined,
            url: typeof it.url === "string" ? it.url : undefined,
          }))
        : [],
      unsubscribeUrl: str("unsubscribe_url") ?? baseUrl,
    });
  }
  const facts: OrderFacts = {
    itemTitle: str("item_title") ?? "",
    amountCents: num("amount_cents") ?? 0,
    currency: str("currency") ?? "EUR",
    orderStatus: str("order_status") ?? "",
    orderUrl: str("order_id") ? `${baseUrl}/order/${payload.order_id}` : baseUrl,
    itemUrl: str("item_id") ? `${baseUrl}/item/${payload.item_id}` : undefined,
  };
  switch (eventType) {
    case "buyer.order_placed":
      return renderBuyerOrderPlaced({ ...facts, paymentDeadline: str("payment_deadline") });
    case "buyer.payment_deadline_reminder":
      return renderBuyerPaymentDeadlineReminder({ ...facts, paymentDeadline: str("payment_deadline") ?? "" });
    case "buyer.order_cancelled":
      return renderBuyerOrderCancelled({ ...facts, reason: str("reason") ?? "" });
    case "buyer.payment_received":
      return renderBuyerPaymentReceived(facts);
    case "buyer.item_shipped":
      return renderBuyerItemShipped({ ...facts, carrier: str("carrier"), trackingCode: str("tracking_code") });
    case "buyer.order_delivered":
      return renderBuyerOrderDelivered({ ...facts, disputeWindowHours: num("dispute_window_hours") ?? 48 });
    case "buyer.refund_initiated":
      return renderBuyerRefundInitiated({ ...facts, reason: str("reason") ?? "" });
    case "buyer.refund_confirmed":
      return renderBuyerRefundConfirmed(facts);
    case "buyer.dispute_outcome":
      return renderBuyerDisputeOutcome({ ...facts, outcome: str("outcome") ?? "" });
    case "seller.off_platform_order":
      return renderSellerOffPlatformOrder(facts);
    case "seller.item_sold":
      return renderSellerItemSold(facts);
    case "seller.order_cancelled_by_buyer":
      return renderSellerOrderCancelledByBuyer({ ...facts, reason: str("reason") ?? "" });
    case "seller.dispute_opened":
      return renderSellerDisputeOpened(facts);
    case "seller.chargeback":
      return renderSellerChargeback(facts);
    case "seller.dispute_resolved":
      return renderSellerDisputeResolved({ ...facts, outcome: str("outcome") ?? "" });
    case "seller.payout_paid":
      return renderSellerPayoutPaid(facts);
    // THI-780 PR 3: item/account-level events.
    case "seller.payouts_enabled":
      return renderSellerPayoutsEnabled(baseUrl);
    case "seller.stale_sale_warning":
      return renderSellerDeadlineWarning({ ...facts, kind: "stale_sale" });
    case "seller.stuck_transit_warning":
      return renderSellerDeadlineWarning({ ...facts, kind: "stuck_transit" });
    case "seller.item_taken_down":
      return renderSellerItemTakenDown({
        itemTitle: str("item_title") ?? "",
        itemUrl: str("item_id") ? `${baseUrl}/item/${payload.item_id}` : baseUrl,
        reason: str("reason") ?? "policy violation",
      });
    // Order-reviews spec PR 3: moderation hid one of the buyer's reviews.
    case "buyer.review_hidden":
      return renderBuyerReviewHidden({
        itemTitle: str("item_title") ?? "",
        sellerUrl: str("seller_id") ? `${baseUrl}/seller/${payload.seller_id}` : baseUrl,
        reason: str("reason") ?? "policy violation",
      });
    // THI-780 PR 4: operator alerts — account-less rows, bypass account
    // gates (an operator address is not a marketplace account).
    // THI-1537 adds the bounce-suppression observability pair
    // (suppression_self / suppression_volume — src/webhooks-resend.ts).
    case "operator.stuck_money":
    case "operator.stale_dispute":
    case "operator.dead_letter":
    case "operator.suppression_self":
    case "operator.suppression_volume": {
      const lines = Array.isArray(payload.lines)
        ? (payload.lines as unknown[]).map(String)
        : [];
      return renderOperatorAlert({ title: str("title") ?? "Thingery operator alert", lines });
    }
    // THI-1451 (THI-1479 plan Phase C): item-report mirror to the report
    // alias — account-less row, bypasses account gates for the same reason
    // operator.* does. Same PII-minimal discipline: ids, reason slug,
    // timestamp only; the motivation free-text (UNTRUSTED user content)
    // never enters the payload, so it can never leak into the mail body.
    case "ops.item_reported": {
      const itemId = str("item_id") ?? "";
      return renderOperatorAlert({
        title: "New item report — Thingery",
        lines: [
          `Report: ${str("report_id") ?? "?"}`,
          `Item: ${itemId ? `${baseUrl}/item/${itemId}` : "?"}`, 
          `Reason: ${str("reason") ?? "?"}`,
          `Reported at: ${str("created_at") ?? "?"}`,
        ],
      });
    }
    default:
      throw new Error(`renderOrderEmail: unknown event type ${eventType}`);
  }
}
