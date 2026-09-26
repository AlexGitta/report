// Provider-neutral outgoing email types. Senders live in smtp.ts (local Mailpit / any SMTP)
// and resend.ts (Resend HTTP API); pick one with createEmailSenderFromEnv() in mod.ts.

export interface EmailMessage {
  /** RFC 5322 mailbox, e.g. `Local Problem Reporter <no-reply@example.org>`. */
  from: string;
  to: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  /** Extra headers, e.g. `X-Report-Ref`. */
  headers?: Record<string, string>;
}

export interface SendResult {
  /** Provider message id (SMTP Message-ID or Resend email id). */
  messageId: string | null;
  provider: string;
}

export interface EmailSender {
  readonly provider: string;
  send(msg: EmailMessage): Promise<SendResult>;
}

export class EmailSendError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    /** True for errors worth retrying later (network, 5xx, 429). */
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(`${provider}: ${message}`, options);
    this.name = "EmailSendError";
  }
}
