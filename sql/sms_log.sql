create table sms_log (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  phone text not null,
  message text not null,
  provider_message_id text,
  created_at timestamptz not null default now()
);

create index sms_log_provider_idx on sms_log (provider);
create index sms_log_created_at_idx on sms_log (created_at);
