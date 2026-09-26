// Outgoing email: provider-neutral interface + env-based factory.
//
//   EMAIL_PROVIDER  smtp (default) | resend
//   SMTP_HOST       default "inbucket" (Supabase local Mailpit, inside the Docker network)
//   SMTP_PORT       default 1025
//   SMTP_USER / SMTP_PASS / SMTP_SECURE (optional)
//   RESEND_API_KEY  required when EMAIL_PROVIDER=resend
//   EMAIL_MODE      capture (default) | live
//                   capture: never reach a real council. Local SMTP (Mailpit) is allowed as-is;
//                   any other transport must set EMAIL_CAPTURE_TO, and every message is
//                   redirected there instead of to the council.
//   EMAIL_CAPTURE_TO test inbox for capture mode on a real provider

export * from "./types.ts";
export { ResendEmailSender } from "./resend.ts";
export { SmtpEmailSender } from "./smtp.ts";

import { ResendEmailSender } from "./resend.ts";
import { SmtpEmailSender } from "./smtp.ts";
import type { EmailSender } from "./types.ts";

export type EnvGetter = (name: string) => string | undefined;

export const DEFAULT_SMTP_HOST = "inbucket";
export const DEFAULT_SMTP_PORT = 1025;

export type EmailMode = "capture" | "live";

export function emailModeFromEnv(env: EnvGetter = (n) => Deno.env.get(n)): EmailMode {
  return (env("EMAIL_MODE") ?? "").trim().toLowerCase() === "live" ? "live" : "capture";
}

const LOCAL_SMTP_HOSTS = new Set(["inbucket", "mailpit", "localhost", "127.0.0.1", "host.docker.internal"]);

/** Sends everything to one test inbox, keeping the intended recipient visible in the subject. */
export class CaptureEmailSender implements EmailSender {
  readonly provider: string;
  constructor(private inner: EmailSender, private captureTo: string) {
    this.provider = `${inner.provider} (capture)`;
  }
  send(msg: Parameters<EmailSender["send"]>[0]) {
    return this.inner.send({
      ...msg,
      to: [this.captureTo],
      subject: `[CAPTURED for ${msg.to.join(", ")}] ${msg.subject}`,
    });
  }
}

export function createEmailSenderFromEnv(env: EnvGetter = (n) => Deno.env.get(n)): EmailSender {
  const sender = createTransport(env);
  if (emailModeFromEnv(env) === "live") return sender;
  const provider = (env("EMAIL_PROVIDER") ?? "smtp").trim().toLowerCase() || "smtp";
  const host = (env("SMTP_HOST") || DEFAULT_SMTP_HOST).toLowerCase();
  if (provider === "smtp" && LOCAL_SMTP_HOSTS.has(host)) return sender; // Mailpit catches everything
  const captureTo = env("EMAIL_CAPTURE_TO");
  if (!captureTo) {
    throw new Error(
      "EMAIL_MODE is capture (the default) but the transport can reach real inboxes: set EMAIL_CAPTURE_TO, or EMAIL_MODE=live to email councils",
    );
  }
  return new CaptureEmailSender(sender, captureTo);
}

function createTransport(env: EnvGetter): EmailSender {
  const provider = (env("EMAIL_PROVIDER") ?? "smtp").trim().toLowerCase() || "smtp";
  switch (provider) {
    case "resend": {
      const apiKey = env("RESEND_API_KEY");
      if (!apiKey) throw new Error("EMAIL_PROVIDER=resend but RESEND_API_KEY is not set");
      return new ResendEmailSender({ apiKey });
    }
    case "smtp": {
      const port = Number(env("SMTP_PORT") ?? DEFAULT_SMTP_PORT);
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`invalid SMTP_PORT '${env("SMTP_PORT")}'`);
      }
      const secureRaw = env("SMTP_SECURE");
      return new SmtpEmailSender({
        host: env("SMTP_HOST") || DEFAULT_SMTP_HOST,
        port,
        secure: secureRaw == null ? undefined : secureRaw === "true" || secureRaw === "1",
        user: env("SMTP_USER") || undefined,
        pass: env("SMTP_PASS") || undefined,
      });
    }
    default:
      throw new Error(`unknown EMAIL_PROVIDER '${provider}' (expected smtp or resend)`);
  }
}
