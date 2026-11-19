-- State store for Zone Watch, for a host whose filesystem is wiped on restart.
--
-- Run this once in the Supabase SQL editor, then set these on the service:
--   STATE_STORE=supabase
--   SUPABASE_URL=https://<project>.supabase.co
--   SUPABASE_SERVICE_KEY=<service role key>
--
-- The app writes one row per state file (executor.json, journal.json,
-- settings.json, ...) and restores them all at boot. Nothing else in the
-- database is touched.

create table if not exists public.zone_watch_state (
  key        text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null default now()
);

-- Rows hold broker keys, webhooks and the dashboard password hash, so the table
-- is not readable from a browser. Row level security is on and no policy is
-- created: only the service role key bypasses it, and that key must never leave
-- the server.
alter table public.zone_watch_state enable row level security;

revoke all on table public.zone_watch_state from anon, authenticated;
