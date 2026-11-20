import { NextResponse } from "next/server";
import { noStore } from "@/lib/api";
import { CatalogRequestError, uploadCatalogPhotos } from "@/lib/catalog-photos";
import { addCatalogCar } from "@/lib/demo";
import { readNewCatalogCar, respondToCatalogError } from "@/lib/seller-catalog";
import { sellerRoundError } from "@/lib/seller-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params;
  const error = sellerRoundError(request, roundId);
  if (error) return error;
  try {
    const { car, photos } = await readNewCatalogCar(request);
    const uploaded = await uploadCatalogPhotos(roundId, photos);
    try {
      const created = await addCatalogCar(roundId, { ...car, imageUrls: uploaded.urls });
      if (!created) throw new CatalogRequestError("Rodada não encontrada.", 404);
      return NextResponse.json({ car: created }, { status: 201, headers: noStore });
    } catch (error) {
      await uploaded.discard();
      throw error;
    }
  } catch (error) {
    return respondToCatalogError(error);
  }
}
