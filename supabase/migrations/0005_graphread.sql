-- GraphRead: one row per saved graph.
--
-- Nodes and edges are JSONB in a single row rather than normalized tables. A
-- graph is always read whole and never queried by node, so normalizing would
-- buy nothing and cost a permalink several round trips instead of one.

create schema if not exists graphread;
grant usage on schema graphread to anon, authenticated, service_role;

create table graphread.graphs (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  owner_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  doc_name    text not null,
  doc_path    text,
  nodes       jsonb not null,
  edges       jsonb not null,
  corrections jsonb not null default '[]'::jsonb,
  stats       jsonb,
  created_at  timestamptz not null default now()
);

create index graphs_owner_created_idx on graphread.graphs (owner_id, created_at desc);

alter table graphread.graphs enable row level security;

-- Owner-only write. `with check` on the same predicate stops a user inserting
-- or re-assigning a row to somebody else's id.
create policy graphs_own on graphread.graphs for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Deliberately NO public select policy.
--
-- A permalink has to open for a stranger, and the obvious `for select using
-- (true)` achieves that — but RLS cannot see that a client filtered by slug, so
-- it grants the entire table. Anyone could run `select owner_id, doc_name from
-- graphread.graphs` and enumerate every document every user has ever graphed.
--
-- Access by slug goes through a SECURITY DEFINER accessor instead, putting the
-- filter inside the security boundary. owner_id is never returned: a permalink
-- reveals the graph, not who made it.
create or replace function graphread.graph_by_slug(p_slug text)
returns table (
  slug text, doc_name text, nodes jsonb, edges jsonb,
  corrections jsonb, stats jsonb, created_at timestamptz
)
language sql stable security definer
set search_path = graphread, public
as $$
  select g.slug, g.doc_name, g.nodes, g.edges, g.corrections, g.stats, g.created_at
  from graphread.graphs g
  where g.slug = p_slug;
$$;

grant select, insert, update, delete on graphread.graphs to authenticated;
grant execute on function graphread.graph_by_slug(text) to anon, authenticated;

-- A second meter for the extraction Edge Function. `extractions` (seeded in
-- 0001) is the per-document allowance charged once per run; `chunks` is charged
-- on every call, so a client that misreports its chunk index to dodge the
-- document charge still hits a hard ceiling. 80 chunks covers one 60-page
-- document at ~2500 chars per chunk with room to spare.
insert into platform.quota_limits (app, tier, key, value) values
  ('graphread', 'anon',   'chunks',  80),
  ('graphread', 'linked', 'chunks', 400)
on conflict do nothing;
