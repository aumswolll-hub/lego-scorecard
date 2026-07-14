-- Weekly digest opt-out preferences (Watchtower v1).
-- Default = enabled for everyone with scan activity; a row is only created
-- when someone unsubscribes (or we later add explicit settings).
create table if not exists scanner_email_prefs (
  email text primary key,
  digest_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table scanner_email_prefs enable row level security;
-- Service role only (no anon policies) — API layer is the gate.
