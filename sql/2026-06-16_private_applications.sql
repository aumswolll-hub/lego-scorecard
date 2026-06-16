-- ════════════════════════════════════════════════════════════════
-- LEGO METHOD — Phase 2: Private Sprint applications (PR-2.5)
-- Date: 2026-06-16
-- Run manually in Supabase SQL Editor — STAGING first, then production.
-- (Production apply is human-gated; never applied autonomously.)
--
-- ADDITIVE ONLY. One new table. Safe to re-run (IF NOT EXISTS / guarded policy).
-- Rollback = DROP the table + its function (see footer).
--
-- Path D leads APPLY here. Access is application-only + founder-approved + capped
-- at 10/month (CLAUDE.md §2/§3/§10). Software NEVER auto-approves: rows are born
-- 'submitted'; only the admin decision endpoint may move them to approved/declined,
-- and it records WHO decided. No grant of Sprint access happens on payment.
--
-- submission_id is a LOOSE link (no FK) to scorecard_submissions so this migration
-- is independent of the Phase-1 apply order, mirroring scorecard_events.
-- ════════════════════════════════════════════════════════════════

create table if not exists public.private_applications (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid,                       -- loose link to scorecard_submissions (no FK)
  user_id           uuid,                       -- supabase auth user, when present
  email             text not null,
  tiktok_handle     text,
  preferred_contact text,                       -- line | phone | email
  contact_value     text,
  notes             text,
  intake            jsonb not null default '{}'::jsonb,
  status            text not null default 'submitted'
                      check (status in ('submitted','under_review','approved','declined')),
  decided_by        text,                       -- admin email that recorded the founder's decision
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists ix_private_app_email   on public.private_applications (lower(email));
create index if not exists ix_private_app_status  on public.private_applications (status, created_at desc);
create index if not exists ix_private_app_sub      on public.private_applications (submission_id);

create or replace function public.private_applications_touch()
returns trigger language plpgsql as $$
begin
  if new.email is not null then new.email := lower(trim(new.email)); end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_private_app_touch on public.private_applications;
create trigger trg_private_app_touch
before insert or update on public.private_applications
for each row execute function public.private_applications_touch();

-- ── RLS ──────────────────────────────────────────────────────────
-- Server endpoints use the service role. RLS enabled so anon/auth clients can't
-- read the table by default; a logged-in user may read ONLY their own rows.
alter table public.private_applications enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='private_applications'
      and policyname='private_app_select_own'
  ) then
    create policy private_app_select_own on public.private_applications
      for select to authenticated
      using (auth.uid() is not null and user_id = auth.uid());
  end if;
end $$;
-- (No insert/update policy → writes + the founder decision happen only via the
--  service role on the server. Anonymous applications are service-role-read only.)

-- ════════════════════════════════════════════════════════════════
-- VERIFICATION (staging):
--   select rowsecurity from pg_tables where tablename='private_applications';  -- t
--   -- a fresh insert defaults status='submitted'; CHECK rejects any other value
--   --   except via the four allowed states.
-- ROLLBACK:
--   drop table if exists public.private_applications;
--   drop function if exists public.private_applications_touch();
-- ════════════════════════════════════════════════════════════════
