-- ════════════════════════════════════════════════════════════════
-- Migration: User Product Tracker (Student Dashboard action layer)
-- Date: 2026-06-11
-- Run manually in Supabase SQL Editor.
-- Safe to re-run.
--
-- Purpose: a separate "action layer" on top of product_scans so the
-- student dashboard can persist per-product status / notes / outcomes
-- without touching the scanner's source-of-truth table.
-- ════════════════════════════════════════════════════════════════

create table if not exists public.user_product_tracker (
  id                 uuid primary key default gen_random_uuid(),

  user_email         text not null,
  user_id            text,

  -- product_key = product_id when available, else normalized product_name|shop_name.
  -- Built by /api/dashboard-data.js and /api/tracker-update.js.
  product_key        text not null,

  -- Pointer to the most recent product_scans row this tracker reflects.
  latest_scan_id     uuid,

  user_status        text default 'Not Tested'
    check (user_status in (
      'Not Tested','Testing','Posted','Got Order','No Order','Scaling','Dropped'
    )),
  recommended_action text,

  is_watchlisted     boolean default false,
  is_archived        boolean default false,

  notes              text,
  angle_idea         text,
  hook_idea          text,

  posted_count       integer default 0,
  got_order          boolean default false,
  order_count        integer default 0,
  revenue_estimate   numeric default 0,

  last_action_at     timestamptz default now(),
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- One tracker row per (user, product).
alter table public.user_product_tracker
  drop constraint if exists ux_user_product_tracker_user_product;

alter table public.user_product_tracker
  add constraint ux_user_product_tracker_user_product
  unique (user_email, product_key);

-- Normalize email + bump updated_at on writes.
create or replace function public.user_product_tracker_touch()
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

drop trigger if exists trg_user_product_tracker_touch on public.user_product_tracker;
create trigger trg_user_product_tracker_touch
before insert or update on public.user_product_tracker
for each row execute function public.user_product_tracker_touch();

create index if not exists idx_upt_user_email   on public.user_product_tracker (user_email);
create index if not exists idx_upt_product_key  on public.user_product_tracker (product_key);
create index if not exists idx_upt_user_status  on public.user_product_tracker (user_status);
create index if not exists idx_upt_last_action  on public.user_product_tracker (last_action_at desc);

-- RLS: service role bypasses. Deny direct anon/authenticated access
-- (the API enforces user_email scoping).
alter table public.user_product_tracker enable row level security;

drop policy if exists "upt_no_anon" on public.user_product_tracker;
-- (Intentionally no policies for anon / authenticated.)
