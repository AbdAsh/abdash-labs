-- Table privileges for `service_role` in the `platform` schema.
--
-- 0001 granted `usage on schema platform to ... service_role` and stopped there.
-- That is not enough: schema usage lets a role *reach* a table, not read it.
-- Supabase auto-grants table privileges to service_role on `public` only, so in
-- a custom schema the role arrives with nothing and every query fails 42501.
--
-- This was invisible until the first live request. `platform-health` returned
-- "permission denied for table quota_limits", and the concierge rate limiter
-- would have failed the same way the first time an anonymous visitor spoke to it
-- — on the one endpoint with no authenticated caller to fall back on.
--
-- Deliberately narrow rather than `grant all on all tables in schema platform`.
-- service_role bypasses RLS entirely, so every privilege handed to it is a
-- policy that no longer applies. There are exactly two legitimate serviceClient()
-- call sites in this codebase and between them they need three verbs on two
-- tables; the rest of the schema stays unreachable to it, which keeps the
-- blast radius of a leaked service key smaller than "everything".
--
-- Notably absent: platform.profiles and platform.usage_counters. Quota
-- enforcement never needs the service role — consume_quota is SECURITY DEFINER
-- and runs through the caller's own client, which is what lets it read their
-- tier from their own JWT.

-- platform-health: touches Postgres so the free-tier inactivity timer resets.
grant select on platform.quota_limits to service_role;

-- concierge-turn: per-IP buckets for the one unauthenticated surface. Reads the
-- current count, inserts a new window, increments an existing one.
grant select, insert, update on platform.rate_limits to service_role;
