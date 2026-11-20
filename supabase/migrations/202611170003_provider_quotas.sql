create table if not exists patio_voz.groq_conversation_usage (
  conversation_id uuid primary key references patio_voz.conversations(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0)
);

create table if not exists patio_voz.elevenlabs_turn_usage (
  conversation_id uuid not null,
  turn_id uuid not null,
  attempts integer not null default 0 check (attempts between 0 and 3),
  primary key (conversation_id, turn_id),
  foreign key (conversation_id, turn_id) references patio_voz.conversation_turns(conversation_id, turn_id) on delete cascade
);
