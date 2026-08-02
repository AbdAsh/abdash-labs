-- Recto: multi-document notebooks with cross-document cited retrieval.
-- Depends on 0001_platform.sql for the `vector` extension in `extensions`.

create schema if not exists recto;
grant usage on schema recto to anon, authenticated, service_role;

create table recto.notebooks (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title      text not null default 'Untitled notebook',
  created_at timestamptz not null default now()
);

create table recto.documents (
  id           uuid primary key default gen_random_uuid(),
  notebook_id  uuid not null references recto.notebooks(id) on delete cascade,
  owner_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name         text not null,
  content_hash text not null,
  page_count   int,
  status       text not null default 'ready',
  is_rtl       boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (notebook_id, content_hash)      -- kills silent duplicate uploads
);

create table recto.chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references recto.documents(id) on delete cascade,
  owner_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  content     text not null,
  page        int,
  chunk_index int not null,
  embedding   extensions.halfvec(1536)
);

create table recto.conversations (
  id          uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references recto.notebooks(id) on delete cascade,
  owner_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title       text,
  created_at  timestamptz not null default now()
);

create table recto.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references recto.conversations(id) on delete cascade,
  owner_id        uuid not null references auth.users(id) on delete cascade default auth.uid(),
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  citations       jsonb,
  created_at      timestamptz not null default now()
);

create index chunks_embedding_idx on recto.chunks
  using hnsw (embedding extensions.halfvec_cosine_ops);
create index chunks_document_id_idx  on recto.chunks (document_id);
create index documents_notebook_idx  on recto.documents (notebook_id);
create index messages_conversation_idx on recto.messages (conversation_id, created_at);

-- RLS: identical shape on all five tables.
do $$
declare t text;
begin
  foreach t in array array['notebooks','documents','chunks','conversations','messages'] loop
    execute format('alter table recto.%I enable row level security', t);
    execute format($p$
      create policy %I_own on recto.%I for all to authenticated
        using (owner_id = auth.uid()) with check (owner_id = auth.uid())
    $p$, t, t);
    execute format('grant select, insert, update, delete on recto.%I to authenticated', t);
  end loop;
end $$;

-- Retrieval across every document in a notebook. security invoker + the caller's
-- JWT means RLS scopes this automatically; there is no owner filter to forget.
create or replace function recto.match_chunks(
  query_embedding extensions.halfvec(1536),
  match_count int,
  nb uuid
)
returns table (id uuid, content text, page int, document_name text, similarity float)
language sql stable security invoker
set search_path = recto, extensions, public
as $$
  select c.id, c.content, c.page, d.name,
         1 - (c.embedding <=> query_embedding) as similarity
  from recto.chunks c
  join recto.documents d on d.id = c.document_id
  where d.notebook_id = nb
  order by c.embedding <=> query_embedding asc
  limit match_count;
$$;

grant execute on function recto.match_chunks(extensions.halfvec, int, uuid) to authenticated;
