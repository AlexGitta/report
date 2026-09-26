# deliver-report

Sends a routed report to the council(s) and marks the signposts the user has to submit themselves
(PLAN §5 "Delivery", §6 "Tracking").

```
POST /functions/v1/deliver-report
{ "report_id": "<uuid>", "force"?: boolean }
```

`route-report` calls this automatically after a successful `routed` outcome (see "Chaining" below).
It is safe to call again: only deliveries in `pending` or `failed` are processed.

## What it does

For each `deliveries` row of the report in `pending` / `failed`:

| channel | action | result |
|---|---|---|
| `email` | Email to `recipient` via the configured `EmailSender` | `sent` + `sent_at` + `provider_message_id`, or `failed` + `error` |
| `signpost` | Nothing is sent; `recipient` already holds the council/police form URL | `needs_user` |
| `open311` | Not implemented yet, left untouched | |

Then:

- At least one email newly sent and the report is `submitted` → report `sent` + `report_updates` row
  (`system`, `status`, `status_to 'sent'`, body `Sent to <authority names>`, public).
  If the report was already `sent` (a retried delivery), a public `comment` `Also sent to <names>` instead.
- Signposts newly moved to `needs_user` → a **non-public** `comment` row (`system`):
  `Needs you to submit: <names> ... online form(s)`. The report status is left alone (stays `submitted`
  when there are only signposts).
- A delivery is "claimed" with an optimistic update on `updated_at` before sending, so two concurrent
  runs don't both send it.

Skipped (HTTP 409) when the report is not in `submitted | sent | acknowledged | in_progress`, is hidden,
or has `needs_moderation` (pass `"force": true` once a moderator has cleared it).

### The email

- Subject: `[RPT-XXXXXX] <Category> reported at <address_text or lat, lng>`
- Plain text + simple HTML: category, severity, extra fields (labelled from `categories.extra_fields`),
  description, reported time (UK time), reference, address, lat/lng and an OpenStreetMap link.
- Photos: signed URLs (30 days) from bucket `report-photos`. Photos flagged `contains_people` or
  `contains_plates` are **not** linked unless a moderator has made them public (`is_public`); the email
  says how many were held back.
- Reporter contact (`guest_name`, `guest_email`, `guest_phone`) is included only when set on the report
  row, marked "for follow-up only, please do not publish". This applies to ASB too: the council gets it;
  nothing personal is written to the public timeline.
- `Reply-To: reply+<ref>@<REPLY_DOMAIN>`, headers `X-Report-Ref`, `X-Delivery-Id`. Inbound reply parsing
  is not built yet (v1: moderators enter council replies by hand).

## Response

```jsonc
{
  "status": "processed",
  "report_id": "…",
  "report_status": "sent",          // report status after this run
  "sent": 1, "failed": 0,           // this run
  "deliveries": [                   // what this run did
    { "id": 12, "channel": "email", "authority_gss": "E10000016", "police_force_id": null,
      "name": "Kent County Council", "recipient": "highways@…", "status": "sent", "action": "sent" }
  ],
  "needs_user": [                   // ALL signposts the user still has to submit (any run)
    { "id": 13, "channel": "signpost", "police_force_id": "kent", "name": "Kent Police",
      "recipient": "https://www.kent.police.uk/ro/report/", "status": "needs_user", "action": "needs_user" }
  ]
}
```

404 `report_not_found` / `category_not_found`, 409 `skipped`, 400 bad input, 500 internal error.

## Environment

| Var | Default | |
|---|---|---|
| `EMAIL_PROVIDER` | `smtp` | `smtp` or `resend` |
| `SMTP_HOST` | `inbucket` | Local Mailpit inside the Supabase Docker network |
| `SMTP_PORT` | `1025` | |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | unset | Optional, for a real SMTP relay (`SMTP_SECURE=true` for port 465) |
| `RESEND_API_KEY` | | Required when `EMAIL_PROVIDER=resend` |
| `EMAIL_FROM` | `Local Problem Reporter <no-reply@<REPLY_DOMAIN>>` | Must be a verified sender domain on Resend |
| `REPLY_DOMAIN` | `reports.localhost` | Reply-To is `reply+<ref>@<REPLY_DOMAIN>` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | set by Supabase | Service-role client (bypasses RLS) |

`route-report` also reads `AUTO_DELIVER` (set to `false` to stop it calling this function).

Hosted Supabase blocks outbound SMTP on ports 25 and 587, so use `EMAIL_PROVIDER=resend` in production:

```sh
supabase secrets set EMAIL_PROVIDER=resend RESEND_API_KEY=re_… EMAIL_FROM="Local Problem Reporter <reports@yourdomain>" REPLY_DOMAIN=yourdomain
```

Locally, the defaults work with no configuration. To override, put the vars in `supabase/functions/.env`
(read by `supabase functions serve`, or pass `--env-file`).

## Viewing emails locally

`supabase start` runs Mailpit. Every email sent by this function lands there:

- Web UI: **http://localhost:54324** (see `supabase status`)
- SMTP inside Docker: `inbucket:1025` (the default `SMTP_HOST` / `SMTP_PORT`)

Try it end to end:

```sh
supabase start
supabase functions serve            # or rely on the edge runtime started by `supabase start`
# create a report (RPC create_report), then:
curl -X POST http://localhost:54321/functions/v1/route-report \
  -H "Authorization: Bearer <anon or service key>" -H "content-type: application/json" \
  -d '{"report_id":"<uuid>"}'
# route-report calls deliver-report; open http://localhost:54324 to see the email.
# Re-run delivery only:
curl -X POST http://localhost:54321/functions/v1/deliver-report \
  -H "Authorization: Bearer <service key>" -H "content-type: application/json" \
  -d '{"report_id":"<uuid>"}'
```

Only authorities with an `authority_contacts.email` get an email; everywhere else is a signpost.
To test email locally, add a contact row for the council your test point routes to, e.g.
`insert into authority_contacts (authority_gss, email) values ('E10000016', 'highways@kent.test');`.

## Chaining from route-report

`route-report/handler.ts` → after a `routed` outcome, `deliverViaFunction()` POSTs
`{report_id}` to `${SUPABASE_URL}/functions/v1/deliver-report` with the service-role key (30 s timeout)
and returns its JSON as `delivery` in the route-report response. A delivery error never fails routing
(`delivery: { status: "error", … }`); call deliver-report again to retry.

## Code

| File | |
|---|---|
| `index.ts` | Thin entry: env → deps → `Deno.serve` |
| `handler.ts` | HTTP parsing / status codes |
| `deliver.ts` | Delivery logic (`deliverReport`), no I/O of its own |
| `compose.ts` | Email subject / text / HTML (pure) |
| `repo.ts` | `DeliveryRepo` interface + Supabase implementation |
| `../_shared/email/` | `EmailSender` interface, `SmtpEmailSender` (nodemailer), `ResendEmailSender`, `createEmailSenderFromEnv` |

```sh
cd supabase/functions/deliver-report
deno task check
deno task test      # deno test --allow-env . ../_shared/email/
```
