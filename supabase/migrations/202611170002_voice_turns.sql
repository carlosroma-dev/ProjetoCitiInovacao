create table if not exists patio_voz.conversation_turns (
  round_id uuid not null,
  conversation_id uuid not null,
  turn_id uuid not null,
  reply jsonb not null check (jsonb_typeof(reply) = 'object'),
  created_at timestamptz not null default now(),
  primary key (conversation_id, turn_id),
  foreign key (round_id, conversation_id) references patio_voz.conversations(round_id, id) on delete cascade
);

create index if not exists conversation_turns_rate_idx on patio_voz.conversation_turns(conversation_id, created_at desc);
