-- RAG Lab: benchmark configuration, question sets, gold spans and computed metrics.
--
-- What is deliberately NOT here: a vector column. There is no `embedding`, no
-- `halfvec`, no pgvector index anywhere in this schema, and that absence is the
-- central design decision of the app rather than an oversight.
--
-- The arithmetic: a twelve-config run over a hundred-page document produces about
-- 3,600 embeddings, ~11 MB at 1536 dimensions. Forty-five saved runs would consume
-- the entire 500 MB database that all seven lab apps share. Embeddings therefore
-- live in the browser's IndexedDB, keyed by (document fingerprint, chunker,
-- params, model), and the server stores only what a permalink actually needs.
--
-- Budget for this app: 30 MB Postgres, 50 MB Storage.

create schema if not exists raglab;
grant usage on schema raglab to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table raglab.experiments (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  owner_id        uuid not null references auth.users(id) on delete cascade default auth.uid(),
  doc_name        text not null,
  doc_fingerprint text not null,
  doc_path        text,                     -- Storage path; null for local-only runs
  questions       jsonb not null,           -- [{ id, text, gold: { start, end } }]
  created_at      timestamptz not null default now()
);

comment on column raglab.experiments.questions is
  'Question set with gold spans as half-open character ranges into the document text.';

create table raglab.runs (
  id            uuid primary key default gen_random_uuid(),
  experiment_id uuid not null references raglab.experiments(id) on delete cascade,
  owner_id      uuid not null references auth.users(id) on delete cascade default auth.uid(),
  results       jsonb not null,             -- ConfigResult[] — metrics only, NEVER vectors
  created_at    timestamptz not null default now()
);

comment on column raglab.runs.results is
  'Per-config metrics: hit rate, MRR, and short retrieval excerpts. Never embeddings.';

create index experiments_owner_idx on raglab.experiments (owner_id, created_at desc);
create index runs_experiment_idx   on raglab.runs (experiment_id, created_at desc);
create index runs_owner_idx        on raglab.runs (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Structural guard against the one unrecoverable mistake
-- ---------------------------------------------------------------------------
--
-- The client checks its payload before every insert, but a client-side check is
-- advice. This is enforcement, and it is deliberately at the database boundary:
-- once megabytes of floats are committed to a shared 500 MB instance, six other
-- apps have lost their budget and no later commit can give it back.
--
-- A trigger rather than a CHECK constraint because CHECK requires an IMMUTABLE
-- expression, and because a trigger can say *why* the write was refused.

create or replace function raglab.enforce_payload_budget()
returns trigger
language plpgsql
set search_path = raglab, public
as $$
declare
  v_bytes int;
  v_cap   int := case tg_argv[0] when 'results' then 262144 else 65536 end;
  v_json  jsonb := case tg_argv[0] when 'results' then new.results else new.questions end;
begin
  v_bytes := octet_length(v_json::text);
  if v_bytes > v_cap then
    raise exception
      'raglab.%.% is % bytes, above the % byte cap. Embeddings belong in IndexedDB, not Postgres.',
      tg_table_name, tg_argv[0], v_bytes, v_cap
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger runs_payload_budget
  before insert or update on raglab.runs
  for each row execute function raglab.enforce_payload_budget('results');

create trigger experiments_payload_budget
  before insert or update on raglab.experiments
  for each row execute function raglab.enforce_payload_budget('questions');

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- Permalinks require public read, which is intentional and is disclosed in the UI
-- before a run is saved. The "local session only" toggle skips persistence
-- entirely and produces no link. Writes stay owner-scoped: the public policy is
-- `for select` only, so it widens reads without widening updates or deletes.

alter table raglab.experiments enable row level security;
alter table raglab.runs        enable row level security;

create policy experiments_own on raglab.experiments for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy runs_own on raglab.runs for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Deliberately NO public select policy.
--
-- The obvious `for select using (true)` would make permalinks work, but RLS
-- cannot see that a client filtered by slug: it grants the whole table. Anyone
-- could run `select owner_id, doc_name from raglab.experiments` and enumerate
-- every benchmark every user has ever created. A permalink must reveal one
-- experiment, not the existence of all of them.
--
-- Access by slug therefore goes through a SECURITY DEFINER accessor that takes
-- the slug as an argument, so the filter is inside the security boundary rather
-- than in a client the database has to trust. owner_id is never returned.
create or replace function raglab.experiment_by_slug(p_slug text)
returns table (
  id uuid, slug text, doc_name text, doc_fingerprint text, doc_path text,
  questions jsonb, created_at timestamptz, runs jsonb
)
language sql stable security definer
set search_path = raglab, public
as $$
  select e.id, e.slug, e.doc_name, e.doc_fingerprint, e.doc_path,
         e.questions, e.created_at,
         coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', r.id, 'experiment_id', r.experiment_id,
               'results', r.results, 'created_at', r.created_at
             )
             order by r.created_at desc
           ) filter (where r.id is not null),
           '[]'::jsonb
         ) as runs
  from raglab.experiments e
  left join raglab.runs r on r.experiment_id = e.id
  where e.slug = p_slug
  group by e.id, e.slug, e.doc_name, e.doc_fingerprint, e.doc_path, e.questions, e.created_at;
$$;

grant select, insert, update, delete on raglab.experiments, raglab.runs to authenticated;
grant execute on function raglab.experiment_by_slug(text) to anon, authenticated;

-- Dashboard step, not expressible in SQL: add `raglab` under
-- Settings → API → Exposed schemas. Without it PostgREST answers PGRST106 for
-- every query in this schema.
