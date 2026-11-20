import { NextResponse } from "next/server";
import { internalError, isUuid, jsonError, noStore } from "@/lib/api";
import { isRecord } from "@/lib/db";
import { openSellerWorkspace, roundExists } from "@/lib/demo";
import { checkSellerCredentials, getSellerRoundId, getSellerSession, setSellerSession } from "@/lib/seller-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const roundId = getSellerRoundId(request);
  if (!roundId) return jsonError("Entre para acessar o painel do vendedor.", 401);
  return NextResponse.json({ roundId }, { headers: noStore });
}

export async function POST(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return jsonError("Envie os dados de acesso em JSON.", 415);
  }
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError("JSON inválido.", 400); }
  if (!isRecord(body) || typeof body.email !== "string" || typeof body.password !== "string") {
    return jsonError("Informe o e-mail e a senha.", 400);
  }
  const requestedRound = body.roundId;
  if (requestedRound !== undefined && (typeof requestedRound !== "string" || !isUuid(requestedRound))) {
    return jsonError("ID de rodada inválido.", 400);
  }
  const check = checkSellerCredentials(body.email, body.password);
  if (check === "unconfigured") return jsonError("Acesso do vendedor indisponível nesta instalação.", 503);
  if (check === "invalid") return jsonError("E-mail ou senha inválidos.", 401);
  try {
    const roundId = requestedRound?.toLowerCase() ?? await openSellerWorkspace();
    if (requestedRound && !(await roundExists(roundId))) return jsonError("Rodada não encontrada.", 404);
    const response = NextResponse.json({ roundId }, { headers: noStore });
    setSellerSession(response, roundId, check);
    return response;
  } catch {
    return internalError();
  }
}

export async function PATCH(request: Request) {
  const session = getSellerSession(request);
  if (!session) return jsonError("Entre para acessar o painel do vendedor.", 401);
  try {
    const roundId = await openSellerWorkspace();
    const response = NextResponse.json({ roundId }, { headers: noStore });
    setSellerSession(response, roundId, session.account);
    return response;
  } catch {
    return internalError();
  }
}

export async function DELETE() {
  const response = new NextResponse(null, { status: 204, headers: noStore });
  setSellerSession(response, null);
  return response;
}
