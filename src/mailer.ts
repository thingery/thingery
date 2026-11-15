// Transactional email seam (THI-760 plan Phase 0 / THI-762): one thin Mailer
// interface every notification path goes through, so provider choice is a
// one-file change later (plan §3 — provider adapter ships in Phase 1, PR 5).
// Phase 0 ships exactly one implementation: DryRunMailer — used while
// NOTIFY_EMAIL_ENABLED is off (the default) and in every test. It records and
// logs metadata only; message bodies (which carry single-use links) are never
// logged, and no email leaves the process in Phase 0 by construction.

import { envValue, notifyConfig } from "./config.js";
import { ResendMailer } from "./resend.js";

/** One outbound transactional email. `idempotencyKey` is belt-and-braces for
 * providers that honor it (Resend does) — replaying the same key must never
 * double-send. Bodies are PII-free by the plan's F6 rule (ids, titles,
 * amounts, links — never addresses or counterparty contact data). */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export type MailSendResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string };

export interface Mailer {
  readonly kind: "dry_run" | "provider";
  send(message: MailMessage): Promise<MailSendResult>;
}

/** No-op mailer: records sends for inspection/tests and logs one metadata
 * line each (to, subject, idempotency key — never the body, which contains
 * single-use links). Always succeeds; failures are a provider concern and
 * arrive with the Phase 1 adapter + outbox retry machinery (plan §2.2). */
export class DryRunMailer implements Mailer {
  readonly kind = "dry_run" as const;
  readonly sent: MailMessage[] = [];

  constructor(private readonly reason: string) {}

  async send(message: MailMessage): Promise<MailSendResult> {
    this.sent.push({ ...message });
    console.info(
      `mailer(dry-run/${this.reason}): would send to=${message.to} subject=${JSON.stringify(message.subject)} idempotencyKey=${message.idempotencyKey}`,
    );
    return { ok: true };
  }
}

/** Boot-time mailer selection. Fail-closed (config.ts F1 posture): an empty
 *  or malformed NOTIFY_EMAIL_ENABLED counts as unset. Phase 1 (THI-760 plan
 *  §3/§8 PR 4) adds the Resend adapter: enabled + RESEND_API_KEY →
 *  ResendMailer; enabled + key missing → boot error + DryRunMailer, never an
 *  open send path. The delivery sweep (src/notify/delivery.ts) additionally
 *  refuses to claim rows unless enabled — dark deploys leave outbox rows
 *  pending, by design. */
export function buildMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const flag = (env.NOTIFY_EMAIL_ENABLED ?? "").trim();
  const enabled = flag === "1" || flag === "true";
  if (!enabled) return new DryRunMailer("NOTIFY_EMAIL_ENABLED off");
  const cfg = notifyConfig(env);
  if (cfg.resendApiKey === undefined) {
    console.error(
      "mailer: NOTIFY_EMAIL_ENABLED is on but RESEND_API_KEY is unset — " +
        "fail-closed to dry-run; nothing is sent until the key is configured.",
    );
    return new DryRunMailer("enabled without RESEND_API_KEY (fail-closed)");
  }
  return new ResendMailer({ apiKey: cfg.resendApiKey, fromAddress: cfg.fromAddress });
}

const mailer: Mailer = buildMailer();

/** The single send entry point for application code (so tests can mock this
 * module and assert sends without any provider). */
export function sendMail(message: MailMessage): Promise<MailSendResult> {
  return mailer.send(message);
}
