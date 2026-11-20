import { NextResponse } from "next/server";
import { editCar } from "@/lib/demo";
import { internalError, isUuid, jsonError, noStore } from "@/lib/api";
import { isRecord } from "@/lib/db";
import { MAX_PRICE_CENTS } from "@/lib/contracts";
import { sellerRoundError } from "@/lib/seller-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ roundId: string; carId: string }> }) {
  const { roundId, carId } = await params;
  const error = sellerRoundError(request, roundId);
  if (error) return error;
  if (!isUuid(carId)) return jsonError("ID inválido.", 400);
  let body: unknown;
  try { body = await request.json(); } catch { return jsonError("JSON inválido.", 400); }
  if (!isRecord(body)) return jsonError("Envie um objeto JSON.", 400);
  const keys = Object.keys(body);
  if (!keys.length || keys.some((key) => key !== "priceCents" && key !== "available")) return jsonError("Campos inválidos.", 400);
  if ("priceCents" in body && (!Number.isSafeInteger(body.priceCents) || Number(body.priceCents) < 0 || Number(body.priceCents) > MAX_PRICE_CENTS)) return jsonError(`priceCents deve ser um inteiro entre 0 e ${MAX_PRICE_CENTS} centavos.`, 400);
  if ("available" in body && typeof body.available !== "boolean") return jsonError("available deve ser booleano.", 400);
  try {
    const car = await editCar(roundId, carId, body as { priceCents?: number; available?: boolean });
    if (!car) return jsonError("Carro não encontrado nesta rodada.", 404);
    return NextResponse.json({ car }, { headers: noStore });
  } catch {
    return internalError();
  }
}
