// Resend provider adapter (THI-760 plan Phase 1 / THI-763 PR 4; plan §3).
// The ONLY Mailer implementation that can leave the process: shaped exactly
// like the EasyPost client (explicit options + fetchImpl test seam, no global
// state). Sends go through it only when NOTIFY_EMAIL_ENABLED is on AND
// RESEND_API_KEY is set — buildMailer (src/mailer.ts) enforces that gate
// fail-closed, so this adapter is unreachable in a dark deploy by
// construction.
//
// Idempotency: the Idempotency-Key header is stable per outbox row
// (`outbox-{id}`), so a retry after a network timeout cannot double-send at
// the provider even if the first request landed (webhook-idempotency lens —
// applies to our own sweeps too).

import type { MailMessage, MailSendResult, Mailer } from "./mailer.js";
import { envValue, notifyConfig } from "./config.js";

export interface ResendOptions {
  apiKey?: string; // default: RESEND_API_KEY (empty = unset, F1)
  baseUrl?: string; // default: https://api.resend.com (tests override)
  fromAddress?: string; // default: notifyConfig().fromAddress (NOTIFY_FROM_ADDRESS)
  fetchImpl?: typeof fetch; // test seam
}

interface ResendSendResponse {
  id?: string;
}

export class ResendMailer implements Mailer {
  readonly kind = "provider" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ResendOptions = {}) {
    const key = opts.apiKey ?? envValue("RESEND_API_KEY");
    if (key === undefined) {
      // Never construct via buildMailer without a key; a direct construction
      // with no key is a programming error — fail loud, not open.
      throw new Error("ResendMailer: RESEND_API_KEY is not set");
    }
    this.apiKey = key;
    this.baseUrl = opts.baseUrl ?? "https://api.resend.com";
    // Plan §3 adopted decision #4: fixed no-reply sender, no Reply-To.
    this.from = opts.fromAddress ?? notifyConfig().fromAddress;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
      if (!res.ok) {
        // 4xx = permanent (bad request/unverified sender) — surfaced as an
        // error; the delivery sweep's backoff will dead-letter it.
        return { ok: false, error: `resend: HTTP ${res.status}` };
      }
      const body = (await res.json()) as ResendSendResponse;
      if (!body?.id) return { ok: false, error: "resend: no message id in response" };
      return { ok: true, providerMessageId: body.id };
    } catch (err) {
      return { ok: false, error: `resend: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

}
