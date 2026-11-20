alter table patio_voz.cars
  add column model text,
  add column status text,
  add column image_urls text[] not null default '{}',
  add column sort_order integer not null default 0,
  alter column color drop not null,
  alter column year drop not null;

with ranked_cars as (
  select id, row_number() over (partition by round_id order by price_cents, id) as position
  from patio_voz.cars
)
update patio_voz.cars c
set status = case when c.available then 'available' else 'hidden' end,
    image_urls = case when c.image_url is null then '{}' else array[c.image_url] end,
    model = case c.image_url
      when '/images/hyundai-hb20-2025.webp' then 'Comfort 1.0'
      when '/images/fiat-argo.webp' then 'Drive 1.0'
      when '/images/renault-kwid.webp' then 'Zen 1.0'
      when '/images/vw-polo.webp' then 'Comfortline'
    end,
    sort_order = r.position
from ranked_cars r
where c.id = r.id;

alter table patio_voz.cars
  alter column status set not null,
  add constraint cars_status_check check (status in ('available', 'hidden', 'sold')),
  add constraint cars_status_available_check check (available = (status = 'available')),
  add constraint cars_image_urls_check check (cardinality(image_urls) <= 3);

create index cars_round_sort_idx on patio_voz.cars (round_id, sort_order, id);

create table patio_voz.seller_workspace (
  singleton boolean primary key default true check (singleton),
  round_id uuid not null references patio_voz.rounds(id) on delete cascade
);

create function patio_voz.ensure_future_demo_slots(target_round uuid)
returns void language plpgsql as $$
declare
  saturday date;
begin
  if exists (select 1 from patio_voz.slots where round_id = target_round and starts_at > now()) then
    return;
  end if;

  saturday := (now() at time zone 'America/Sao_Paulo')::date
    + (((6 - extract(dow from (now() at time zone 'America/Sao_Paulo'))::integer + 7) % 7)
       + case when extract(dow from (now() at time zone 'America/Sao_Paulo'))::integer = 6 then 7 else 0 end);
  insert into patio_voz.slots(round_id, starts_at) values
    (target_round, ((saturday + time '09:00') at time zone 'America/Sao_Paulo')),
    (target_round, ((saturday + time '10:30') at time zone 'America/Sao_Paulo')),
    (target_round, ((saturday + time '14:00') at time zone 'America/Sao_Paulo'))
  on conflict (round_id, starts_at) do nothing;
end $$;

create or replace function patio_voz.create_demo_round()
returns uuid language plpgsql as $$
declare
  new_round uuid := gen_random_uuid();
begin
  insert into patio_voz.rounds(id) values (new_round);
  insert into patio_voz.cars(round_id, name, model, price_cents, available, status, image_url, image_urls, sort_order, color, year) values
    (new_round, 'Hyundai HB20 Comfort 1.0', 'Comfort 1.0', 7599000, true, 'available', '/images/hyundai-hb20-2025.webp', array['/images/hyundai-hb20-2025.webp'], 3, 'Prata', 2025),
    (new_round, 'Fiat Argo Drive 1.0', 'Drive 1.0', 6899000, true, 'available', '/images/fiat-argo.webp', array['/images/fiat-argo.webp'], 2, 'Branco', 2024),
    (new_round, 'Renault Kwid Zen 1.0', 'Zen 1.0', 5299000, true, 'available', '/images/renault-kwid.webp', array['/images/renault-kwid.webp'], 1, 'Vermelho', 2023),
    (new_round, 'Volkswagen Polo Comfortline', 'Comfortline', 9499000, false, 'hidden', '/images/vw-polo.webp', array['/images/vw-polo.webp'], 4, 'Cinza', 2025);

  perform patio_voz.ensure_future_demo_slots(new_round);
  return new_round;
end $$;
