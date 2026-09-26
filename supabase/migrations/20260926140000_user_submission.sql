-- Signposted deliveries: the reporter submits on the council/police site themselves,
-- then tells us they've done it (optionally with the council's own reference number).

alter table public.deliveries
  add column external_ref text check (external_ref is null or char_length(external_ref) <= 100);

comment on column public.deliveries.external_ref is
  'Reference number the council/police gave the reporter when they submitted via the signposted form.';

create or replace function public.mark_delivery_submitted(delivery_id bigint, external_ref text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d           public.deliveries;
  r_status    public.report_status;
  target_name text;
  ref         text := nullif(btrim(mark_delivery_submitted.external_ref), '');
  msg         text;
begin
  select * into d from public.deliveries where id = delivery_id for update;
  if not found then
    raise exception 'delivery not found' using errcode = 'P0002';
  end if;
  if not (public.owns_report(d.report_id) or public.is_moderator()) then
    raise exception 'only the reporter can mark this as submitted' using errcode = '42501';
  end if;
  -- Idempotent: a second tap (or an email delivery) is a no-op.
  if d.status <> 'needs_user' then
    return;
  end if;

  update public.deliveries
     set status = 'sent', sent_at = now(), external_ref = ref, error = null
   where id = d.id;

  select coalesce(a.name, p.name) into target_name
    from public.deliveries x
    left join public.authorities a on a.gss_code = x.authority_gss
    left join public.police_forces p on p.id = x.police_force_id
   where x.id = d.id;

  msg := 'Reported to ' || coalesce(target_name, 'the council') || ' by the reporter'
         || case when ref is not null then ' (their ref: ' || ref || ')' else '' end;

  select status into r_status from public.reports where id = d.report_id for update;
  if r_status = 'submitted' then
    update public.reports set status = 'sent' where id = d.report_id;
    insert into public.report_updates (report_id, actor_type, actor_id, kind, status_to, body)
    values (d.report_id, 'reporter', auth.uid(), 'status', 'sent', msg);
  else
    insert into public.report_updates (report_id, actor_type, actor_id, kind, body)
    values (d.report_id, 'reporter', auth.uid(), 'comment', msg);
  end if;
end;
$$;

revoke all on function public.mark_delivery_submitted(bigint, text) from public, anon;
grant execute on function public.mark_delivery_submitted(bigint, text) to authenticated;
