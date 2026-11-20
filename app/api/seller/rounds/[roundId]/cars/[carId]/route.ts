import { NextResponse } from "next/server";
import { isUuid, jsonError, noStore } from "@/lib/api";
import { CatalogRequestError, removeCatalogPhotos, uploadCatalogPhotos } from "@/lib/catalog-photos";
import { changeCatalogCar } from "@/lib/demo";
import { readCatalogEdits, respondToCatalogError } from "@/lib/seller-catalog";
import { sellerRoundError } from "@/lib/seller-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ roundId: string; carId: string }> }) {
  const { roundId, carId } = await params;
  const error = sellerRoundError(request, roundId);
  if (error) return error;
  if (!isUuid(carId)) return jsonError("ID de veículo inválido.", 400);
  try {
    const { changes, photos } = await readCatalogEdits(request);
    const uploaded = await uploadCatalogPhotos(roundId, photos);
    const updated = await changeCatalogCar(roundId, carId, { ...changes, imageUrls: uploaded.urls }).catch(async (error) => {
      await uploaded.discard();
      throw error;
    });
    if (!updated) {
      await uploaded.discard();
      throw new CatalogRequestError("Veículo não encontrado nesta rodada.", 404);
    }
    await removeCatalogPhotos(roundId, updated.removedImageUrls);
    return NextResponse.json({ car: updated.car }, { headers: noStore });
  } catch (error) {
    return respondToCatalogError(error);
  }
}
