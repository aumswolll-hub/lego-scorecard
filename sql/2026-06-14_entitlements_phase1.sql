-- ════════════════════════════════════════════════════════════════
-- LEGO SCANNER — Entitlements Phase 1 (12-month Founding Pass)
-- 2026-06-14
--
-- ADDITIVE ONLY. Creates new tables; does NOT alter or drop any existing
-- table (customers, scanner_user_usage, sessions, ...). Safe to run multiple
-- times (IF NOT EXISTS / ON CONFLICT). Rollback = DROP the 3 new tables.
--
-- Model: a grant-only, multi-source entitlement layer that runs ALONGSIDE the
-- legacy `customers` table. The resolver (api/_entitlements.js) reads the union
-- of legacy customers (read-only, sovereign) and these new rows. A refunded or
-- expired Scanner pass flips only its own row here — it never writes `customers`,
-- so existing LEGO METHOD / admin / legacy access can never be revoked by it.
-- ════════════════════════════════════════════════════════════════

-- ── 1) Plan configuration (no hardcoded limits in app code) ──────
create table if not exists public.scanner_plans (
  plan_code                 text primary key,
  display_name              text not null,
  stripe_product_id         text,
  stripe_price_id           text,                       -- source of truth for plan resolution
  billing_type              text not null default 'one_time',  -- one_time | recurring_month | recurring_year
  access_duration_days      integer,                    -- 365 for the pass; null = open-ended
  included_scans_per_month  integer,                    -- monthly scan quota while active
  feature_flags             jsonb not null default '{}'::jsonb,
  is_active                 boolean not null default true,
  is_founding               boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- ── 2) Per-source entitlements (grant-only resolver source) ──────
create table if not exists public.user_entitlements (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid,                       -- supabase auth user id (nullable for email-only/legacy)
  email                       text not null,
  entitlement_type            text not null,              -- scanner_access | lego_method_access | admin_access | promotional_access | legacy_access
  product_code                text,                       -- e.g. lego_scanner_founding
  plan_code                   text references public.scanner_plans(plan_code),
  source                      text not null,              -- stripe_one_time | stripe_subscription | lego_method_purchase | admin_grant | legacy_migration | promotion
  source_reference_id         text,
  status                      text not null default 'active',  -- active | trialing | past_due | canceled | expired | refunded | paused
  starts_at                   timestamptz not null default now(),
  ends_at                     timestamptz,                -- null = open-ended; set = expiry (e.g. +12 months)
  cancel_at_period_end        boolean not null default false,
  stripe_customer_id          text,
  stripe_checkout_session_id  text,
  stripe_payment_intent_id    text,
  stripe_price_id             text,
  metadata                    jsonb not null default '{}'::jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists ix_entitlements_email   on public.user_entitlements (lower(email));
create index if not exists ix_entitlements_user_id on public.user_entitlements (user_id);
create index if not exists ix_entitlements_active  on public.user_entitlements (entitlement_type, status, ends_at);

-- Hard idempotency guard: one entitlement per Stripe payment intent.
create unique index if not exists ux_entitlements_payment_intent
  on public.user_entitlements (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- ── 3) Webhook idempotency log ───────────────────────────────────
create table if not exists public.stripe_events (
  stripe_event_id   text primary key,
  event_type        text,
  status            text not null default 'processed',   -- processed | error | ignored
  error_message     text,
  payload_reference text,
  processed_at      timestamptz not null default now()
);

-- ── 4) Row Level Security ────────────────────────────────────────
-- Server endpoints use the service role (bypasses RLS) for all writes.
-- We enable RLS so anon/auth clients cannot read these tables by default;
-- users may read only their own entitlement rows.
alter table public.scanner_plans      enable row level security;
alter table public.user_entitlements  enable row level security;
alter table public.stripe_events      enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_entitlements'
      and policyname = 'own_entitlements_read'
  ) then
    create policy own_entitlements_read on public.user_entitlements
      for select using (auth.uid() = user_id);
  end if;
end $$;
-- (scanner_plans and stripe_events: RLS enabled, no permissive policy →
--  reachable only via the service role on the server.)

-- ── 5) Seed the launch plan (config, not code) ───────────────────
insert into public.scanner_plans
  (plan_code, display_name, billing_type, access_duration_days,
   included_scans_per_month, is_founding, is_active, feature_flags)
values
  ('lego_scanner_founding', 'LEGO SCANNER FOUNDING PASS', 'one_time', 365,
   300, true, true, '{"scanner": true}'::jsonb)
on conflict (plan_code) do nothing;

-- NOTE: set scanner_plans.stripe_price_id once the Stripe one-time price exists:
--   update public.scanner_plans
--      set stripe_price_id = '<price_xxx>', stripe_product_id = '<prod_xxx>', updated_at = now()
--    where plan_code = 'lego_scanner_founding';
