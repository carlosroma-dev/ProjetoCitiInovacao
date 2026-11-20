create or replace function patio_voz.ensure_future_demo_slots(target_round uuid)
returns void language plpgsql as $$
declare
  local_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if not exists (select 1 from patio_voz.rounds where id = target_round) then
    return;
  end if;

  insert into patio_voz.demo_sellers (round_id, id, name) values
    (target_round, 'julia', 'Júlia'), (target_round, 'rafa', 'Rafa')
  on conflict (round_id, id) do nothing;

  insert into patio_voz.slots (round_id, starts_at, seller_id)
  select target_round, schedule.starts_at, seller.id
  from (
    select ((local_today + days.number + time '08:00' + slots.number * interval '30 minutes')
      at time zone 'America/Sao_Paulo') as starts_at
    from generate_series(0, 27) as days(number)
    cross join generate_series(0, 20) as slots(number)
  ) schedule
  cross join patio_voz.demo_sellers seller
  where seller.round_id = target_round and schedule.starts_at > now()
    and not exists (
      select 1 from patio_voz.slots existing
      where (existing.round_id, existing.starts_at, existing.seller_id) = (target_round, schedule.starts_at, seller.id)
    )
  order by schedule.starts_at, seller.id
  on conflict (round_id, starts_at, seller_id) do nothing;
end $$;
