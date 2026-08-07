-- Delete anonymous accounts nobody is coming back to.
--
-- Anonymous-first auth is what lets a visitor try seven apps without signing up,
-- and the cost is a row in auth.users for every person who ever loaded a page.
-- Supabase does not clean these up — their own documentation says to delete them
-- yourself — so without this the table only grows. One day of building and
-- testing produced 107 of them.
--
-- Left alone that is three separate problems: the 50,000 MAU free-tier ceiling,
-- the row and index weight in a 500 MB database shared by seven apps, and the
-- per-user quota counters hanging off each account.
--
-- What is deliberately NOT deleted:
--
--   * Anyone who linked GitHub, Google or an email. Linking flips is_anonymous to
--     false, and the identity check below is a second belt on the same trousers —
--     an account with an identity is somebody's, however it got there.
--   * Anything newer than the window. Seven days is long enough that a visitor who
--     wandered off mid-benchmark and came back after the weekend still finds their
--     work, which is the whole promise of not making them sign up.
--   * Anyone who left something behind. An account with a notebook, a saved
--     benchmark or a graph is one that produced work, and deleting it would delete
--     a permalink somebody may have shared.
--
-- Deletion cascades: every owner_id in every app schema is
-- `references auth.users(id) on delete cascade`, so a purged account takes its
-- rows and quota counters with it and leaves nothing orphaned.

create extension if not exists pg_cron;

create or replace function platform.purge_stale_anonymous_users(p_older_than interval default '7 days')
returns integer
language plpgsql security definer
set search_path = platform, public, pg_temp as $$
declare
  v_deleted integer;
begin
  with doomed as (
    delete from auth.users u
    where u.is_anonymous
      and u.created_at < now() - p_older_than
      -- Never touch an account that has an identity attached.
      and not exists (select 1 from auth.identities i where i.user_id = u.id)
      -- Never touch an account that left work behind.
      and not exists (select 1 from recto.notebooks     n where n.owner_id = u.id)
      and not exists (select 1 from raglab.experiments  e where e.owner_id = u.id)
      and not exists (select 1 from graphread.graphs    g where g.owner_id = u.id)
      and not exists (select 1 from critiq.reports      r where r.owner_id = u.id)
    returning 1
  )
  select count(*) into v_deleted from doomed;

  return v_deleted;
end $$;

revoke all on function platform.purge_stale_anonymous_users(interval) from public;

-- Daily, 03:40 UTC. Off the hour on purpose: shared infrastructure is busiest
-- when everybody schedules at :00.
select cron.schedule(
  'purge-stale-anonymous-users',
  '40 3 * * *',
  $$select platform.purge_stale_anonymous_users()$$
);
