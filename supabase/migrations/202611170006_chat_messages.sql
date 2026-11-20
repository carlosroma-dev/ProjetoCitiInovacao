alter table patio_voz.conversations
  add column chat_reply_claim_id uuid,
  add column chat_reply_claim_until timestamptz,
  add constraint chat_reply_claim_pair check ((chat_reply_claim_id is null) = (chat_reply_claim_until is null));

create table patio_voz.chat_messages (
  round_id uuid not null,
  conversation_id uuid not null,
  id uuid not null,
  text text not null check (length(text) between 1 and 1800),
  created_at timestamptz not null default clock_timestamp(),
  batch_turn_id uuid,
  primary key (round_id, conversation_id, id),
  foreign key (round_id, conversation_id) references patio_voz.conversations(round_id, id) on delete cascade
);

create index chat_messages_order_idx on patio_voz.chat_messages(round_id, conversation_id, created_at, id);
create index chat_messages_batch_idx on patio_voz.chat_messages(round_id, conversation_id, batch_turn_id)
  where batch_turn_id is not null;
