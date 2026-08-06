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
  -- chunk id -> page number. Evidence cites a chunk; without this map a shared
  -- permalink can only tell a stranger the quote came from "c7", which cites
  -- nothing they can look up.
  chunk_pages jsonb not null default '{}'::jsonb,
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
--
-- `is_owner` is the one thing said about ownership, and it only ever tells you
-- about yourself. The client needs it because writes go to the table under the
-- owner policy: without it the app would offer merge and split controls to a
-- stranger and then swallow every save as a zero-row update.

-- Dropped first because `create or replace` cannot change a return type, and
-- this signature has grown since it was first written.
drop function if exists graphread.graph_by_slug(text);

create or replace function graphread.graph_by_slug(p_slug text)
returns table (
  slug text, doc_name text, nodes jsonb, edges jsonb,
  corrections jsonb, chunk_pages jsonb, stats jsonb,
  created_at timestamptz, is_owner boolean
)
language sql stable security definer
set search_path = graphread, public
as $$
  select g.slug, g.doc_name, g.nodes, g.edges, g.corrections, g.chunk_pages,
         g.stats, g.created_at, g.owner_id = auth.uid()
  from graphread.graphs g
  where g.slug = p_slug;
$$;

grant select, insert, update, delete on graphread.graphs to authenticated;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, which is backwards for a
-- SECURITY DEFINER function: the marker exists precisely because the function
-- runs with more privilege than its caller, so the caller list should be stated
-- rather than inherited. This accessor is the only way into a table with no
-- select policy, so it says who may call it.
revoke all on function graphread.graph_by_slug(text) from public;
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
