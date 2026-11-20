import "server-only";
import type { PoolClient } from "pg";
import { resolveSeedCarImage } from "./car-images";
import type { Car, CarStatus, RoundSnapshot, SellerHandoff, SellerSnapshot, TurnReply, Visit } from "./contracts";
import { getPool, one, transaction } from "./db";

export type Conversation = { id: string; roundId: string; context: Record<string, unknown> };
export type Slot = { id: string; startsAt: string; sellerId: string; sellerName: string };
export type ReserveInput = {
  roundId: string;
  conversationId: string;
  turnId: string;
  slotId: string;
  carId: string;
  tradeIn?: string | null;
  budgetCents?: number | null;
  summary?: string;
  transcript?: string;
  wantsAudio?: boolean;
};
export type ReserveResult = { ok: true; visit: Visit; idempotent: boolean } | {
  ok: false; reason: "slot_taken" | "car_unavailable" | "not_found";
} | {
  ok: false; reason: "over_budget"; priceCents: number; budgetCents: number;
};
type PreferredSlot = { localDate: string; localTime: string };
type HandoffInput = Omit<SellerHandoff, "conversationId" | "sellerId" | "sellerName" | "visitId" | "createdAt"> & { visit?: Visit | null };

type CarRow = {
  id: string;
  name: string;
  model: string | null;
  price_cents: number;
  available: boolean;
  status: CarStatus;
  image_url: string | null;
  image_urls: string[];
  sort_order: number;
  color: string | null;
  year: number | null;
};
type NewCatalogCar = { name: string; model: string; priceCents: number; status: CarStatus; imageUrls: string[] };
type CatalogCarPatch = Partial<NewCatalogCar> & { available?: boolean; move?: "up" | "down"; replacePhotos?: boolean };
type SlotRow = { id: string; starts_at: Date | string; seller_id: string; seller_name: string };
type VisitRow = SlotRow & { car_id: string; car_name: string; trade_in: string | null; budget_cents: number | null; summary: string };
type VisitTurnRow = VisitRow & { turn_transcript: string | null; turn_wants_audio: boolean | null };
type AgendaRow = SlotRow & ({ visit_id: null } | (Omit<VisitRow, keyof SlotRow> & { visit_id: string }));
type HandoffRow = {
  conversation_id: string;
  seller_id: string;
  seller_name: string;
  car_id: string | null;
  car_name: string | null;
  trade_in: string | null;
  budget_cents: number | null;
  preference: SellerHandoff["preference"];
  visit_id: string | null;
  reason: string;
  message: string;
  priority: SellerHandoff["priority"];
  created_at: Date | string;
};

const carColumns = "id, name, model, price_cents, available, status, image_url, image_urls, sort_order, color, year";
const imagesFromRow = (r: CarRow) => r.image_urls.length ? r.image_urls : r.image_url ? [r.image_url] : [];
function carFromRow(r: CarRow): Car {
  const imageUrls = imagesFromRow(r).map((url) => resolveSeedCarImage(url, process.env.SUPABASE_CATALOG_URL));
  return {
    id: r.id, name: r.name, model: r.model, priceCents: r.price_cents, available: r.available, status: r.status,
    imageUrl: imageUrls[0] ?? null, imageUrls, color: r.color, year: r.year,
  };
}
const slotFromRow = (r: SlotRow): Slot => ({
  id: r.id, startsAt: new Date(r.starts_at).toISOString(), sellerId: r.seller_id, sellerName: r.seller_name,
});
const visitFromRow = (r: VisitRow): Visit => ({
  ...slotFromRow(r), carId: r.car_id, carName: r.car_name, tradeIn: r.trade_in, budgetCents: r.budget_cents, summary: r.summary,
});
const visitQuery = `select v.id, v.car_id, c.name car_name, s.starts_at, s.seller_id, d.name seller_name,
  v.trade_in, v.budget_cents, v.summary, v.turn_id, v.turn_transcript, v.turn_wants_audio
  from patio_voz.visits v join patio_voz.cars c on (c.round_id, c.id) = (v.round_id, v.car_id)
  join patio_voz.slots s on (s.round_id, s.id) = (v.round_id, v.slot_id)
  join patio_voz.demo_sellers d on (d.round_id, d.id) = (s.round_id, s.seller_id)`;
const latestVisitOrder = "order by v.created_at desc, v.id desc limit 1";
const handoffQuery = `select h.*, d.name seller_name from patio_voz.seller_handoffs h
  join patio_voz.demo_sellers d on (d.round_id, d.id) = (h.round_id, h.seller_id)`;
const handoffFromRow = (r: HandoffRow): SellerHandoff => ({
  conversationId: r.conversation_id, sellerId: r.seller_id, sellerName: r.seller_name,
  carId: r.car_id, carName: r.car_name, tradeIn: r.trade_in, budgetCents: r.budget_cents,
  preference: r.preference, visitId: r.visit_id, reason: r.reason, message: r.message,
  priority: r.priority, createdAt: new Date(r.created_at).toISOString(),
});

export async function createRound(): Promise<string> {
  const row = await one<{ id: string }>("select patio_voz.create_demo_round()::text as id");
  if (!row) throw new Error("Could not create a demo round");
  return row.id;
}

export async function openSellerWorkspace(): Promise<string> {
  return transaction(async (client) => {
    await client.query("lock table patio_voz.seller_workspace in share row exclusive mode");
    const existing = await client.query<{ round_id: string }>("select round_id from patio_voz.seller_workspace");
    if (existing.rows[0]) {
      await client.query("select patio_voz.ensure_future_demo_slots($1)", [existing.rows[0].round_id]);
      return existing.rows[0].round_id;
    }
    const created = await client.query<{ round_id: string }>(`insert into patio_voz.seller_workspace(round_id)
      values (patio_voz.create_demo_round()) returning round_id`);
    return created.rows[0].round_id;
  });
}

export async function roundExists(roundId: string): Promise<boolean> {
  return Boolean(await one("select 1 from patio_voz.rounds where id = $1", [roundId]));
}

async function listCatalogCars(roundId: string, visibleOnly = false): Promise<Car[]> {
  const cars = await getPool().query<CarRow>(`select ${carColumns} from patio_voz.cars where round_id = $1
    ${visibleOnly ? "and status <> 'hidden'" : ""} order by sort_order, id`, [roundId]);
  return cars.rows.map(carFromRow);
}

export async function getRoundSnapshot(roundId: string): Promise<RoundSnapshot | null> {
  if (!(await roundExists(roundId))) return null;
  const [cars, visits] = await Promise.all([
    listCatalogCars(roundId),
    getPool().query<VisitRow>(`${visitQuery} where v.round_id = $1 order by s.starts_at, v.created_at`, [roundId]),
  ]);
  return { cars, visits: visits.rows.map(visitFromRow) };
}

export async function getPublicRoundSnapshot(roundId: string): Promise<RoundSnapshot | null> {
  if (!(await roundExists(roundId))) return null;
  return { cars: await listCatalogCars(roundId, true), visits: [] };
}

export async function getSellerRoundSnapshot(roundId: string): Promise<SellerSnapshot | null> {
  if (!(await roundExists(roundId))) return null;
  await getPool().query("select patio_voz.ensure_future_demo_slots($1)", [roundId]);
  const [cars, agenda, handoffs] = await Promise.all([
    listCatalogCars(roundId),
    getPool().query<AgendaRow>(`select s.id, s.starts_at, s.seller_id, d.name seller_name, v.id visit_id, v.car_id, c.name car_name,
      v.trade_in, v.budget_cents, v.summary from patio_voz.slots s
      join patio_voz.demo_sellers d on (d.round_id, d.id) = (s.round_id, s.seller_id)
      left join patio_voz.visits v on (v.round_id, v.slot_id) = (s.round_id, s.id)
      left join patio_voz.cars c on (c.round_id, c.id) = (v.round_id, v.car_id)
      where s.round_id = $1 and (s.starts_at > now() or v.id is not null) order by s.starts_at, s.seller_id`, [roundId]),
    getPool().query<HandoffRow>(`${handoffQuery} where h.round_id = $1
      order by (h.priority = 'now') desc, h.created_at desc, h.conversation_id`, [roundId]),
  ]);
  const visits = agenda.rows.flatMap((row) => row.visit_id === null ? [] : [visitFromRow({ ...row, id: row.visit_id })]);
  const slots = agenda.rows.map((row) => ({ ...slotFromRow(row), visitId: row.visit_id }));
  return { cars, visits, slots, handoffs: handoffs.rows.map(handoffFromRow) };
}

export class CatalogPhotoLimitError extends Error {
  constructor() { super("Cada veículo pode ter até 3 fotos."); }
}

export async function addCatalogCar(roundId: string, car: NewCatalogCar): Promise<Car | null> {
  return transaction(async (client) => {
    const round = await client.query("select 1 from patio_voz.rounds where id = $1 for update", [roundId]);
    if (!round.rowCount) return null;
    const inserted = await client.query<CarRow>(`insert into patio_voz.cars
      (round_id, name, model, price_cents, status, available, image_url, image_urls, sort_order)
      values ($1, $2, $3, $4, $5, $5 = 'available', $6, $7,
        (select coalesce(max(sort_order), 0) + 1 from patio_voz.cars where round_id = $1)) returning ${carColumns}`,
    [roundId, car.name, car.model, car.priceCents, car.status, car.imageUrls[0] ?? null, car.imageUrls]);
    return carFromRow(inserted.rows[0]);
  });
}

export async function changeCatalogCar(roundId: string, carId: string, patch: CatalogCarPatch): Promise<{ car: Car; removedImageUrls: string[] } | null> {
  return transaction(async (client) => {
    // Serialize catalog writes within the round so photo appends and reorder operations see the last edit.
    const round = await client.query("select 1 from patio_voz.rounds where id = $1 for update", [roundId]);
    if (!round.rowCount) return null;
    const current = await client.query<CarRow>(`select ${carColumns} from patio_voz.cars where round_id = $1 and id = $2 for update`, [roundId, carId]);
    const row = current.rows[0];
    if (!row) return null;
    const previousImages = imagesFromRow(row);
    const imageUrls = patch.replacePhotos ? patch.imageUrls ?? [] : [...previousImages, ...(patch.imageUrls ?? [])];
    if (imageUrls.length > 3) throw new CatalogPhotoLimitError();
    let status = patch.status ?? row.status;
    if (patch.available === true) status = "available";
    if (patch.available === false && status === "available") status = "hidden";

    if (patch.move) {
      const neighbor = await client.query<{ id: string; sort_order: number }>(`select id, sort_order from patio_voz.cars
        where round_id = $1 and sort_order ${patch.move === "up" ? "<" : ">"} $2
        order by sort_order ${patch.move === "up" ? "desc" : "asc"} limit 1`, [roundId, row.sort_order]);
      if (neighbor.rows[0]) {
        await client.query(`update patio_voz.cars set sort_order = case when id = $2 then $4::integer else $5::integer end
          where round_id = $1 and id in ($2, $3)`, [roundId, carId, neighbor.rows[0].id, neighbor.rows[0].sort_order, row.sort_order]);
      }
    }

    const updated = await client.query<CarRow>(`update patio_voz.cars set name = $3, model = $4, price_cents = $5,
      status = $6, available = ($6 = 'available'), image_url = $7, image_urls = $8
      where round_id = $1 and id = $2 returning ${carColumns}`,
    [roundId, carId, patch.name ?? row.name, patch.model ?? row.model, patch.priceCents ?? row.price_cents, status, imageUrls[0] ?? null, imageUrls]);
    return { car: carFromRow(updated.rows[0]), removedImageUrls: previousImages.filter((url) => !imageUrls.includes(url)) };
  });
}

export async function editCar(roundId: string, carId: string, patch: { priceCents?: number; available?: boolean }): Promise<Car | null> {
  return (await changeCatalogCar(roundId, carId, patch))?.car ?? null;
}

export async function createConversation(roundId: string, context: Record<string, unknown> = {}): Promise<Conversation | null> {
  const result = await getPool().query<{ id: string; round_id: string; context: Record<string, unknown> }>("insert into patio_voz.conversations(round_id, context) select id, $2::jsonb from patio_voz.rounds where id = $1 returning id, round_id, context", [roundId, JSON.stringify(context)]);
  const row = result.rows[0];
  return row ? { id: row.id, roundId: row.round_id, context: row.context } : null;
}

export async function getConversation(roundId: string, conversationId: string): Promise<Conversation | null> {
  const row = await one<{ id: string; round_id: string; context: Record<string, unknown> }>("select id, round_id, context from patio_voz.conversations where round_id = $1 and id = $2", [roundId, conversationId]);
  return row ? { id: row.id, roundId: row.round_id, context: row.context } : null;
}

export async function getConversationTurn(roundId: string, conversationId: string, turnId: string): Promise<unknown | null> {
  const row = await one<{ reply: unknown }>("select reply from patio_voz.conversation_turns where round_id=$1 and conversation_id=$2 and turn_id=$3", [roundId, conversationId, turnId]);
  return row?.reply ?? null;
}

export async function getRecentConversationTurns(roundId: string, conversationId: string) {
  const result = await getPool().query<{ user: string; assistant: string; speech: string | null }>(`select
    case when length(reply->>'transcript') > 500
      then left(reply->>'transcript', 250) || ' […] ' || right(reply->>'transcript', 250)
      else reply->>'transcript' end as "user",
    reply->>'message' as assistant, reply->>'speechText' as speech
    from patio_voz.conversation_turns where round_id=$1 and conversation_id=$2
      and jsonb_typeof(reply->'transcript') = 'string' and jsonb_typeof(reply->'message') = 'string'
    order by created_at desc, turn_id desc limit 4`, [roundId, conversationId]);
  return result.rows.reverse();
}

function lockConversation(client: PoolClient, roundId: string, conversationId: string) {
  return client.query<{ context: Record<string, unknown> }>("select context from patio_voz.conversations where round_id=$1 and id=$2 for update", [roundId, conversationId]);
}

export class HumanHandoffError extends Error {
  constructor() { super("O atendimento agora está com um vendedor. Envie uma mensagem de texto pelo chat para continuar."); }
}

export class StaleHandoffError extends Error {
  constructor() { super("The conversation's latest visit changed before handoff"); }
}

export async function getSellerHandoff(roundId: string, conversationId: string, client: Pick<PoolClient, "query"> = getPool()): Promise<SellerHandoff | null> {
  const result = await client.query<HandoffRow>(`${handoffQuery} where h.round_id = $1 and h.conversation_id = $2`, [roundId, conversationId]);
  return result.rows[0] ? handoffFromRow(result.rows[0]) : null;
}

export async function planSellerHandoff(roundId: string, conversationId: string, { visit, ...input }: HandoffInput): Promise<SellerHandoff> {
  const existing = await getSellerHandoff(roundId, conversationId);
  if (existing) return existing;

  const seller = await one<{ id: string; name: string; visit_id: string | null }>(`select d.id, d.name, booking.id visit_id
    from patio_voz.conversations conv
    join patio_voz.demo_sellers d on d.round_id = conv.round_id
    left join lateral (${visitQuery} where (v.round_id, v.conversation_id) = (conv.round_id, conv.id)
      ${latestVisitOrder}) booking on true
    where conv.round_id = $1 and conv.id = $2
      and ($3::uuid is null or exists (select 1 from patio_voz.visits v
        where (v.round_id, v.conversation_id, v.id) = (conv.round_id, conv.id, $3)))
    order by (d.id = booking.seller_id) desc nulls last, md5(d.id || conv.id::text), d.id limit 1`,
  [roundId, conversationId, visit?.id ?? null]);
  if (!seller) throw new Error("Could not assign the conversation to a seller");
  return { ...input, conversationId, sellerId: seller.id, sellerName: seller.name, visitId: seller.visit_id, createdAt: new Date().toISOString() };
}

export async function hasSharedPhoto(roundId: string, conversationId: string, carId: string, client: Pick<PoolClient, "query"> = getPool()): Promise<boolean> {
  const prior = await client.query(`select 1 from patio_voz.conversation_turns
    where round_id=$1 and conversation_id=$2 and reply #>> '{photo,id}' = $3 limit 1`,
  [roundId, conversationId, carId]);
  return Boolean(prior.rowCount);
}

export async function saveConversationTurn(
  roundId: string, conversationId: string, turnId: string, context: Record<string, unknown>,
  reply: TurnReply, { introduction, repeatPhoto, handoff }: {
    introduction?: string | readonly string[] | null;
    repeatPhoto?: { carId: string; reply: Required<Pick<TurnReply, "bubbles" | "message">> & Pick<TurnReply, "speechText" | "wantsAudio"> };
    handoff?: SellerHandoff;
  } = {},
): Promise<TurnReply> {
  return transaction(async (client) => {
    const locked = await lockConversation(client, roundId, conversationId);
    const replay = await client.query<{ reply: TurnReply }>("select reply from patio_voz.conversation_turns where round_id=$1 and conversation_id=$2 and turn_id=$3", [roundId, conversationId, turnId]);
    if (replay.rows[0]) return replay.rows[0].reply;
    const activeHandoff = await getSellerHandoff(roundId, conversationId, client);
    if (activeHandoff) {
      // A reservation committed before the handoff still needs its original confirmation.
      const booking = reply.visit && await existingVisit(client, roundId, conversationId, turnId);
      if (handoff || !booking || booking.id !== reply.visit?.id) throw new HumanHandoffError();
      reply = { ...reply, humanHandoff: true };
    }
    if (handoff) {
      const latest = await client.query<VisitRow & { confirmed_in_chat: boolean }>(`select booking.*, exists (
        select 1 from patio_voz.conversation_turns t
        where t.round_id = $1 and t.conversation_id = $2 and t.turn_id::text = lower(booking.turn_id)
          and t.reply #>> '{visit,id}' = booking.id::text
      ) confirmed_in_chat from (${visitQuery} where v.round_id = $1 and v.conversation_id = $2 ${latestVisitOrder}) booking`,
      [roundId, conversationId]);
      const booking = latest.rows[0];
      if ((booking?.id ?? null) !== handoff.visitId || (booking && booking.seller_id !== handoff.sellerId)) throw new StaleHandoffError();
      reply = { ...reply, humanHandoff: true, visit: booking && !booking.confirmed_in_chat ? visitFromRow(booking) : null };
    }

    // Recheck saved replies under the lock so two concurrent turns cannot send the same gallery.
    if (repeatPhoto && await hasSharedPhoto(roundId, conversationId, repeatPhoto.carId, client)) {
      reply = { ...reply, ...repeatPhoto.reply, photo: null };
    }
    const introduced = locked.rows[0]?.context.patioVozIntroduced === true;
    const prefix = typeof introduction === "string" ? [introduction] : introduction;
    if (introduced && prefix?.length && reply.bubbles && prefix.every((bubble, index) => reply.bubbles?.[index] === bubble)) {
      const remaining = reply.bubbles.slice(prefix.length);
      const bubbles = remaining.length ? remaining : ["Como posso te ajudar?"];
      reply = { ...reply, bubbles, message: bubbles.join(" ") };
    }
    const saved = await client.query<{ reply: TurnReply }>(`insert into patio_voz.conversation_turns(round_id,conversation_id,turn_id,reply,created_at)
      values($1,$2,$3,$4::jsonb,clock_timestamp()) returning reply`, [roundId, conversationId, turnId, JSON.stringify(reply)]);
    if (handoff) {
      await client.query(`insert into patio_voz.seller_handoffs
        (round_id, conversation_id, seller_id, car_id, car_name, trade_in, budget_cents, preference, visit_id, reason, message, priority)
        values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
      [roundId, conversationId, handoff.sellerId, handoff.carId, handoff.carName, handoff.tradeIn, handoff.budgetCents,
        handoff.preference ? JSON.stringify(handoff.preference) : null, handoff.visitId, handoff.reason, handoff.message, handoff.priority]);
    }
    if (!activeHandoff) {
      const savedContext = introduced || prefix?.length ? { ...context, patioVozIntroduced: true } : context;
      await client.query("update patio_voz.conversations set context=$3::jsonb where round_id=$1 and id=$2", [roundId, conversationId, JSON.stringify(savedContext)]);
    }
    return saved.rows[0].reply;
  });
}

export async function countConversationTurns(conversationId: string): Promise<number> {
  const row = await one<{ count: string }>("select count(*)::text as count from patio_voz.conversation_turns where conversation_id=$1 and created_at > now() - interval '1 hour'", [conversationId]);
  return Number(row?.count ?? 0);
}

export async function updateConversationContext(roundId: string, conversationId: string, context: Record<string, unknown>): Promise<Conversation | null> {
  const row = await one<{ id: string; round_id: string; context: Record<string, unknown> }>("update patio_voz.conversations set context = $3::jsonb where round_id = $1 and id = $2 returning id, round_id, context", [roundId, conversationId, JSON.stringify(context)]);
  return row ? { id: row.id, roundId: row.round_id, context: row.context } : null;
}

const openSlotFrom = `from patio_voz.slots s
  join patio_voz.demo_sellers d on (d.round_id, d.id) = (s.round_id, s.seller_id)
  left join patio_voz.visits v on (v.round_id, v.slot_id) = (s.round_id, s.id)`;
const openSlotFilter = "s.round_id = $1 and s.starts_at > now() and v.id is null";
const slotColumns = "s.id, s.starts_at, s.seller_id, d.name seller_name";

export async function listAvailableSlots(roundId: string, carId?: string): Promise<Slot[]> {
  await getPool().query("select patio_voz.ensure_future_demo_slots($1)", [roundId]);
  const result = await getPool().query<SlotRow>(`select ${slotColumns} ${openSlotFrom}
    ${carId ? "join patio_voz.cars c on (c.round_id, c.id) = (s.round_id, $2) and c.available" : ""}
    where ${openSlotFilter} order by s.starts_at, s.seller_id`, carId ? [roundId, carId] : [roundId]);
  return result.rows.map(slotFromRow);
}

function validLocalDate(date: string): boolean {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validPreference(date: string, time: string): boolean {
  return validLocalDate(date) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
}

const preferredStart = `(($2::date + $3::time) at time zone 'America/Sao_Paulo')`;

export async function listOpenSlotsOnDate(roundId: string, localDate: string): Promise<Slot[]> {
  if (!validLocalDate(localDate)) return [];
  await getPool().query("select patio_voz.ensure_future_demo_slots($1)", [roundId]);
  const result = await getPool().query<SlotRow>(`select distinct on (s.starts_at) ${slotColumns} ${openSlotFrom}
    where ${openSlotFilter}
      and s.starts_at >= ($2::date::timestamp at time zone 'America/Sao_Paulo')
      and s.starts_at < (($2::date + 1)::timestamp at time zone 'America/Sao_Paulo')
    order by s.starts_at, s.seller_id`, [roundId, localDate]);
  return result.rows.map(slotFromRow);
}

export async function listPreferredSlots(roundId: string, date: string, time: string): Promise<Slot[]> {
  if (!validPreference(date, time)) return [];
  await getPool().query("select patio_voz.ensure_future_demo_slots($1)", [roundId]);
  const result = await getPool().query<SlotRow>(`select ${slotColumns} ${openSlotFrom}
    where ${openSlotFilter} and s.starts_at = ${preferredStart}
    order by s.seller_id`, [roundId, date, time]);
  return result.rows.map(slotFromRow);
}

async function existingVisit(client: Pick<PoolClient, "query">, roundId: string, conversationId: string, turnId: string): Promise<VisitTurnRow | null> {
  const result = await client.query<VisitTurnRow>(`${visitQuery}
    where v.round_id = $1 and v.conversation_id = $2 and v.turn_id = $3`, [roundId, conversationId, turnId]);
  return result.rows[0] ?? null;
}

export async function getVisitForTurn(roundId: string, conversationId: string, turnId: string) {
  const row = await existingVisit(getPool(), roundId, conversationId, turnId);
  return row ? { visit: visitFromRow(row), transcript: row.turn_transcript, wantsAudio: row.turn_wants_audio } : null;
}

export async function reserveVisit(input: ReserveInput): Promise<ReserveResult> {
  return reserve(input);
}

export async function reservePreferredVisit(input: Omit<ReserveInput, "slotId"> & PreferredSlot): Promise<ReserveResult> {
  await getPool().query("select patio_voz.ensure_future_demo_slots($1)", [input.roundId]);
  return reserve(input);
}

async function reserve(input: ReserveInput | (Omit<ReserveInput, "slotId"> & PreferredSlot)): Promise<ReserveResult> {
  return transaction(async (client) => {
    const conversation = await lockConversation(client, input.roundId, input.conversationId);
    if (!conversation.rowCount) return { ok: false, reason: "not_found" };
    const prior = await existingVisit(client, input.roundId, input.conversationId, input.turnId);
    if (prior) return { ok: true, visit: visitFromRow(prior), idempotent: true };
    if (await getSellerHandoff(input.roundId, input.conversationId, client)) throw new HumanHandoffError();

    const car = await client.query<{ available: boolean; price_cents: number }>("select available, price_cents from patio_voz.cars where round_id=$1 and id=$2 for update", [input.roundId, input.carId]);
    if (!car.rowCount) return { ok: false, reason: "not_found" };

    const explicit = "slotId" in input;
    if (!explicit && !validPreference(input.localDate, input.localTime)) return { ok: false, reason: "slot_taken" };
    const slots = await client.query<{ id: string }>(`select s.id from patio_voz.slots s where s.round_id = $1
      and ${explicit ? "s.id = $2" : `s.starts_at = ${preferredStart}`} and s.starts_at > now()
      order by s.seller_id for update`, explicit ? [input.roundId, input.slotId] : [input.roundId, input.localDate, input.localTime]);
    if (explicit && !slots.rowCount) return { ok: false, reason: "not_found" };
    if (!car.rows[0].available) return { ok: false, reason: "car_unavailable" };
    const priceCents = car.rows[0].price_cents;
    if (input.budgetCents != null && priceCents > input.budgetCents) return { ok: false, reason: "over_budget", priceCents, budgetCents: input.budgetCents };

    for (const slot of slots.rows) {
      const inserted = await client.query<{ id: string }>(`insert into patio_voz.visits(round_id, slot_id, car_id, conversation_id,
        turn_id, trade_in, budget_cents, summary, turn_transcript, turn_wants_audio)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (round_id, slot_id) do nothing returning id`,
      [input.roundId, slot.id, input.carId, input.conversationId, input.turnId, input.tradeIn ?? null, input.budgetCents ?? null,
        input.summary ?? "", input.transcript ?? null, input.wantsAudio ?? null]);
      if (!inserted.rows[0]) continue;
      const row = await client.query<VisitRow>(`${visitQuery} where v.id = $1`, [inserted.rows[0].id]);
      return { ok: true, visit: visitFromRow(row.rows[0]), idempotent: false };
    }
    return { ok: false, reason: "slot_taken" };
  });
}

