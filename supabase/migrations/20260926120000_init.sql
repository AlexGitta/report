-- =============================================================================
-- Local Problem Reporter: initial schema (PLAN.md §3, §5, §6, §8)
-- Postgres 15/17 on Supabase, PostGIS in the `extensions` schema.
-- =============================================================================

create extension if not exists postgis with schema extensions;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.report_status as enum (
  'draft', 'submitted', 'sent', 'acknowledged', 'in_progress', 'fixed', 'closed', 'unrouted'
);

create type public.routing_target as enum (
  'highway', 'waste_collection', 'district_or_unitary', 'asb', 'police_signpost'
);

create type public.category_group as enum (
  'roads', 'waste', 'street_scene', 'community_safety'
);

create type public.update_actor as enum ('system', 'reporter', 'public', 'moderator');

create type public.update_kind as enum ('status', 'comment', 'still_there', 'fixed');

create type public.delivery_channel as enum ('email', 'signpost', 'open311');

create type public.delivery_status as enum (
  'pending',      -- queued, not yet attempted
  'sent',         -- handed to the email provider / Open311
  'delivered',    -- provider confirmed delivery
  'needs_user',   -- signpost: the user must submit on the council/police site
  'failed',
  'bounced'
);

-- -----------------------------------------------------------------------------
-- Generic helpers
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Short public reference: 'RPT-' + 6 chars of Crockford base32 (no I, L, O, U).
create or replace function public.generate_report_ref()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  candidate text;
  i int;
begin
  loop
    candidate := 'RPT-';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from public.reports r where r.ref = candidate);
  end loop;
  return candidate;
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  email         text,
  phone         text,
  is_moderator  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- True when the current user is a moderator. SECURITY DEFINER so it can be used
-- inside RLS policies on profiles without recursion.
create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.is_moderator from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

-- Create a profile row for every new auth user (including anonymous sign-ins).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stop ordinary users promoting themselves to moderator.
create or replace function public.profiles_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and new.is_moderator is distinct from old.is_moderator
     and not public.is_moderator() then
    raise exception 'not allowed to change is_moderator' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();

-- -----------------------------------------------------------------------------
-- categories
-- -----------------------------------------------------------------------------
create table public.categories (
  id                   smallint generated always as identity primary key,
  slug                 text not null unique check (slug ~ '^[a-z][a-z0-9_]*$'),
  category_group       public.category_group not null,
  name                 text not null,
  description          text not null,           -- one line; used in the AI prompt
  routing_target       public.routing_target not null,
  public               boolean not null default true,
  hide_exact_location  boolean not null default false,  -- ASB/noise: blur location, hide address publicly
  urgent               boolean not null default false,
  requires_address     boolean not null default false,  -- e.g. missed bin: address matters, not a map point
  safety_interstitial  boolean not null default false,  -- show "call 999 / 101" screen
  extra_fields         jsonb not null default '[]'::jsonb check (jsonb_typeof(extra_fields) = 'array'),
  sort_order           smallint not null default 0,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- authorities / contacts / police
-- -----------------------------------------------------------------------------
create table public.authorities (
  gss_code    text primary key check (gss_code ~ '^E(06|07|08|09|10)[0-9]{6}$'),
  name        text not null,
  type        text not null check (type in ('E06', 'E07', 'E08', 'E09', 'E10')),
  parent_gss  text references public.authorities (gss_code) on update cascade on delete set null
              deferrable initially deferred,
  website     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint authorities_type_matches_code check (type = left(gss_code, 3))
);

create index authorities_parent_gss_idx on public.authorities (parent_gss);

create trigger authorities_set_updated_at
  before update on public.authorities
  for each row execute function public.set_updated_at();

create table public.authority_contacts (
  id              bigint generated always as identity primary key,
  authority_gss   text not null references public.authorities (gss_code) on update cascade on delete cascade,
  category_group  public.category_group,       -- null = applies to all groups
  category_id     smallint references public.categories (id) on delete cascade, -- optional finer override
  email           text,
  form_url        text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint authority_contacts_has_channel check (email is not null or form_url is not null)
);

create index authority_contacts_authority_idx on public.authority_contacts (authority_gss, category_group);

create trigger authority_contacts_set_updated_at
  before update on public.authority_contacts
  for each row execute function public.set_updated_at();

create table public.police_forces (
  id                 text primary key,   -- data.police.uk force slug, e.g. 'kent'
  name               text not null,
  report_url         text,
  non_emergency_url  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger police_forces_set_updated_at
  before update on public.police_forces
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- reports
-- -----------------------------------------------------------------------------
create table public.reports (
  id                    uuid primary key default gen_random_uuid(),
  ref                   text not null unique default public.generate_report_ref(),
  category_id           smallint not null references public.categories (id),
  status                public.report_status not null default 'submitted',
  location              extensions.geography(Point, 4326) not null,
  address_text          text,
  description           text check (description is null or char_length(description) <= 4000),
  severity              text check (severity in ('low', 'medium', 'high')),
  extra                 jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  reporter_id           uuid references auth.users (id) on delete set null,
  guest_email           text,
  guest_name            text,
  guest_phone           text,
  is_anonymous_public   boolean not null default true,  -- hide reporter's name on public pages
  is_hidden             boolean not null default false, -- moderator takedown
  needs_moderation      boolean not null default false,
  ai_result             jsonb,
  ai_category_slug      text,                           -- AI's top suggestion, for accuracy stats
  duplicate_of          uuid references public.reports (id) on delete set null,
  routed_authorities    text[] not null default '{}',
  police_force_id       text references public.police_forces (id),
  police_neighbourhood  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index reports_location_gix on public.reports using gist (location);
create index reports_status_category_idx on public.reports (status, category_id);
create index reports_reporter_idx on public.reports (reporter_id);
create index reports_created_at_idx on public.reports (created_at desc);
create index reports_duplicate_of_idx on public.reports (duplicate_of);

create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();

-- Owners may edit only a few columns directly; everything else goes through
-- RPCs / edge functions (which run as postgres / service_role) or moderators.
create or replace function public.reports_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and not public.is_moderator() then
    if new.id                   is distinct from old.id
    or new.ref                  is distinct from old.ref
    or new.category_id          is distinct from old.category_id
    or new.status               is distinct from old.status
    or new.location             is distinct from old.location
    or new.reporter_id          is distinct from old.reporter_id
    or new.is_hidden            is distinct from old.is_hidden
    or new.needs_moderation     is distinct from old.needs_moderation
    or new.ai_result            is distinct from old.ai_result
    or new.ai_category_slug     is distinct from old.ai_category_slug
    or new.duplicate_of         is distinct from old.duplicate_of
    or new.routed_authorities   is distinct from old.routed_authorities
    or new.police_force_id      is distinct from old.police_force_id
    or new.police_neighbourhood is distinct from old.police_neighbourhood
    or new.created_at           is distinct from old.created_at
    then
      raise exception 'only description, address_text, severity, extra, guest_* and is_anonymous_public can be edited by the reporter'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger reports_guard
  before update on public.reports
  for each row execute function public.reports_guard();

-- -----------------------------------------------------------------------------
-- report_photos
-- -----------------------------------------------------------------------------
create table public.report_photos (
  id                uuid primary key default gen_random_uuid(),
  report_id         uuid not null references public.reports (id) on delete cascade,
  storage_path      text not null unique,   -- object name inside bucket 'report-photos': '<report_id>/<file>'
  width             int,
  height            int,
  is_public         boolean not null default false,
  contains_people   boolean,
  contains_plates   boolean,
  sort_order        smallint not null default 0,
  created_at        timestamptz not null default now()
);

create index report_photos_report_idx on public.report_photos (report_id);

-- -----------------------------------------------------------------------------
-- report_updates (timeline)
-- -----------------------------------------------------------------------------
create table public.report_updates (
  id          bigint generated always as identity primary key,
  report_id   uuid not null references public.reports (id) on delete cascade,
  actor_type  public.update_actor not null,
  actor_id    uuid references auth.users (id) on delete set null,
  kind        public.update_kind not null,
  status_to   public.report_status,
  body        text check (body is null or char_length(body) <= 2000),
  photo_path  text,
  is_public   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint report_updates_status_needs_target check (kind <> 'status' or status_to is not null)
);

create index report_updates_report_idx on public.report_updates (report_id, created_at);

-- -----------------------------------------------------------------------------
-- deliveries
-- -----------------------------------------------------------------------------
create table public.deliveries (
  id                   bigint generated always as identity primary key,
  report_id            uuid not null references public.reports (id) on delete cascade,
  authority_gss        text references public.authorities (gss_code) on update cascade,
  police_force_id      text references public.police_forces (id),
  channel              public.delivery_channel not null,
  status               public.delivery_status not null default 'pending',
  recipient            text,        -- email address or signpost URL
  provider_message_id  text,
  sent_at              timestamptz,
  error                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint deliveries_one_target check (num_nonnulls(authority_gss, police_force_id) = 1)
);

create index deliveries_report_idx on public.deliveries (report_id);
create index deliveries_status_idx on public.deliveries (status) where status in ('pending', 'failed');

create trigger deliveries_set_updated_at
  before update on public.deliveries
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- report_followers
-- -----------------------------------------------------------------------------
create table public.report_followers (
  report_id   uuid not null references public.reports (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (report_id, user_id)
);

create index report_followers_user_idx on public.report_followers (user_id);

-- -----------------------------------------------------------------------------
-- Visibility helper
-- -----------------------------------------------------------------------------
-- A report is publicly visible when it is not a draft, not hidden by a
-- moderator, and its category is public.
create or replace function public.report_is_public(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.reports r
    join public.categories c on c.id = r.category_id
    where r.id = p_report_id
      and r.status <> 'draft'
      and not r.is_hidden
      and c.public
  );
$$;

create or replace function public.owns_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.reports r where r.id = p_report_id and r.reporter_id = auth.uid()
  );
$$;

-- -----------------------------------------------------------------------------
-- Public views (run with owner rights, expose only safe columns)
-- -----------------------------------------------------------------------------
-- Locations for categories with hide_exact_location are rounded to 3 dp
-- (roughly 70-110 m) and the address is withheld.
create view public.public_reports
with (security_barrier = true)
as
select
  r.id,
  r.ref,
  r.category_id,
  c.slug                                                   as category_slug,
  c.name                                                   as category_name,
  c.category_group,
  c.urgent,
  r.status,
  case when c.hide_exact_location
       then round(extensions.st_y(r.location::extensions.geometry)::numeric, 3)::double precision
       else extensions.st_y(r.location::extensions.geometry) end  as lat,
  case when c.hide_exact_location
       then round(extensions.st_x(r.location::extensions.geometry)::numeric, 3)::double precision
       else extensions.st_x(r.location::extensions.geometry) end  as lng,
  c.hide_exact_location                                    as location_is_approximate,
  case when c.hide_exact_location then null else r.address_text end as address_text,
  r.description,
  r.severity,
  case when r.is_anonymous_public then null else p.display_name end as reporter_display_name,
  r.duplicate_of,
  r.routed_authorities,
  r.police_force_id,
  (select count(*) from public.report_updates u
     where u.report_id = r.id and u.kind = 'still_there')::int     as still_there_count,
  (select count(*) from public.report_followers f
     where f.report_id = r.id)::int                                as follower_count,
  (select rp.storage_path from public.report_photos rp
     where rp.report_id = r.id and rp.is_public
     order by rp.sort_order, rp.created_at limit 1)                 as cover_photo_path,
  r.created_at,
  r.updated_at
from public.reports r
join public.categories c on c.id = r.category_id
left join public.profiles p on p.id = r.reporter_id
where r.status <> 'draft'
  and not r.is_hidden
  and c.public;

create view public.public_report_updates
with (security_barrier = true)
as
select
  u.id,
  u.report_id,
  u.actor_type,
  u.kind,
  u.status_to,
  u.body,
  case when u.photo_path is not null
        and exists (select 1 from public.report_photos rp where rp.storage_path = u.photo_path and rp.is_public)
       then u.photo_path end as photo_path,
  u.created_at
from public.report_updates u
where u.is_public
  and public.report_is_public(u.report_id);

grant select on public.public_reports to anon, authenticated;
grant select on public.public_report_updates to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.categories         enable row level security;
alter table public.authorities        enable row level security;
alter table public.authority_contacts enable row level security;
alter table public.police_forces      enable row level security;
alter table public.reports            enable row level security;
alter table public.report_photos      enable row level security;
alter table public.report_updates     enable row level security;
alter table public.deliveries         enable row level security;
alter table public.report_followers   enable row level security;

-- profiles
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "profiles: moderators all" on public.profiles
  for all to authenticated using (public.is_moderator()) with check (public.is_moderator());

-- reference data: public read, moderators write
create policy "categories: public read" on public.categories
  for select to anon, authenticated using (true);
create policy "categories: moderators all" on public.categories
  for all to authenticated using (public.is_moderator()) with check (public.is_moderator());

create policy "authorities: public read" on public.authorities
  for select to anon, authenticated using (true);
create policy "authorities: moderators all" on public.authorities
  for all to authenticated using (public.is_moderator()) with check (public.is_moderator());

create policy "police_forces: public read" on public.police_forces
  for select to anon, authenticated using (true);
create policy "police_forces: moderators all" on public.police_forces
  for all to authenticated using (public.is_moderator()) with check (public.is_moderator());

-- Contact form URLs are useful to show ("submit on the council's own form"),
-- but inbox emails are kept private.
create policy "authority_contacts: moderators all" on public.authority_contacts
  for all to authenticated using (public.is_moderator()) with check (public.is_moderator());

-- reports: public reads go through public_reports / RPCs.
create policy "reports: owner read" on public.reports
  for select to authenticated using (reporter_id = (select auth.uid()));
create policy "reports: owner update" on public.reports
  for update to authenticated
  using (reporter_id = (select auth.uid()))
  with check (reporter_id = (select auth.uid()));
create policy "reports: moderators all" on public.reports
  for all to authenticated using (public.is_moderator()) with check (public.is_moderator());

-- report_photos
create policy "report_photos: public read" on public.report_photos
  for select to anon, authenticated using (is_public and public.report_is_public(report_id));
create policy "report_photos: owner read" on public.report_photos
  for select to authenticated using (public.owns_report(report_id));
create policy "report_photos: moderators all" on public.report_photos
  for all to authenticated using (public.is_moderator()) with check (public.is_moderator());

-- report_updates: public reads via public_report_updates.
create policy "report_updates: owner read" on public.report_updates
  for select to authenticated using (public.owns_report(report_id) or actor_id = (select auth.uid()));
create policy "report_updates: moderators all" on public.report_updates
  for all to authenticated using (public.is_moderator()) with check (public.is_moderator());

-- deliveries: owners can see where their report went.
create policy "deliveries: owner read" on public.deliveries
  for select to authenticated using (public.owns_report(report_id));
create policy "deliveries: moderators all" on public.deliveries
  for all to authenticated using (public.is_moderator()) with check (public.is_moderator());

-- report_followers: users manage their own follows.
create policy "report_followers: read own" on public.report_followers
  for select to authenticated using (user_id = (select auth.uid()));
create policy "report_followers: follow" on public.report_followers
  for insert to authenticated
  with check (user_id = (select auth.uid())
              and (public.report_is_public(report_id) or public.owns_report(report_id)));
create policy "report_followers: unfollow" on public.report_followers
  for delete to authenticated using (user_id = (select auth.uid()));
create policy "report_followers: moderators all" on public.report_followers
  for all to authenticated using (public.is_moderator()) with check (public.is_moderator());

-- Belt and braces: anon never writes tables directly.
revoke insert, update, delete, truncate on all tables in schema public from anon;

-- -----------------------------------------------------------------------------
-- RPCs
-- -----------------------------------------------------------------------------

-- Create a report. Returns (id, ref). Callable by anon and authenticated
-- (guests normally use Supabase anonymous sign-in, so auth.uid() is set and
-- they can later upload photos / see their own report).
create or replace function public.create_report(
  category_slug        text,
  lat                  double precision,
  lng                  double precision,
  description          text default null,
  address_text         text default null,
  guest_email          text default null,
  is_anonymous_public  boolean default true,
  extra                jsonb default '{}'::jsonb,
  severity             text default null,
  ai_result            jsonb default null,
  guest_name           text default null,
  guest_phone          text default null
)
returns table (id uuid, ref text)
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cat       public.categories%rowtype;
  v_id        uuid;
  v_ref       text;
  v_uid       uuid := auth.uid();
  v_field     jsonb;
  v_extra     jsonb := coalesce(create_report.extra, '{}'::jsonb);
  v_ai_slug   text;
begin
  select * into v_cat from public.categories c
  where c.slug = create_report.category_slug and c.active;
  if not found then
    raise exception 'unknown category: %', create_report.category_slug using errcode = '22023';
  end if;

  if lat is null or lng is null or lat not between 49.8 and 55.9 or lng not between -6.5 and 2.0 then
    raise exception 'location must be in England' using errcode = '22023';
  end if;

  if jsonb_typeof(v_extra) <> 'object' then
    raise exception 'extra must be a JSON object' using errcode = '22023';
  end if;

  if v_cat.requires_address and nullif(btrim(create_report.address_text), '') is null then
    raise exception 'an address is required for %', v_cat.slug using errcode = '22023';
  end if;

  for v_field in select * from jsonb_array_elements(v_cat.extra_fields) loop
    if coalesce((v_field ->> 'required')::boolean, false)
       and nullif(btrim(coalesce(v_extra ->> (v_field ->> 'key'), '')), '') is null then
      raise exception 'missing required field: %', v_field ->> 'key' using errcode = '22023';
    end if;
  end loop;

  if guest_email is not null and guest_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'invalid email' using errcode = '22023';
  end if;

  v_ai_slug := create_report.ai_result -> 'candidates' -> 0 ->> 'category';

  insert into public.reports (
    category_id, status, location, address_text, description, severity, extra,
    reporter_id, guest_email, guest_name, guest_phone, is_anonymous_public,
    ai_result, ai_category_slug, needs_moderation
  ) values (
    v_cat.id,
    'submitted',
    st_setsrid(st_makepoint(lng, lat), 4326)::geography,
    nullif(btrim(create_report.address_text), ''),
    nullif(btrim(create_report.description), ''),
    create_report.severity,
    v_extra,
    v_uid,
    nullif(btrim(create_report.guest_email), ''),
    nullif(btrim(create_report.guest_name), ''),
    nullif(btrim(create_report.guest_phone), ''),
    coalesce(create_report.is_anonymous_public, true),
    create_report.ai_result,
    v_ai_slug,
    coalesce((create_report.ai_result ->> 'unsafe_or_irrelevant')::boolean, false)
  )
  returning reports.id, reports.ref into v_id, v_ref;

  insert into public.report_updates (report_id, actor_type, actor_id, kind, status_to)
  values (v_id, 'reporter', v_uid, 'status', 'submitted');

  if v_uid is not null then
    insert into public.report_followers (report_id, user_id)
    values (v_id, v_uid) on conflict do nothing;
  end if;

  id := v_id;
  ref := v_ref;
  return next;
end;
$$;

-- Register a photo already uploaded to storage at '<report_id>/<file>'.
-- Only the report's owner (or a moderator) may call this. Photos flagged as
-- containing people or number plates stay private until a moderator approves.
create or replace function public.add_report_photo(
  report_id        uuid,
  storage_path     text,
  width            int default null,
  height           int default null,
  contains_people  boolean default null,
  contains_plates  boolean default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id uuid;
begin
  if not (public.owns_report(add_report_photo.report_id) or public.is_moderator()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if split_part(add_report_photo.storage_path, '/', 1) <> add_report_photo.report_id::text then
    raise exception 'storage_path must start with <report_id>/' using errcode = '22023';
  end if;
  if (select count(*) from public.report_photos p where p.report_id = add_report_photo.report_id) >= 3 then
    raise exception 'a report can have at most 3 photos' using errcode = '22023';
  end if;

  insert into public.report_photos (report_id, storage_path, width, height, is_public,
                                    contains_people, contains_plates, sort_order)
  values (
    add_report_photo.report_id,
    add_report_photo.storage_path,
    add_report_photo.width,
    add_report_photo.height,
    not (coalesce(add_report_photo.contains_people, false) or coalesce(add_report_photo.contains_plates, false)),
    add_report_photo.contains_people,
    add_report_photo.contains_plates,
    (select count(*) from public.report_photos p where p.report_id = add_report_photo.report_id)::smallint
  )
  returning report_photos.id into v_id;
  return v_id;
end;
$$;

-- Row shape returned by reports_near / find_duplicates (a composite type, so
-- the RPC input names lat/lng/category_slug do not clash with output columns).
create type public.nearby_report as (
  id                       uuid,
  ref                      text,
  category_id              smallint,
  category_slug            text,
  category_name            text,
  category_group           public.category_group,
  urgent                   boolean,
  status                   public.report_status,
  lat                      double precision,
  lng                      double precision,
  location_is_approximate  boolean,
  address_text             text,
  description              text,
  severity                 text,
  reporter_display_name    text,
  duplicate_of             uuid,
  still_there_count        int,
  cover_photo_path         text,
  created_at               timestamptz,
  updated_at               timestamptz,
  distance_m               double precision
);

-- Nearby public reports (safe columns + distance in metres).
create or replace function public.reports_near(
  lat             double precision,
  lng             double precision,
  radius_m        double precision default 1000,
  category_slugs  text[] default null
)
returns setof public.nearby_report
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with origin as (
    select st_setsrid(st_makepoint(reports_near.lng, reports_near.lat), 4326)::geography as g
  )
  select
    pr.id, pr.ref, pr.category_id, pr.category_slug, pr.category_name, pr.category_group,
    pr.urgent, pr.status, pr.lat, pr.lng, pr.location_is_approximate, pr.address_text,
    pr.description, pr.severity, pr.reporter_display_name, pr.duplicate_of,
    pr.still_there_count, pr.cover_photo_path, pr.created_at, pr.updated_at,
    -- distance to the (possibly blurred) public point, so it leaks nothing extra
    round(st_distance(o.g, st_setsrid(st_makepoint(pr.lng, pr.lat), 4326)::geography)::numeric, 0)::double precision
      as distance_m
  from origin o
  join public.reports r
    on st_dwithin(r.location, o.g, least(greatest(coalesce(reports_near.radius_m, 1000), 1), 50000))
  join public.public_reports pr on pr.id = r.id
  where reports_near.category_slugs is null
     or pr.category_slug = any (reports_near.category_slugs)
  order by distance_m, pr.created_at desc
  limit 500;
$$;

-- Open reports in the same category within 25 m (duplicate check).

create or replace function public.find_duplicates(
  category_slug  text,
  lat            double precision,
  lng            double precision
)
returns setof public.nearby_report
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select n.*
  from public.reports_near(find_duplicates.lat, find_duplicates.lng, 25,
                           array[find_duplicates.category_slug]) n
  where n.status in ('submitted', 'sent', 'acknowledged', 'in_progress', 'unrouted')
    and n.duplicate_of is null
  order by n.distance_m
  limit 10;
$$;

-- Add a timeline entry: 'still_there', 'fixed' or 'comment'. Moderators may
-- also post kind 'status' with p_status_to. The reporter (or a moderator)
-- marking 'fixed' moves the report to status 'fixed'; anyone else's 'fixed'
-- is recorded as a signal only.
create or replace function public.add_report_update(
  report_id   uuid,
  kind        public.update_kind,
  body        text default null,
  photo_path  text default null,
  status_to   public.report_status default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_owner   boolean;
  v_mod     boolean := public.is_moderator();
  v_actor   public.update_actor;
  v_status  public.report_status;
  v_new     public.report_status;
  v_id      bigint;
begin
  if v_uid is null then
    raise exception 'sign in (anonymous sign-in is fine) to post updates' using errcode = '42501';
  end if;

  select r.status into v_status from public.reports r where r.id = add_report_update.report_id;
  if not found then
    raise exception 'report not found' using errcode = 'P0002';
  end if;

  v_owner := public.owns_report(add_report_update.report_id);
  if not (v_owner or v_mod or public.report_is_public(add_report_update.report_id)) then
    raise exception 'report not found' using errcode = 'P0002';
  end if;

  v_actor := case when v_mod then 'moderator'
                  when v_owner then 'reporter'
                  else 'public' end::public.update_actor;

  if add_report_update.kind = 'status' then
    if not v_mod then
      raise exception 'only moderators can set status' using errcode = '42501';
    end if;
    if add_report_update.status_to is null then
      raise exception 'status_to is required' using errcode = '22023';
    end if;
    v_new := add_report_update.status_to;
  elsif add_report_update.kind = 'fixed' and (v_owner or v_mod) then
    v_new := 'fixed';
  elsif add_report_update.kind = 'comment' and nullif(btrim(add_report_update.body), '') is null
        and add_report_update.photo_path is null then
    raise exception 'comment needs a body or photo' using errcode = '22023';
  end if;

  if add_report_update.photo_path is not null
     and split_part(add_report_update.photo_path, '/', 1) <> add_report_update.report_id::text then
    raise exception 'photo_path must start with <report_id>/' using errcode = '22023';
  end if;

  insert into public.report_updates (report_id, actor_type, actor_id, kind, status_to, body, photo_path)
  values (
    add_report_update.report_id,
    v_actor,
    v_uid,
    add_report_update.kind,
    v_new,
    nullif(btrim(add_report_update.body), ''),
    add_report_update.photo_path
  )
  returning report_updates.id into v_id;

  if v_new is not null and v_new is distinct from v_status then
    update public.reports r set status = v_new where r.id = add_report_update.report_id;
  end if;

  return v_id;
end;
$$;

-- Function privileges: RPCs for clients; internals locked down.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.generate_report_ref() from public, anon, authenticated;

grant execute on function public.create_report(text, double precision, double precision, text, text, text, boolean, jsonb, text, jsonb, text, text) to anon, authenticated;
grant execute on function public.reports_near(double precision, double precision, double precision, text[]) to anon, authenticated;
grant execute on function public.find_duplicates(text, double precision, double precision) to anon, authenticated;
revoke execute on function public.add_report_update(uuid, public.update_kind, text, text, public.report_status) from public, anon;
grant execute on function public.add_report_update(uuid, public.update_kind, text, text, public.report_status) to authenticated;
revoke execute on function public.add_report_photo(uuid, text, int, int, boolean, boolean) from public, anon;
grant execute on function public.add_report_photo(uuid, text, int, int, boolean, boolean) to authenticated;

-- -----------------------------------------------------------------------------
-- Storage: private bucket 'report-photos', objects named '<report_id>/<file>'
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

-- Who may upload to '<report_id>/...': the report owner or a moderator, or,
-- for community update photos, any signed-in user under
-- '<report_id>/updates/<their uid>/...' on a publicly visible report.
create or replace function public.can_upload_report_photo(object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(object_name, '/');
  v_report uuid;
begin
  if auth.uid() is null or array_length(v_parts, 1) < 2
     or v_parts[1] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  v_report := v_parts[1]::uuid;
  if public.owns_report(v_report) or public.is_moderator() then
    return true;
  end if;
  return array_length(v_parts, 1) >= 4
     and v_parts[2] = 'updates'
     and v_parts[3] = auth.uid()::text
     and public.report_is_public(v_report);
end;
$$;

-- Public may read an object when its report_photos row is public (or it is
-- the photo of a public timeline update that a moderator made public).
create or replace function public.can_read_report_photo(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.report_photos rp
    where rp.storage_path = object_name
      and (
        (rp.is_public and public.report_is_public(rp.report_id))
        or public.owns_report(rp.report_id)
        or public.is_moderator()
      )
  );
$$;

create policy "report-photos: upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'report-photos' and public.can_upload_report_photo(name));

create policy "report-photos: read" on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'report-photos'
    and (
      public.can_read_report_photo(name)
      or owner_id = (select auth.uid()::text)
    )
  );

create policy "report-photos: moderators delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'report-photos' and public.is_moderator());

-- -----------------------------------------------------------------------------
-- Realtime: owners/moderators get live status + timeline changes (RLS applies)
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.reports, public.report_updates;
  end if;
end;
$$;
