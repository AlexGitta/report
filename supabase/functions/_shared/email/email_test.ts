import { assertEquals, assertInstanceOf, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  CaptureEmailSender,
  createEmailSenderFromEnv,
  EmailSendError,
  ResendEmailSender,
  SmtpEmailSender,
} from "./mod.ts";
import type { EmailMessage } from "./types.ts";
import type { SmtpTransport } from "./smtp.ts";

const MSG: EmailMessage = {
  from: "App <no-reply@reports.localhost>",
  to: ["council@example.test"],
  replyTo: "reply+RPT-ABC123@reports.localhost",
  subject: "[RPT-ABC123] Pothole",
  text: "hello",
  html: "<p>hello</p>",
  headers: { "X-Report-Ref": "RPT-ABC123" },
};

const env = (vals: Record<string, string>) => (n: string) => vals[n];

Deno.test("factory: smtp by default with local Mailpit defaults", () => {
  const s = createEmailSenderFromEnv(env({}));
  assertInstanceOf(s, SmtpEmailSender);
  assertEquals(s.provider, "smtp");
});

Deno.test("factory: resend needs RESEND_API_KEY; unknown provider throws", () => {
  assertThrows(() => createEmailSenderFromEnv(env({ EMAIL_PROVIDER: "resend" })));
  assertInstanceOf(
    createEmailSenderFromEnv(env({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_x", EMAIL_MODE: "live" })),
    ResendEmailSender,
  );
  assertThrows(() => createEmailSenderFromEnv(env({ EMAIL_PROVIDER: "carrier-pigeon" })));
  assertThrows(() => createEmailSenderFromEnv(env({ SMTP_PORT: "abc" })));
});

Deno.test("resend: posts the message and returns the id", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchFn = ((url: string, init: RequestInit) => {
    seen = { url, init };
    return Promise.resolve(new Response(JSON.stringify({ id: "re_123" }), { status: 200 }));
  }) as unknown as typeof fetch;
  const s = new ResendEmailSender({ apiKey: "re_key", fetch: fetchFn });
  const res = await s.send(MSG);
  assertEquals(res, { messageId: "re_123", provider: "resend" });
  assertEquals(seen!.url, "https://api.resend.com/emails");
  assertEquals((seen!.init.headers as Record<string, string>).authorization, "Bearer re_key");
  const body = JSON.parse(String(seen!.init.body));
  assertEquals(body.to, ["council@example.test"]);
  assertEquals(body.reply_to, "reply+RPT-ABC123@reports.localhost");
  assertEquals(body.headers, { "X-Report-Ref": "RPT-ABC123" });
});

Deno.test("resend: HTTP errors become EmailSendError (retryable on 429/5xx)", async () => {
  const mk = (status: number) =>
    new ResendEmailSender({
      apiKey: "k",
      fetch: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "nope" }), { status }),
        )) as unknown as typeof fetch,
    });
  const e422 = await assertRejects(() => mk(422).send(MSG), EmailSendError);
  assertEquals(e422.retryable, false);
  assertEquals(e422.message, "resend: HTTP 422: nope");
  const e503 = await assertRejects(() => mk(503).send(MSG), EmailSendError);
  assertEquals(e503.retryable, true);
});

Deno.test("smtp: maps message to nodemailer and returns Message-ID", async () => {
  const mails: Record<string, unknown>[] = [];
  const transport: SmtpTransport = {
    sendMail(m) {
      mails.push(m);
      return Promise.resolve({
        messageId: "<abc@local>",
        accepted: ["council@example.test"],
        rejected: [],
      });
    },
  };
  const s = new SmtpEmailSender({ host: "inbucket", port: 1025 }, transport);
  assertEquals(await s.send(MSG), { messageId: "<abc@local>", provider: "smtp" });
  assertEquals(mails[0].replyTo, "reply+RPT-ABC123@reports.localhost");
  assertEquals(mails[0].to, ["council@example.test"]);
});

Deno.test("smtp: rejected recipients and 5xx replies are permanent failures", async () => {
  const rejecting = new SmtpEmailSender({ host: "h", port: 1025 }, {
    sendMail: () =>
      Promise.resolve({ messageId: "<x>", accepted: [], rejected: ["council@example.test"] }),
  });
  const e1 = await assertRejects(() => rejecting.send(MSG), EmailSendError);
  assertEquals(e1.retryable, false);

  const down = new SmtpEmailSender({ host: "h", port: 1025 }, {
    sendMail: () =>
      Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" })),
  });
  const e2 = await assertRejects(() => down.send(MSG), EmailSendError);
  assertEquals(e2.retryable, true);
});

Deno.test("capture mode: local Mailpit allowed; real transports need EMAIL_CAPTURE_TO", () => {
  const env = (vars: Record<string, string>) => (n: string) => vars[n];
  assertInstanceOf(createEmailSenderFromEnv(env({})), SmtpEmailSender);
  assertThrows(() => createEmailSenderFromEnv(env({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k" })));
  assertThrows(() => createEmailSenderFromEnv(env({ SMTP_HOST: "smtp.real-provider.com" })));
  assertInstanceOf(
    createEmailSenderFromEnv(env({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", EMAIL_CAPTURE_TO: "me@test" })),
    CaptureEmailSender,
  );
  assertInstanceOf(
    createEmailSenderFromEnv(env({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "k", EMAIL_MODE: "live" })),
    ResendEmailSender,
  );
});

Deno.test("capture mode: redirects to the capture inbox and names the intended recipient", async () => {
  const sent: EmailMessage[] = [];
  const inner = {
    provider: "test",
    send: (m: EmailMessage) => (sent.push(m), Promise.resolve({ messageId: "x", provider: "test" })),
  };
  await new CaptureEmailSender(inner, "me@test").send({
    from: "a@b", to: ["streetcare@council.gov.uk"], subject: "Pothole", text: "t",
  } as EmailMessage);
  assertEquals(sent[0].to, ["me@test"]);
  assertEquals(sent[0].subject, "[CAPTURED for streetcare@council.gov.uk] Pothole");
});
