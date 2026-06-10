-- ════════════════════════════════════════════════════════════════
-- Fix: replace partial unique index with a regular unique constraint
-- so PostgREST can use it as an ON CONFLICT target in scans-save.
-- Date: 2026-06-10
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════

drop index if exists public.ux_product_scans_user_client_record;

alter table public.product_scans
  drop constraint if exists ux_product_scans_user_client_record;

alter table public.product_scans
  add constraint ux_product_scans_user_client_record
  unique (user_email, client_record_id);

-- PG 15+ defaults to NULLS DISTINCT, so multiple rows with NULL
-- client_record_id remain allowed — only (email, non-null id) collisions
-- are blocked. Same dedupe behavior as the previous partial index, but
-- PostgREST can now infer this constraint for on_conflict.
