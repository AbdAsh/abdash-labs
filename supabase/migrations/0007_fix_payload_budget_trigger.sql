-- Fix: the payload-budget trigger could never fire on `raglab.experiments`.
--
-- 0004 picked the column to measure with a CASE over the trigger argument:
--
--   v_json jsonb := case tg_argv[0] when 'results' then new.results
--                                   else new.questions end;
--
-- PL/pgSQL resolves record field references in that expression regardless of
-- which branch wins, so `new.results` is looked up even when the trigger is
-- attached to `experiments`, a table with no such column. Every insert into
-- `raglab.experiments` therefore failed with
--
--   record "new" has no field "results"
--
-- which is a total outage of the app's write path, not a budget edge case. It
-- was invisible to every test: the SQL parses, the function creates cleanly, and
-- nothing detects it until a row is actually inserted on a live database.
--
-- The RLS suite did catch it, but reported it as `Cannot read properties of null
-- (reading 'id')` — the insert returned no row and the test read `.id` off it.
-- Worth noting for the harness: destructuring only `data` and ignoring `error`
-- turns a precise database message into a null-pointer three lines later.
--
-- The fix reads the column dynamically off the record's jsonb projection, so the
-- one function serves both tables without naming a field that may not exist.

create or replace function raglab.enforce_payload_budget()
returns trigger
language plpgsql
set search_path = raglab, public, pg_temp
as $$
declare
  v_field text  := tg_argv[0];
  v_cap   int   := case v_field when 'results' then 262144 else 65536 end;
  v_json  jsonb := to_jsonb(new) -> v_field;
  v_bytes int;
begin
  -- A missing or null column is not this trigger's business to reject; the
  -- table's own NOT NULL constraint owns that, and says so more clearly.
  if v_json is null then return new; end if;

  v_bytes := octet_length(v_json::text);
  if v_bytes > v_cap then
    raise exception
      'raglab.%.% is % bytes, above the % byte cap. Embeddings belong in IndexedDB, not Postgres.',
      tg_table_name, v_field, v_bytes, v_cap
      using errcode = 'check_violation';
  end if;

  return new;
end $$;
