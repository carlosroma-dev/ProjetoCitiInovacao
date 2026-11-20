import { NextResponse } from "next/server";
import { internalError, isUuid, jsonError, noStore } from "@/lib/api";
import { replyToChatMessages } from "@/lib/chat-history";
import { VoiceError } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ roundId: string; conversationId: string }> }) {
  const scope = await params;
  if (!isUuid(scope.roundId) || !isUuid(scope.conversationId)) return jsonError("Rodada ou conversa inválida.", 400);
  try {
    const history = await replyToChatMessages(scope);
    return history ? NextResponse.json(history, { headers: noStore }) : jsonError("Conversa não encontrada nesta rodada.", 404);
  } catch (error) {
    if (error instanceof VoiceError) return jsonError(error.message, error.status);
    return internalError();
  }
}
