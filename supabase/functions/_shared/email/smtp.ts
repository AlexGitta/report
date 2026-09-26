// SMTP sender via nodemailer (Node compat; works in Deno and the Supabase edge runtime).
// Local dev: Supabase's mail catcher (Mailpit) listens on port 1025 inside the Docker network
// under the host alias `inbucket`; its web UI is http://localhost:54324.
//
// Note: hosted Supabase Edge Functions block outbound ports 25 and 587, so use the Resend
// provider (or SMTP on 465/2525) in production.

// @deno-types="npm:@types/nodemailer@6"
import nodemailer from "npm:nodemailer@6";
import { type EmailMessage, type EmailSender, EmailSendError, type SendResult } from "./types.ts";

export interface SmtpOptions {
  host: string;
  port: number;
  /** Implicit TLS (port 465). STARTTLS is used automatically when the server offers it. */
  secure?: boolean;
  user?: string;
  pass?: string;
}

/** The part of a nodemailer transport we use (lets tests inject a fake). */
export interface SmtpTransport {
  sendMail(mail: Record<string, unknown>): Promise<{
    messageId?: string;
    accepted?: unknown[];
    rejected?: unknown[];
    response?: string;
  }>;
}

export class SmtpEmailSender implements EmailSender {
  readonly provider = "smtp";
  private transport: SmtpTransport | null;

  constructor(private readonly opts: SmtpOptions, transport?: SmtpTransport) {
    this.transport = transport ?? null;
  }

  private getTransport(): SmtpTransport {
    if (!this.transport) {
      this.transport = nodemailer.createTransport({
        host: this.opts.host,
        port: this.opts.port,
        secure: this.opts.secure ?? this.opts.port === 465,
        auth: this.opts.user ? { user: this.opts.user, pass: this.opts.pass ?? "" } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      }) as unknown as SmtpTransport;
    }
    return this.transport;
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    let info;
    try {
      info = await this.getTransport().sendMail({
        from: msg.from,
        to: msg.to,
        replyTo: msg.replyTo,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: msg.headers,
      });
    } catch (err) {
      const e = err as { message?: string; responseCode?: number };
      // 5xx SMTP replies are permanent; connection errors and 4xx are worth retrying.
      const retryable = !(typeof e.responseCode === "number" && e.responseCode >= 500);
      throw new EmailSendError(this.provider, e.message ?? String(err), retryable, { cause: err });
    }
    if (info.rejected && info.rejected.length > 0) {
      throw new EmailSendError(
        this.provider,
        `recipient rejected: ${info.rejected.map(String).join(", ")} (${info.response ?? ""})`,
        false,
      );
    }
    return { messageId: info.messageId ?? null, provider: this.provider };
  }
}
