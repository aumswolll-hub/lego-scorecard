-- ════════════════════════════════════════════════════════════════
-- LEGO METHOD — Phase 2: Offer catalog (PR-2.0)
-- Date: 2026-06-16
-- Run manually in Supabase SQL Editor — STAGING first, then production.
-- (Production apply is human-gated; this file is never applied autonomously.)
--
-- ADDITIVE ONLY. Seeds/activates plan rows in the EXISTING `scanner_plans`
-- config table (created by 2026-06-14_entitlements_phase1.sql). Does NOT alter
-- schema and does NOT touch the founding pass row. Safe to re-run.
--
-- IMPORTANT — these rows ship INACTIVE (`is_active=false`, `stripe_price_id=null`)
-- on purpose. No grant path goes live until the founder, by hand:
--   1) creates the Stripe (Test-Mode first) price for the offer,
--   2) sets `stripe_price_id` on the row,
--   3) confirms the scan quota (`included_scans_per_month`) — part of the offer
--      promise, a FOUNDER decision (CLAUDE.md §10), and
--   4) flips `is_active=true`.
-- Until then `api/_offer-resolve.mjs` cannot resolve a grant from these rows.
-- ════════════════════════════════════════════════════════════════

-- Offer 1 — LEGO SCANNER (5,900 THB, one-time, 12-month scanner access).
-- NOTE: included_scans_per_month is a PLACEHOLDER pending founder confirmation
-- (legacy scanner_paid = 100; founding pass = 300). Confirm before activating.
insert into public.scanner_plans
  (plan_code, display_name, billing_type, access_duration_days,
   included_scans_per_month, is_founding, is_active, feature_flags)
values
  ('lego_scanner', 'LEGO SCANNER (12-month)', 'one_time', 365,
   100, false, false, '{"scanner": true}'::jsonb)
on conflict (plan_code) do nothing;

-- Offer 2 — LEGO METHOD (14,900 THB, one-time, open-ended access).
-- access_duration_days = null → open-ended (OPEN_DECISION #10).
-- Method implies scanner access; quota PLACEHOLDER (legacy lego_method = 300).
insert into public.scanner_plans
  (plan_code, display_name, billing_type, access_duration_days,
   included_scans_per_month, is_founding, is_active, feature_flags)
values
  ('lego_method', 'LEGO METHOD', 'one_time', null,
   300, false, false, '{"scanner": true, "method": true}'::jsonb)
on conflict (plan_code) do nothing;

-- Offer 3 — LEGO PRIVATE SPRINT (59,900 THB).
-- This is a CONFIG marker only. It is NEVER a grant-on-payment path: access is
-- application-only + founder-approved (CLAUDE.md §2/§3/§10). included_scans null;
-- feature_flags marks it non-granting so resolution can refuse to auto-grant it.
insert into public.scanner_plans
  (plan_code, display_name, billing_type, access_duration_days,
   included_scans_per_month, is_founding, is_active, feature_flags)
values
  ('lego_private_sprint', 'LEGO PRIVATE SPRINT', 'one_time', null,
   null, false, false, '{"application_only": true, "grants_on_payment": false}'::jsonb)
on conflict (plan_code) do nothing;

-- (Channel Diagnosis 1,990 is intentionally NOT seeded — it must not be a live
--  grant path; disposition tracked at docs/11_OPEN_DECISIONS.md #6.)

-- ════════════════════════════════════════════════════════════════
-- ACTIVATION (founder, per offer, after creating the Stripe price):
--   update public.scanner_plans
--      set stripe_price_id = '<price_xxx>', stripe_product_id = '<prod_xxx>',
--          included_scans_per_month = <confirmed>, is_active = true, updated_at = now()
--    where plan_code = 'lego_scanner';     -- (and 'lego_method')
--   -- NEVER activate 'lego_private_sprint' as a grant path.
--
-- VERIFICATION (staging):
--   select plan_code, is_active, stripe_price_id, included_scans_per_month
--     from public.scanner_plans order by plan_code;
--
-- ROLLBACK (removes only these seed rows; founding pass untouched):
--   delete from public.scanner_plans
--    where plan_code in ('lego_scanner','lego_method','lego_private_sprint');
-- ════════════════════════════════════════════════════════════════
