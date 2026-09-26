-- Keep a copy of what we emailed so the reporter can see exactly what the council got,
-- and whether it really went out or was captured (dev/demo mode, see EMAIL_MODE).
alter table public.deliveries
  add column email_subject text,
  add column email_text    text,
  add column email_mode    text check (email_mode in ('capture', 'live'));

comment on column public.deliveries.email_mode is
  'capture = caught by the local/test mailbox, never reached the council; live = sent to the council.';
