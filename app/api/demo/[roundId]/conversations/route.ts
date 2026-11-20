import { NextResponse } from "next/server";
import { createConversation } from "@/lib/demo";
import { internalError, isUuid, jsonError, noStore } from "@/lib/api";
import { hasReplyAudio } from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params;
  if (!isUuid(roundId)) return jsonError("Rodada inválida.", 400);
  try {
    const conversation = await createConversation(roundId);
    if (!conversation) return jsonError("Rodada não encontrada.", 404);
    return NextResponse.json({ conversationId: conversation.id, canListen: hasReplyAudio() }, { status: 201, headers: noStore });
  } catch { return internalError(); }
}
