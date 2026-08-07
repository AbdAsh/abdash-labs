-- Critiq: SEO and answer-engine review of a single URL.
-- One table. Findings, grades and the digest live in jsonb; no storage bucket is
-- allocated at all, because dropping screenshots dropped the reason for one.

create schema if not exists critiq;
grant usage on schema critiq to anon, authenticated, service_role;

create table critiq.reports (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique not null,
  owner_id   uuid not null references auth.users(id) on delete cascade default auth.uid(),
  url        text not null,
  status     text not null default 'complete' check (status in ('complete', 'failed')),
  grades     jsonb,
  findings   jsonb,
  digest     jsonb,
  created_at timestamptz not null default now()
);

create index reports_owner_idx on critiq.reports (owner_id, created_at desc);

-- Serves the (URL, day) cache lookup that makes a resubmission free.
--
-- Not `(url, (created_at::date))`. Postgres rejects that outright — casting a
-- timestamptz to date is STABLE, not IMMUTABLE, because the result depends on
-- the session TimeZone, and an index expression must be IMMUTABLE (42P17).
--
-- A plain descending column is also the right shape regardless: the lookup asks
-- `url = $1 and created_at >= <start of window>`, which is a range scan. An
-- expression index on the cast would not have served that query even if it had
-- been legal.
create index reports_cache_idx on critiq.reports (url, created_at desc);

alter table critiq.reports enable row level security;

create policy reports_own on critiq.reports for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant select, insert, update, delete on critiq.reports to authenticated;

-- Permalinks, done as a function rather than a policy.
--
-- The obvious version of this is a second policy — `for select using (status =
-- 'complete')` — but RLS cannot see that a client filtered by slug. That policy
-- makes every completed report readable by *any* query, so
-- `select url, owner_id from critiq.reports` enumerates every URL every user has
-- ever submitted. "Public read by slug" is only actually by-slug if the slug is
-- the sole way in, which means a lookup function and no public select policy.
--
-- owner_id is deliberately not returned: a permalink reveals the report, not who
-- ran it.
create or replace function critiq.report_by_slug(p_slug text)
returns table (
  slug       text,
  url        text,
  status     text,
  grades     jsonb,
  findings   jsonb,
  digest     jsonb,
  created_at timestamptz
)
language sql stable security definer
set search_path = critiq, public as $$
  select r.slug, r.url, r.status, r.grades, r.findings, r.digest, r.created_at
  from critiq.reports r
  where r.slug = p_slug
    and r.status = 'complete';
$$;

revoke all on function critiq.report_by_slug(text) from public;
grant execute on function critiq.report_by_slug(text) to anon, authenticated;
