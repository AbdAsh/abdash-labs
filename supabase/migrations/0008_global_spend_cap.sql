-- A cross-user daily ceiling: the control that per-user quotas cannot provide.
--
-- `platform.usage_counters` is keyed (user_id, app, key, window_start), so it can
-- express "this person, today" and structurally cannot express "everyone, today".
-- That gap is the whole exposure. An anonymous account is worth roughly $0.13/day
-- if it spends its full allowance across all apps; Supabase's IP rate limit on
-- anonymous sign-ups is the only thing bounding how many accounts appear, and at
-- 10/hour from a single IP that is still 240 accounts and ~$31/day against a
-- $20/month budget. The IP limit also cannot be tightened much further without
-- refusing real mobile visitors, who sit behind CGNAT in their thousands.
--
-- So the per-user quota bounds one attacker and places no ceiling on a thousand
-- of them. This does.
--
-- Caps are sized so that maxing *every* meter on the same day costs about the
-- monthly budget, i.e. the absolute worst case is the number you already agreed
-- to rather than a surprise:
--
--   recto messages   150 x $0.001  = $0.15
--   asksheet plans   200 x $0.0005 = $0.10
--   critiq reviews    10 x $0.010  = $0.10
--   raglab runs        6 x $0.030  = $0.18
--   graphread extr.    5 x $0.030  = $0.15
--                                   -------
--                                    $0.68/day  ~ $20/month
--
-- Values live in a table, so tightening after a real traffic week is an UPDATE
-- rather than a deploy.

create table platform.global_limits (
  app   text not null,
  key   text not null,
  value int  not null,
  primary key (app, key)
);

create table platform.global_counters (
  app          text not null,
  key          text not null,
  window_start date not null,
  count        int  not null default 0,
  primary key (app, key, window_start)
);

-- No grants and no policies. Nothing reads these directly: `consume_quota` is
-- SECURITY DEFINER and reaches them with the owner's rights, so leaving the
-- tables unreachable costs nothing and means a leaked anon key cannot even
-- enumerate how close the platform is to its ceiling.
alter table platform.global_limits   enable row level security;
alter table platform.global_counters enable row level security;

insert into platform.global_limits (app, key, value) values
  ('recto',     'messages',    150),
  ('asksheet',  'plans',       200),
  ('critiq',    'reviews',      10),
  ('raglab',    'runs',          6),
  ('graphread', 'extractions',   5),
  ('graphread', 'chunks',      400)
on conflict do nothing;

-- Why a status rather than a boolean.
--
-- "You have used your 20 messages, sign in for 200" and "the whole platform is
-- out of budget until tomorrow" are different facts, and the first is actively
-- misleading advice when the second is true — a visitor who signs in still gets
-- nothing. The caller needs to tell them apart, so this returns which ceiling
-- was hit. `consume_quota` stays a boolean wrapper so existing callers are
-- untouched.
create or replace function platform.consume_quota_status(
  p_app text, p_key text, p_amount int default 1
)
returns text
language plpgsql security definer
set search_path = platform, public, pg_temp as $$
declare
  v_uid    uuid := auth.uid();
  v_limit  int;
  v_count  int;
  v_gcap   int;
  v_gcount int;
begin
  if v_uid is null then return 'no_session'; end if;

  select value into v_limit from platform.quota_limits
   where app = p_app and key = p_key and tier = platform.current_tier();
  if v_limit is null then return 'unconfigured'; end if;   -- fail closed

  insert into platform.usage_counters (user_id, app, key, window_start, count)
       values (v_uid, p_app, p_key, current_date, p_amount)
  on conflict (user_id, app, key, window_start)
    do update set count = platform.usage_counters.count + p_amount
    returning count into v_count;

  if v_count > v_limit then
    update platform.usage_counters set count = count - p_amount
     where user_id = v_uid and app = p_app and key = p_key and window_start = current_date;
    return 'user_limit';
  end if;

  -- Global ceiling. Absent means uncapped, which is deliberate: a key with no
  -- row here is one whose marginal cost is zero (nothing today), and inventing a
  -- default would silently throttle a free operation.
  select value into v_gcap from platform.global_limits
   where app = p_app and key = p_key;

  if v_gcap is not null then
    insert into platform.global_counters (app, key, window_start, count)
         values (p_app, p_key, current_date, p_amount)
    on conflict (app, key, window_start)
      do update set count = platform.global_counters.count + p_amount
      returning count into v_gcount;

    if v_gcount > v_gcap then
      -- Roll back BOTH meters. Charging the user for a request the platform
      -- refused would spend their daily allowance on nothing.
      update platform.global_counters set count = count - p_amount
       where app = p_app and key = p_key and window_start = current_date;
      update platform.usage_counters set count = count - p_amount
       where user_id = v_uid and app = p_app and key = p_key and window_start = current_date;
      return 'global_limit';
    end if;
  end if;

  return 'ok';
end $$;

-- Boolean wrapper, unchanged contract for every existing caller.
create or replace function platform.consume_quota(p_app text, p_key text, p_amount int default 1)
returns boolean
language sql security definer
set search_path = platform, public, pg_temp as $$
  select platform.consume_quota_status(p_app, p_key, p_amount) = 'ok';
$$;

revoke all on function platform.consume_quota_status(text, text, int) from public;
revoke all on function platform.consume_quota(text, text, int)        from public;
grant execute on function platform.consume_quota_status(text, text, int) to authenticated;
grant execute on function platform.consume_quota(text, text, int)        to authenticated;
