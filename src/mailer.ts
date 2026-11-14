// Transactional email seam (THI-760 plan Phase 0 / THI-762): one thin Mailer
// interface every notification path goes through, so provider choice is a
// one-file change later (plan §3 — provider adapter ships in Phase 1, PR 5).
// Phase 0 ships exactly one implementation: DryRunMailer — used while
// NOTIFY_EMAIL_ENABLED is off (the default) and in every test. It records and
// logs metadata only; message bodies (which carry single-use links) are never
// logged, and no email leaves the process in Phase 0 by construction.

import { envValue } from "./config.js";

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
 * or malformed NOTIFY_EMAIL_ENABLED counts as unset, and — decisive for
 * Phase 0 — no provider adapter exists yet, so EVERY configuration resolves
 * to DryRunMailer. Enabling the flag today produces a boot error line, not a
 * send path; the Resend adapter + outbox replace this in Phase 1 (plan §8
 * PR 5). This is what makes the Phase 0 deploy dark: no code path can emit
 * email, regardless of env. */
export function buildMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const flag = (env.NOTIFY_EMAIL_ENABLED ?? "").trim();
  const enabled = flag === "1" || flag === "true";
  if (!enabled) return new DryRunMailer("NOTIFY_EMAIL_ENABLED off");
  console.error(
    "mailer: NOTIFY_EMAIL_ENABLED is set, but the provider adapter ships in Phase 1 " +
      "(THI-760 plan §8 PR 5) — email stays in dry-run; nothing is sent.",
  );
  return new DryRunMailer("no provider adapter until Phase 1");
}

const mailer: Mailer = buildMailer();

/** The single send entry point for application code (so tests can mock this
 * module and assert sends without any provider). */
export function sendMail(message: MailMessage): Promise<MailSendResult> {
  return mailer.send(message);
}
