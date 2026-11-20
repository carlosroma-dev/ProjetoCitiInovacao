import { NextResponse } from "next/server";
import { handleTurn, MAX_AUDIO_BYTES, VoiceError } from "@/lib/voice";
import { internalError, isUuid, jsonError, noStore } from "@/lib/api";
import { HumanHandoffError } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_JSON_BYTES = 16 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ roundId: string; conversationId: string }> }) {
  const { roundId, conversationId } = await params;
  if (!isUuid(roundId) || !isUuid(conversationId)) return jsonError("Rodada ou conversa inválida.", 400);
  const length = Number(request.headers.get("content-length") ?? 0);
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  try {
    if (contentType === "application/json") {
      if (length > MAX_JSON_BYTES) return jsonError("A mensagem deve ter até 1.800 caracteres.", 413);
      const body: unknown = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || !("text" in body) || typeof body.text !== "string") return jsonError("Campo de texto obrigatório.", 400);
      if (!("turnId" in body) || typeof body.turnId !== "string" || !isUuid(body.turnId)) return jsonError("turnId deve ser um UUID válido.", 400);
      const reply = await handleTurn({ roundId, conversationId, turnId: body.turnId, text: body.text });
      return NextResponse.json(reply, { headers: noStore });
    }
    if (contentType === "multipart/form-data") {
      if (length > MAX_AUDIO_BYTES + 32_000) return jsonError("O áudio deve ter até 3 MB.", 413);
      const form = await request.formData().catch(() => null);
      const audio = form?.get("audio");
      const turnId = form?.get("turnId");
      if (!(audio instanceof File)) return jsonError("Campo de áudio obrigatório.", 400);
      if (typeof turnId !== "string" || !isUuid(turnId)) return jsonError("turnId deve ser um UUID válido.", 400);
      const reply = await handleTurn({ roundId, conversationId, turnId, audio });
      return NextResponse.json(reply, { headers: noStore });
    }
    return jsonError("Envie texto em JSON ou áudio em multipart/form-data.", 415);
  } catch (error) {
    if (error instanceof HumanHandoffError) return jsonError(error.message, 409);
    if (error instanceof VoiceError) return jsonError(error.message, error.status);
    return internalError();
  }
}
