-- ════════════════════════════════════════════════════════════════
-- Migration: Scan History v1 + Admin Intelligence v1
-- Date: 2026-06-10
-- Run manually in Supabase SQL Editor.
-- Safe to re-run (uses IF NOT EXISTS).
-- ════════════════════════════════════════════════════════════════

-- ── Table: product_scans ────────────────────────────────────────
create table if not exists public.product_scans (
  id               uuid primary key default gen_random_uuid(),

  -- Identity: this app keys users by email (magic-link OR Supabase Auth).
  -- user_id is recorded ONLY when a Supabase Auth user is present.
  user_email       text not null,
  user_id          uuid null references auth.users(id) on delete set null,

  -- Client-side idempotency key (Date.now() from browser record).
  -- Used to dedupe re-renders / accidental double saves.
  client_record_id bigint null,

  -- Which scoring path produced this row.
  mode             text check (mode in ('validation','discovery')) default 'validation',

  product_name     text,
  product_id       text,
  shop_name        text,
  category         text,

  commission_rate  numeric,
  orders_7d        integer,
  orders_30d       integer,
  ctr              numeric,
  atc_7d           integer,
  atc_30d          integer,
  stock            integer,
  reviews_count    integer,
  rating           numeric,

  score_total      numeric,
  score_max        numeric,
  score_pct        numeric,

  decision         text,

  strengths        text[],
  weaknesses       text[],
  ai_summary       text,

  raw_scan_result  jsonb,
  screenshot_path  text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Normalize email on write.
create or replace function public.product_scans_normalize_email()
returns trigger
language plpgsql
as $$
begin
  if new.user_email is not null then
    new.user_email := lower(trim(new.user_email));
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_product_scans_normalize on public.product_scans;
create trigger trg_product_scans_normalize
before insert or update on public.product_scans
for each row execute function public.product_scans_normalize_email();

-- ── Indexes ─────────────────────────────────────────────────────
create index if not exists idx_product_scans_user_email   on public.product_scans (user_email);
create index if not exists idx_product_scans_created_desc on public.product_scans (created_at desc);
create index if not exists idx_product_scans_decision     on public.product_scans (decision);
create index if not exists idx_product_scans_category     on public.product_scans (category);
create index if not exists idx_product_scans_score        on public.product_scans (score_total);

-- Dedupe: same user + same client_record_id = same save.
create unique index if not exists ux_product_scans_user_client_record
  on public.product_scans (user_email, client_record_id)
  where client_record_id is not null;

-- ── RLS ─────────────────────────────────────────────────────────
-- Service role bypasses RLS — that's how /api/scans-* reach this table.
-- For anon/authenticated, we deny everything (defense in depth).
-- The optional Supabase-Auth policies below let a logged-in Supabase Auth
-- user reach their own rows directly IF you ever add a browser client.
alter table public.product_scans enable row level security;

drop policy if exists "scans_select_own"  on public.product_scans;
drop policy if exists "scans_insert_own"  on public.product_scans;
drop policy if exists "scans_update_own"  on public.product_scans;
drop policy if exists "scans_delete_own"  on public.product_scans;

create policy "scans_select_own" on public.product_scans
  for select to authenticated
  using (auth.uid() is not null and user_id = auth.uid());

create policy "scans_insert_own" on public.product_scans
  for insert to authenticated
  with check (auth.uid() is not null and user_id = auth.uid());

create policy "scans_update_own" on public.product_scans
  for update to authenticated
  using (auth.uid() is not null and user_id = auth.uid())
  with check (auth.uid() is not null and user_id = auth.uid());

create policy "scans_delete_own" on public.product_scans
  for delete to authenticated
  using (auth.uid() is not null and user_id = auth.uid());

-- ── Table: admin_users (keyed by email — matches rest of app) ───
create table if not exists public.admin_users (
  email      text primary key,
  user_id    uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create or replace function public.admin_users_normalize_email()
returns trigger
language plpgsql
as $$
begin
  if new.email is not null then
    new.email := lower(trim(new.email));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_admin_users_normalize on public.admin_users;
create trigger trg_admin_users_normalize
before insert or update on public.admin_users
for each row execute function public.admin_users_normalize_email();

alter table public.admin_users enable row level security;

drop policy if exists "admin_users_no_anon" on public.admin_users;
-- No policies for anon/authenticated → table is invisible except via service role.

-- ── MANUAL STEP after running this file: add your admin email.
-- Run this separately so the email isn't hardcoded into the migration:
--
--   insert into public.admin_users (email) values ('aumswolll@gmail.com')
--   on conflict (email) do nothing;
--
-- ════════════════════════════════════════════════════════════════
