import { NextResponse } from "next/server";
import { getPublicRoundSnapshot } from "@/lib/demo";
import { internalError, isUuid, jsonError, noStore } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params;
  if (!isUuid(roundId)) return jsonError("ID de rodada inválido.", 400);
  try {
    const snapshot = await getPublicRoundSnapshot(roundId);
    if (!snapshot) return jsonError("Rodada não encontrada.", 404);
    return NextResponse.json(snapshot, { headers: noStore });
  } catch {
    return internalError();
  }
}
