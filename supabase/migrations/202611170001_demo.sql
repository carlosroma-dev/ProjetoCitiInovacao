create schema if not exists patio_voz;

create table if not exists patio_voz.rounds (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists patio_voz.cars (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references patio_voz.rounds(id) on delete cascade,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  available boolean not null,
  image_url text,
  color text not null,
  year integer not null check (year between 1900 and 2200),
  unique (round_id, id)
);

create table if not exists patio_voz.slots (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references patio_voz.rounds(id) on delete cascade,
  starts_at timestamptz not null,
  unique (round_id, id),
  unique (round_id, starts_at)
);

create table if not exists patio_voz.conversations (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references patio_voz.rounds(id) on delete cascade,
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  created_at timestamptz not null default now(),
  unique (round_id, id)
);

create table if not exists patio_voz.visits (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null,
  slot_id uuid not null,
  car_id uuid not null,
  conversation_id uuid not null,
  turn_id text not null check (length(turn_id) between 1 and 200),
  trade_in text,
  budget_cents integer check (budget_cents is null or budget_cents >= 0),
  summary text not null default '',
  created_at timestamptz not null default now(),
  foreign key (round_id, slot_id) references patio_voz.slots(round_id, id),
  foreign key (round_id, car_id) references patio_voz.cars(round_id, id),
  foreign key (round_id, conversation_id) references patio_voz.conversations(round_id, id),
  unique (round_id, slot_id),
  unique (conversation_id, turn_id)
);

create index if not exists visits_round_created_idx on patio_voz.visits(round_id, created_at desc);

create or replace function patio_voz.create_demo_round()
returns uuid language plpgsql as $$
declare
  new_round uuid := gen_random_uuid();
  saturday date;
begin
  insert into patio_voz.rounds(id) values (new_round);
  insert into patio_voz.cars(round_id, name, price_cents, available, image_url, color, year) values
    (new_round, 'Hyundai HB20 Comfort 1.0', 7599000, true, '/images/hyundai-hb20-2025.webp', 'Prata', 2025),
    (new_round, 'Fiat Argo Drive 1.0', 6899000, true, '/images/fiat-argo.webp', 'Branco', 2024),
    (new_round, 'Renault Kwid Zen 1.0', 5299000, true, '/images/renault-kwid.webp', 'Vermelho', 2023),
    (new_round, 'Volkswagen Polo Comfortline', 9499000, false, '/images/vw-polo.webp', 'Cinza', 2025);

  saturday := (now() at time zone 'America/Sao_Paulo')::date
    + (((6 - extract(dow from (now() at time zone 'America/Sao_Paulo'))::integer + 7) % 7)
       + case when extract(dow from (now() at time zone 'America/Sao_Paulo'))::integer = 6 then 7 else 0 end);
  insert into patio_voz.slots(round_id, starts_at) values
    (new_round, ((saturday + time '09:00') at time zone 'America/Sao_Paulo')),
    (new_round, ((saturday + time '10:30') at time zone 'America/Sao_Paulo')),
    (new_round, ((saturday + time '14:00') at time zone 'America/Sao_Paulo'));
  return new_round;
end $$;
