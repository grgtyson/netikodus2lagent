create table test_conversations (
  id uuid primary key default gen_random_uuid(),
  product_type text,
  model text,
  ended boolean not null default false,
  created_at timestamptz not null default now()
);

create table test_messages (
  id uuid primary key default gen_random_uuid(),
  test_conversation_id uuid not null references test_conversations(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create index test_messages_conversation_idx on test_messages (test_conversation_id);
