import "server-only";
import { getPool, one } from "./db";

export const MAX_ELEVENLABS_ATTEMPTS = 3;
export const ELEVENLABS_CLAIM_MS = 30_000;

/** Reserves one hourly turn attempt in the legacy quota table. */
export async function consumeTurnAttempt(conversationId: string): Promise<boolean> {
  const result = await getPool().query<{ attempts: number }>(`insert into patio_voz.groq_conversation_usage(conversation_id, window_started_at, attempts)
    values ($1, now(), 1)
    on conflict (conversation_id) do update set
      attempts = case when patio_voz.groq_conversation_usage.window_started_at <= now() - interval '1 hour' then 1 else patio_voz.groq_conversation_usage.attempts + 1 end,
      window_started_at = case when patio_voz.groq_conversation_usage.window_started_at <= now() - interval '1 hour' then now() else patio_voz.groq_conversation_usage.window_started_at end
    where patio_voz.groq_conversation_usage.window_started_at <= now() - interval '1 hour'
       or patio_voz.groq_conversation_usage.attempts < 25
    returning attempts` , [conversationId]);
  return result.rowCount === 1;
}

export function getTurnAudio(roundId: string, conversationId: string, turnId: string) {
  return one<{ speech_text: string; audio: Buffer | null; attempts: number; generating: boolean }>(`select
    t.reply->>'speechText' as speech_text,
    u.audio_mp3 as audio, coalesce(u.attempts, 0) as attempts,
    coalesce(u.audio_claim_until > clock_timestamp(), false) as generating
    from patio_voz.conversation_turns t
    left join patio_voz.elevenlabs_turn_usage u using (conversation_id, turn_id)
    where t.round_id=$1 and t.conversation_id=$2 and t.turn_id=$3 and not (t.reply ? 'sellerName')
      and t.reply->'wantsAudio' = 'true'::jsonb
      and jsonb_typeof(t.reply->'speechText') = 'string' and btrim(t.reply->>'speechText') <> ''`, [roundId, conversationId, turnId]);
}

/** Claims one generation attempt without holding a database connection during synthesis. */
export async function claimElevenLabsAttempt(roundId: string, conversationId: string, turnId: string): Promise<number | null> {
  const row = await one<{ attempts: number }>(`insert into patio_voz.elevenlabs_turn_usage as usage (conversation_id, turn_id, attempts, audio_claim_until)
    select conversation_id, turn_id, 1, clock_timestamp() + $4::integer * interval '1 millisecond'
    from patio_voz.conversation_turns where round_id=$1 and conversation_id=$2 and turn_id=$3 and not (reply ? 'sellerName')
      and reply->'wantsAudio' = 'true'::jsonb
      and jsonb_typeof(reply->'speechText') = 'string' and btrim(reply->>'speechText') <> ''
    on conflict (conversation_id, turn_id) do update set
      attempts = usage.attempts + 1,
      audio_claim_until = clock_timestamp() + $4::integer * interval '1 millisecond'
    where usage.attempts < $5 and usage.audio_mp3 is null
      and (usage.audio_claim_until is null or usage.audio_claim_until <= clock_timestamp())
    returning attempts`, [roundId, conversationId, turnId, ELEVENLABS_CLAIM_MS, MAX_ELEVENLABS_ATTEMPTS]);
  return row?.attempts ?? null;
}

export async function finishElevenLabsAttempt(conversationId: string, turnId: string, attempt: number, audio: Buffer | null): Promise<boolean> {
  // The attempt number prevents a stalled request from overwriting its successor's MP3.
  const result = await getPool().query(`update patio_voz.elevenlabs_turn_usage
    set audio_mp3=$4, audio_claim_until=null
    where conversation_id=$1 and turn_id=$2 and attempts=$3 and audio_claim_until is not null`,
  [conversationId, turnId, attempt, audio]);
  return result.rowCount === 1;
}
