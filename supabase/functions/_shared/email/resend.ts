// Resend HTTP API sender (https://resend.com/docs/api-reference/emails/send-email).

import { type EmailMessage, type EmailSender, EmailSendError, type SendResult } from "./types.ts";

export interface ResendOptions {
  apiKey: string;
  /** Defaults to https://api.resend.com */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ResendEmailSender implements EmailSender {
  readonly provider = "resend";
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: ResendOptions) {
    if (!opts.apiKey) throw new Error("RESEND_API_KEY is required for the resend provider");
    this.fetchFn = opts.fetch ?? fetch;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    const body: Record<string, unknown> = {
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
    };
    if (msg.html) body.html = msg.html;
    if (msg.replyTo) body.reply_to = msg.replyTo;
    if (msg.headers && Object.keys(msg.headers).length > 0) body.headers = msg.headers;

    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.baseUrl ?? "https://api.resend.com"}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new EmailSendError(this.provider, `request failed: ${errMsg(err)}`, true, {
        cause: err,
      });
    }

    const raw = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch { /* non-JSON error body */ }

    if (!res.ok) {
      const detail = typeof data.message === "string" ? data.message : raw.slice(0, 300);
      const retryable = res.status === 429 || res.status >= 500;
      throw new EmailSendError(this.provider, `HTTP ${res.status}: ${detail}`, retryable);
    }
    return { messageId: typeof data.id === "string" ? data.id : null, provider: this.provider };
  }
}

function errMsg(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err);
}
