import { NextResponse } from "next/server";
import { internalError, jsonError, noStore } from "@/lib/api";
import { getSellerRoundSnapshot } from "@/lib/demo";
import { sellerRoundError } from "@/lib/seller-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params;
  const error = sellerRoundError(request, roundId);
  if (error) return error;
  try {
    const snapshot = await getSellerRoundSnapshot(roundId);
    if (!snapshot) return jsonError("Rodada não encontrada.", 404);
    return NextResponse.json(snapshot, { headers: noStore });
  } catch {
    return internalError();
  }
}
