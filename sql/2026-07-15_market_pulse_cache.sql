-- Weekly market-pulse cache (collective intel, category-level only).
create table if not exists market_pulse_cache (
  week_key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table market_pulse_cache enable row level security;
