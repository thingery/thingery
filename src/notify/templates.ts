// Email templates (THI-760 plan §6): pure TypeScript functions — subject +
// text + minimal HTML, no framework (YAGNI), English-only in Phase 1 with the
// `locale` field reserved for later phases. Keys follow the plan's
// `{role}.{event}.v1` convention (account-level mail uses the `account`
// role namespace): renaming content later means issuing a new key, never
// mutating meaning — the API-evolution rule applied to humans' inboxes.
//
// F6 applies to every template: PII-free bodies. The verification email
// carries the verify link only — no order data, no addresses, no counterparty
// information — and the canonical sentence footer.

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
  const html =
    `<p>Welcome to Thingery!</p>\n` +
    `<p>Confirm your email address to make sure marketplace notifications reach you:</p>\n` +
    `<p><a href="${escapeHtml(verifyUrl)}">Verify your email</a> ` +
    `(<code>${escapeHtml(verifyUrl)}</code>)</p>\n` +
    `<p>This link expires in ${ttlHours} hours and can be used once. If you did not create a ` +
    `Thingery account, you can ignore this email.</p>\n` +
    `<p style="color:#666;font-size:12px">— ${CANONICAL_SENTENCE}</p>\n`;
  return { subject, text, html };
}
