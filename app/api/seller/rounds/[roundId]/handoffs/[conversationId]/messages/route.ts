import { NextResponse } from "next/server";
import { internalError, isUuid, jsonError, noStore } from "@/lib/api";
import { getConversationHistory, sendSellerHandoffMessage } from "@/lib/chat-history";
import { MAX_CHAT_MESSAGE_LENGTH } from "@/lib/contracts";
import { isRecord } from "@/lib/db";
import { sellerRoundError } from "@/lib/seller-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_JSON_BYTES = 16 * 1024;

type Params = { params: Promise<{ roundId: string; conversationId: string }> };

function authorize(request: Request, { roundId, conversationId }: Awaited<Params["params"]>) {
  return sellerRoundError(request, roundId) ?? (isUuid(conversationId) ? null : jsonError("Conversa inválida.", 400));
}

export async function GET(request: Request, { params }: Params) {
  const scope = await params;
  const error = authorize(request, scope);
  if (error) return error;
  try {
    const history = await getConversationHistory(scope, true);
    return history ? NextResponse.json(history, { headers: noStore }) : jsonError("Conversa encaminhada não encontrada.", 404);
  } catch {
    return internalError();
  }
}

export async function POST(request: Request, { params }: Params) {
  const scope = await params;
  const error = authorize(request, scope);
  if (error) return error;
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") return jsonError("Envie a mensagem em JSON.", 415);
  if (Number(request.headers.get("content-length")) > MAX_JSON_BYTES) return jsonError("A mensagem deve ter até 1.800 caracteres.", 413);

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) return jsonError("Digite uma mensagem válida.", 400);
  const id = body.id;
  if (typeof id !== "string" || !isUuid(id)) return jsonError("O ID da mensagem deve ser um UUID válido.", 400);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.includes("\0")) return jsonError("Digite uma mensagem válida.", 400);
  if (text.length > MAX_CHAT_MESSAGE_LENGTH) return jsonError("A mensagem deve ter até 1.800 caracteres.", 413);

  try {
    const history = await sendSellerHandoffMessage(scope, id, text);
    return history ? NextResponse.json(history, { headers: noStore }) : jsonError("Conversa encaminhada não encontrada.", 404);
  } catch {
    return internalError();
  }
}
