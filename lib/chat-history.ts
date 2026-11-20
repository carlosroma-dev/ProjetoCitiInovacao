import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { CHAT_IDLE_MS, MAX_CHAT_BATCH_MESSAGES, type ChatMessage, type ConversationHistory, type TurnReply } from "./contracts";
import { getPool, one, transaction } from "./db";
import { getConversation, getSellerHandoff, HumanHandoffError, saveConversationTurn } from "./demo";
import { handleTurn, hasReplyAudio } from "./voice";

// The claim spans the provider timeouts and expires if the request dies before releasing it.
const CLAIM_DURATION_MS = 120_000;
const REPLY_POLL_MS = 1_000;

type ConversationScope = { roundId: string; conversationId: string };
type QueueStatus = { pending: boolean; processing: boolean; idle_remaining_ms: number; human_handoff: boolean };
type StoredMessage = { id: string; created_at: string } & (
  { text: string; reply: null } | { text: null; reply: TurnReply; queued_turn: boolean }
);

const pendingMessages = `select m.id, m.text, m.created_at, m.batch_turn_id
  from patio_voz.chat_messages m
  where m.round_id = $1 and m.conversation_id = $2 and not exists (
    select 1 from patio_voz.conversation_turns t
    where (t.round_id, t.conversation_id, t.turn_id) = (m.round_id, m.conversation_id, m.batch_turn_id)
  )`;
const queueStatusColumns = `newest.id is not null and h.conversation_id is null as pending,
  h.conversation_id is not null as human_handoff,
  coalesce(c.chat_reply_claim_until > statement_timestamp(), false) as processing,
  greatest(0, ceil(extract(epoch from (newest.created_at - statement_timestamp())) * 1000 + $3::integer))::integer as idle_remaining_ms`;
const conversationQueue = `from patio_voz.conversations c
  left join patio_voz.seller_handoffs h on (h.round_id, h.conversation_id) = (c.round_id, c.id)
  left join lateral (${pendingMessages} order by m.created_at desc, m.id desc limit 1) newest on h.conversation_id is null
  where c.round_id = $1 and c.id = $2`;

export async function getConversationHistory({ roundId, conversationId }: ConversationScope, requireHandoff = false): Promise<ConversationHistory | null> {
  const row = await one<QueueStatus & { history: StoredMessage[] }>(`with queued as (
    select id, text, created_at, batch_turn_id from patio_voz.chat_messages
    where round_id = $1 and conversation_id = $2
  ), history as (
    select id, text, created_at, null::jsonb as reply, false as queued_turn from queued
    union all
    select t.turn_id, null::text, t.created_at, t.reply,
      exists (select 1 from queued q where q.batch_turn_id = t.turn_id)
    from patio_voz.conversation_turns t where t.round_id = $1 and t.conversation_id = $2
  )
  select ${queueStatusColumns}, coalesce((
    select jsonb_agg(to_jsonb(h) order by h.created_at, h.id, h.reply is not null) from history h
  ), '[]'::jsonb) as history
  ${conversationQueue} and (not $4::boolean or h.conversation_id is not null)`, [roundId, conversationId, CHAT_IDLE_MS, requireHandoff]);
  if (!row) return null;

  const messages = row.history.flatMap<ChatMessage>((entry) => {
    const createdAt = new Date(entry.created_at).toISOString();
    if (entry.reply === null) return [{ id: entry.id, role: "user", text: entry.text, createdAt, source: "text" }];
    const assistant: ChatMessage = { id: entry.id, role: "assistant", reply: entry.reply, createdAt };
    if (entry.queued_turn || entry.reply.sellerName || !entry.reply.transcript) return [assistant];
    return [{ id: `user:${entry.id}`, role: "user", text: entry.reply.transcript, createdAt, source: entry.reply.inputKind ?? "text" }, assistant];
  });
  return {
    messages,
    pending: row.pending,
    retryAfterMs: row.pending ? Math.max(row.idle_remaining_ms, row.processing ? REPLY_POLL_MS : 0) : 0,
    canListen: hasReplyAudio(),
    humanHandoff: row.human_handoff,
  };
}

async function lockConversation(client: PoolClient, { roundId, conversationId }: ConversationScope): Promise<boolean> {
  const result = await client.query("select 1 from patio_voz.conversations where round_id = $1 and id = $2 for update", [roundId, conversationId]);
  return Boolean(result.rowCount);
}

export async function enqueueChatMessage(scope: ConversationScope, id: string, text: string): Promise<ConversationHistory | null> {
  const { roundId, conversationId } = scope;
  const exists = await transaction(async (client) => {
    if (!await lockConversation(client, scope)) return false;
    await client.query(`insert into patio_voz.chat_messages(round_id, conversation_id, id, text)
      values ($1, $2, $3, $4) on conflict (round_id, conversation_id, id) do nothing`, [roundId, conversationId, id, text]);
    return true;
  });
  return exists ? getConversationHistory(scope) : null;
}

export async function sendSellerHandoffMessage(scope: ConversationScope, id: string, text: string): Promise<ConversationHistory | null> {
  const { roundId, conversationId } = scope;
  const exists = await transaction(async (client) => {
    if (!await lockConversation(client, scope)) return false;
    const handoff = await getSellerHandoff(roundId, conversationId, client);
    if (!handoff) return false;
    const reply: TurnReply = {
      turnId: id, transcript: "", message: text, visit: null, photo: null, sellerName: handoff.sellerName,
    };
    await client.query(`insert into patio_voz.conversation_turns(round_id, conversation_id, turn_id, reply, created_at)
      values($1,$2,$3,$4::jsonb,clock_timestamp()) on conflict (conversation_id, turn_id) do nothing`,
    [roundId, conversationId, id, JSON.stringify(reply)]);
    return true;
  });
  return exists ? getConversationHistory(scope, true) : null;
}

async function claimChatBatch(scope: ConversationScope) {
  const { roundId, conversationId } = scope;
  return transaction(async (client) => {
    if (!await lockConversation(client, scope)) return null;
    const state = (await client.query<QueueStatus>(`select ${queueStatusColumns} ${conversationQueue}`,
      [roundId, conversationId, CHAT_IDLE_MS])).rows[0];
    if (!state.pending || state.processing || state.idle_remaining_ms > 0) return null;

    // Reuse the prior turn ID, and include later corrections unless a visit has already been committed.
    const { rows } = await client.query<{ id: string; text: string; previous_turn_id: string | null }>(`with pending as (${pendingMessages}), unfinished as (
      select batch_turn_id from pending where batch_turn_id is not null order by created_at, id limit 1
    ), previous as (
      select (select batch_turn_id from unfinished) as turn_id, exists (
        select 1 from patio_voz.visits
        where round_id = $1 and conversation_id = $2 and turn_id = (select batch_turn_id::text from unfinished)
      ) as booked
    )
    select pending.id, pending.text, previous.turn_id as previous_turn_id from pending cross join previous
    where batch_turn_id is not distinct from previous.turn_id or (batch_turn_id is null and not previous.booked)
    order by created_at, id limit $3`, [roundId, conversationId, MAX_CHAT_BATCH_MESSAGES + 1]);
    if (!rows.length) return null;

    const turnId = rows[0].previous_turn_id ?? randomUUID();
    const oversized = rows.length > MAX_CHAT_BATCH_MESSAGES;
    if (oversized) {
      await client.query(`update patio_voz.chat_messages set batch_turn_id = $3
        where round_id = $1 and conversation_id = $2 and batch_turn_id is null`, [roundId, conversationId, turnId]);
    } else {
      await client.query(`update patio_voz.chat_messages set batch_turn_id = $3
        where round_id = $1 and conversation_id = $2 and batch_turn_id is null and id = any($4::uuid[])`,
      [roundId, conversationId, turnId, rows.map(({ id }) => id)]);
    }
    const claimId = randomUUID();
    await client.query(`update patio_voz.conversations set chat_reply_claim_id = $3,
      chat_reply_claim_until = clock_timestamp() + $4::integer * interval '1 millisecond'
      where round_id = $1 and id = $2`, [roundId, conversationId, claimId, CLAIM_DURATION_MS]);
    return { claimId, turnId, batch: oversized ? null : rows.map(({ text }) => text) };
  });
}

export async function replyToChatMessages(scope: ConversationScope): Promise<ConversationHistory | null> {
  const claim = await claimChatBatch(scope);
  if (claim) {
    try {
      if (claim.batch) {
        await handleTurn({ ...scope, turnId: claim.turnId, batch: claim.batch });
      } else {
        const conversation = await getConversation(scope.roundId, scope.conversationId);
        if (conversation) {
          const reply: TurnReply = {
            turnId: claim.turnId, transcript: "", inputKind: "text", visit: null, photo: null,
            message: "Recebi muitas mensagens de uma vez. Qual é a coisa mais importante para vermos agora?",
          };
          await saveConversationTurn(scope.roundId, scope.conversationId, claim.turnId, conversation.context, reply);
        }
      }
    } catch (error) {
      if (!(error instanceof HumanHandoffError)) throw error;
    } finally {
      await getPool().query(`update patio_voz.conversations set chat_reply_claim_id = null, chat_reply_claim_until = null
        where round_id = $1 and id = $2 and chat_reply_claim_id = $3`, [scope.roundId, scope.conversationId, claim.claimId]);
    }
  }
  return getConversationHistory(scope);
}
