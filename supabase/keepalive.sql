-- NOT YET APPLIED. Run this BEFORE deploying api/keepalive.js — until the
-- table exists every scheduled ping fails, and the project is back to pausing.
-- Every statement is idempotent, so re-running is harmless.
--
-- ---------------------------------------------------------------------------
-- Keeps the free-plan project from being paused for inactivity.
--
-- Supabase pauses Free Plan projects that see too little database activity over
-- 7 days. A coming-soon page can go a week without a single form submission, and
-- once paused every /api/submit insert fails until someone restores it by hand.
--
-- api/keepalive.js runs on a Vercel cron (see vercel.json) and upserts the one
-- row in this table, so there is real write traffic every day whether or not
-- anyone fills in a form. pinged_at doubles as "last successful ping".
--
-- Supabase dashboard → SQL Editor → paste → Run.

-- 1. One row, ever. The check constraint means the upsert can only ever
--    overwrite id=1, so the table cannot grow.
create table if not exists public.keepalive (
  id        smallint primary key check (id = 1),
  pinged_at timestamptz not null default now()
);

-- 2. Same lockdown as contacts/signups (see revoke-anon-insert.sql): RLS on,
--    no policies, no grants for the public roles. Only service_role, which
--    bypasses RLS, can touch it.
alter table public.keepalive enable row level security;
revoke all on public.keepalive from anon, authenticated;

-- 3. Explicit, in case this project's default privileges don't grant new
--    tables to service_role automatically.
grant select, insert, update on public.keepalive to service_role;

-- 4. Seed the row and make the REST API see the new table straight away.
insert into public.keepalive (id) values (1) on conflict (id) do nothing;
notify pgrst, 'reload schema';

-- 5. Verify: one row. After the first cron run, pinged_at should be recent.
select * from public.keepalive;
