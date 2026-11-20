import { NextResponse } from "next/server";
import { synthesizeTurnAudio, VoiceError } from "@/lib/voice";
import { internalError, isUuid, jsonError, noStore } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ roundId: string; conversationId: string; turnId: string }> }) {
  const { roundId, conversationId, turnId } = await params;
  if (!isUuid(roundId) || !isUuid(conversationId) || !isUuid(turnId)) return jsonError("Rodada, conversa ou turno inválido.", 400);
  try {
    const audio = await synthesizeTurnAudio(roundId, conversationId, turnId);
    if (!audio) return jsonError("Turno não encontrado nesta conversa.", 404);
    return new NextResponse(new Uint8Array(audio), { headers: { ...noStore, "Content-Type": "audio/mpeg", "Content-Length": String(audio.length) } });
  } catch (error) {
    if (error instanceof VoiceError) return jsonError(error.message, error.status);
    return internalError();
  }
}
