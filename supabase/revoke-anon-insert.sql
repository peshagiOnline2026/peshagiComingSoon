-- ALREADY APPLIED — 2026-08-08. Kept as the record of what changed and why.
-- Re-running is harmless (every statement below is idempotent), but there is
-- nothing outstanding here.
--
-- ---------------------------------------------------------------------------
-- Closed the public write hole on contacts + signups.
--
-- The landing page used to insert straight from the browser with the anon key,
-- so the RLS policy had to allow anonymous INSERT. That made
-- https://<project>.supabase.co/rest/v1/contacts a public write endpoint —
-- reachable by curl, without ever loading the site. It was the source of the
-- spam: dot-scrambled gmail addresses, random-string names, and one SEO outfit
-- posting under three fake identities that shared a phone number.
--
-- All writes now go through /api/submit (api/submit.js) using the service_role
-- key, which bypasses RLS. Verified after applying: an anon-key POST straight
-- to /rest/v1/contacts returns 42501 permission denied.
--
-- Ordering note, if this is ever replayed on a new environment: deploy and
-- verify /api/submit FIRST. Running this against a site that still inserts
-- from the browser takes the live forms down.
--
-- Supabase dashboard → SQL Editor → paste → Run.

-- 1. What can anon do today? Run this first and read the output.
select tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('contacts', 'signups')
order by tablename, policyname;

-- 2. Drop the two open INSERT policies. Step 1 confirmed these are the only
--    policies on either table, both `with_check: true` — i.e. anyone holding
--    the anon key could insert anything. Nothing else needs removing.
drop policy if exists "anon can insert contacts" on public.contacts;
drop policy if exists "anon can insert signups"  on public.signups;

-- 3. Belt and braces: revoke the table grants too, so anon has no path in even
--    if a permissive policy is added back by accident later.
revoke all on public.contacts from anon;
revoke all on public.signups  from anon;

-- 4. RLS stays on. With no policies left, anon gets nothing and service_role
--    (which bypasses RLS) keeps working from the serverless function.
alter table public.contacts enable row level security;
alter table public.signups  enable row level security;

-- 5. Verify: this should return zero rows.
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('contacts', 'signups');
