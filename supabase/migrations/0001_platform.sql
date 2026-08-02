create extension if not exists vector with schema extensions;

create schema if not exists platform;
grant usage on schema platform to anon, authenticated, service_role;

create table platform.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

create table platform.quota_limits (
  app   text not null,
  tier  text not null check (tier in ('anon', 'linked')),
  key   text not null,
  value int  not null,
  primary key (app, tier, key)
);

create table platform.usage_counters (
  user_id      uuid not null references auth.users(id) on delete cascade,
  app          text not null,
  key          text not null,
  window_start date not null,
  count        int  not null default 0,
  primary key (user_id, app, key, window_start)
);

-- Per-IP buckets for unauthenticated surfaces (the concierge). Service role only.
create table platform.rate_limits (
  bucket       text        not null,
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (bucket, window_start)
);

alter table platform.profiles       enable row level security;
alter table platform.quota_limits   enable row level security;
alter table platform.usage_counters enable row level security;
alter table platform.rate_limits    enable row level security;

create policy profiles_own on platform.profiles
  for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy quota_limits_read on platform.quota_limits
  for select to authenticated using (true);

create policy usage_counters_own on platform.usage_counters
  for select to authenticated using (user_id = auth.uid());

-- rate_limits deliberately has no policy: service role only.

grant select, insert, update on platform.profiles       to authenticated;
grant select                 on platform.quota_limits   to authenticated;
grant select                 on platform.usage_counters to authenticated;

-- A profile row for every new user, including anonymous ones.
create or replace function platform.handle_new_user()
returns trigger language plpgsql security definer set search_path = platform, public as $$
begin
  insert into platform.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function platform.handle_new_user();

-- Tier is derived from the JWT, never passed by the caller.
create or replace function platform.current_tier()
returns text language sql stable set search_path = platform, public as $$
  select case
    when coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then 'anon'
    else 'linked'
  end;
$$;

-- Resource caps (notebooks, documents): returns the caller's limit, -1 if unconfigured.
create or replace function platform.quota_for(p_app text, p_key text)
returns int language plpgsql stable security definer
set search_path = platform, public as $$
declare v_limit int;
begin
  if auth.uid() is null then return -1; end if;
  select value into v_limit from platform.quota_limits
   where app = p_app and key = p_key and tier = platform.current_tier();
  return coalesce(v_limit, -1);
end $$;

-- Daily rate limits. Atomic: increments, then rolls back if it broke the cap.
create or replace function platform.consume_quota(p_app text, p_key text, p_amount int default 1)
returns boolean language plpgsql security definer
set search_path = platform, public as $$
declare
  v_uid   uuid := auth.uid();
  v_limit int;
  v_count int;
begin
  if v_uid is null then return false; end if;

  select value into v_limit from platform.quota_limits
   where app = p_app and key = p_key and tier = platform.current_tier();
  if v_limit is null then return false; end if;  -- fail closed on misconfiguration

  insert into platform.usage_counters (user_id, app, key, window_start, count)
       values (v_uid, p_app, p_key, current_date, p_amount)
  on conflict (user_id, app, key, window_start)
    do update set count = platform.usage_counters.count + p_amount
    returning count into v_count;

  if v_count > v_limit then
    update platform.usage_counters set count = count - p_amount
     where user_id = v_uid and app = p_app and key = p_key and window_start = current_date;
    return false;
  end if;

  return true;
end $$;

grant execute on function platform.quota_for(text, text)            to authenticated;
grant execute on function platform.consume_quota(text, text, int)   to authenticated;

insert into platform.quota_limits (app, tier, key, value) values
  ('recto',     'anon',   'notebooks',   1), ('recto',     'linked', 'notebooks',    3),
  ('recto',     'anon',   'documents',   3), ('recto',     'linked', 'documents',   10),
  ('recto',     'anon',   'messages',   20), ('recto',     'linked', 'messages',   200),
  ('critiq',    'anon',   'reviews',     1), ('critiq',    'linked', 'reviews',      3),
  ('raglab',    'anon',   'runs',        2), ('raglab',    'linked', 'runs',        10),
  ('graphread', 'anon',   'extractions', 1), ('graphread', 'linked', 'extractions',  5),
  ('asksheet',  'anon',   'plans',      20), ('asksheet',  'linked', 'plans',      100)
on conflict do nothing;
