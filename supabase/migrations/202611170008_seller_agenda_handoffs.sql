create table patio_voz.demo_sellers (
  round_id uuid not null references patio_voz.rounds(id) on delete cascade,
  id text not null,
  name text not null,
  primary key (round_id, id)
);

insert into patio_voz.demo_sellers (round_id, id, name)
select r.id, team.id, team.name
from patio_voz.rounds r
cross join (values ('julia', 'Júlia'), ('rafa', 'Rafa')) as team(id, name);

alter table patio_voz.slots add column seller_id text;

update patio_voz.slots
set seller_id = case
  when (starts_at at time zone 'America/Sao_Paulo')::time >= time '14:00' then 'rafa'
  else 'julia'
end;

alter table patio_voz.slots
  alter column seller_id set not null,
  add foreign key (round_id, seller_id) references patio_voz.demo_sellers(round_id, id),
  drop constraint slots_round_id_starts_at_key,
  add unique (round_id, starts_at, seller_id);

create or replace function patio_voz.ensure_future_demo_slots(target_round uuid)
returns void language plpgsql as $$
declare
  local_today date := (now() at time zone 'America/Sao_Paulo')::date;
  saturday date := local_today + ((6 - extract(dow from local_today)::integer + 7) % 7);
begin
  if not exists (select 1 from patio_voz.rounds where id = target_round) then
    return;
  end if;

  insert into patio_voz.demo_sellers (round_id, id, name) values
    (target_round, 'julia', 'Júlia'), (target_round, 'rafa', 'Rafa')
  on conflict (round_id, id) do nothing;

  insert into patio_voz.slots (round_id, starts_at, seller_id)
  select target_round, schedule.starts_at, schedule.seller_id
  from (
    select ((saturday + (weeks.number * 7) + team.start_time) at time zone 'America/Sao_Paulo') as starts_at,
      team.seller_id
    from generate_series(0, 3) as weeks(number)
    cross join (values
      ('julia', time '09:00'), ('julia', time '10:30'),
      ('rafa', time '10:30'), ('rafa', time '14:00')
    ) as team(seller_id, start_time)
  ) schedule
  where schedule.starts_at > now()
  order by schedule.starts_at, schedule.seller_id
  on conflict (round_id, starts_at, seller_id) do nothing;
end $$;

alter table patio_voz.visits add unique (round_id, conversation_id, id);

create table patio_voz.seller_handoffs (
  round_id uuid not null,
  conversation_id uuid not null,
  seller_id text not null,
  car_id uuid,
  car_name text,
  trade_in text,
  budget_cents integer check (budget_cents >= 0),
  preference jsonb check (jsonb_typeof(preference) = 'object'),
  visit_id uuid,
  reason text not null,
  message text not null,
  priority text not null check (priority in ('now', 'follow_up')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (round_id, conversation_id),
  foreign key (round_id, conversation_id) references patio_voz.conversations(round_id, id) on delete cascade,
  foreign key (round_id, seller_id) references patio_voz.demo_sellers(round_id, id),
  foreign key (round_id, car_id) references patio_voz.cars(round_id, id),
  foreign key (round_id, conversation_id, visit_id) references patio_voz.visits(round_id, conversation_id, id)
);
