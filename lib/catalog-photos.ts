import "server-only";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export class CatalogRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

type PhotoFormat = { type: string; extension: string };
export type CatalogPhoto = PhotoFormat & { bytes: ArrayBuffer };
const maxPhotoBytes = 1.25 * 1024 * 1024;

function photoFormat(bytes: Buffer): PhotoFormat | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { type: "image/jpeg", extension: "jpg" };
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "image/png", extension: "png" };
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { type: "image/webp", extension: "webp" };
  return null;
}

export async function readCatalogPhotos(files: FormDataEntryValue[]): Promise<CatalogPhoto[]> {
  if (files.length > 3) throw new CatalogRequestError("Cada veículo pode ter até 3 fotos.", 400);
  return Promise.all(files.map(async (file) => {
    if (!(file instanceof File)) throw new CatalogRequestError("Envie cada foto como arquivo.", 400);
    if (file.size > maxPhotoBytes) throw new CatalogRequestError("Cada foto deve ter até 1,25 MB.", 413);
    const bytes = await file.arrayBuffer();
    const format = photoFormat(Buffer.from(bytes));
    if (!format) throw new CatalogRequestError("Use fotos no formato JPEG, PNG ou WebP.", 415);
    return { ...format, bytes };
  }));
}

function getCatalogBucket() {
  const url = process.env.SUPABASE_URL?.trim();
  const secret = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !secret) return null;
  try {
    const supabase = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return supabase.storage.from(process.env.SUPABASE_CATALOG_BUCKET?.trim() || "catalogo");
  } catch { return null; }
}

async function removeObjects(bucket: NonNullable<ReturnType<typeof getCatalogBucket>>, paths: string[]) {
  if (!paths.length) return;
  try {
    const { error } = await bucket.remove(paths);
    if (!error) return;
  } catch { /* Storage can be temporarily unavailable. */ }
  console.error("Falha ao remover objetos do catálogo no Supabase Storage.");
}

export async function uploadCatalogPhotos(roundId: string, photos: CatalogPhoto[]) {
  const urls: string[] = [];
  if (!photos.length) return { urls, discard: async () => {} };
  const bucket = getCatalogBucket();
  if (!bucket) throw new CatalogRequestError("O envio de fotos ainda não está configurado nesta instalação.", 503);
  const paths: string[] = [];
  const discard = () => removeObjects(bucket, paths);

  try {
    for (const photo of photos) {
      const path = `${roundId.toLowerCase()}/${randomUUID()}.${photo.extension}`;
      const { error } = await bucket.upload(path, photo.bytes, { contentType: photo.type, upsert: false });
      if (error) throw error;
      paths.push(path);
      urls.push(bucket.getPublicUrl(path).data.publicUrl);
    }
    return { urls, discard };
  } catch {
    await discard();
    throw new CatalogRequestError("Não foi possível enviar as fotos. Tente novamente.", 502);
  }
}

export async function removeCatalogPhotos(roundId: string, urls: string[]) {
  if (!urls.length) return;
  const bucket = getCatalogBucket();
  if (!bucket) return;
  const folder = `${roundId.toLowerCase()}/`;
  const prefix = bucket.getPublicUrl(folder).data.publicUrl;
  const paths = urls.flatMap((url) => {
    if (!url.startsWith(prefix)) return [];
    const filename = url.slice(prefix.length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp)$/.test(filename)) return [];
    return [folder + filename];
  });
  await removeObjects(bucket, paths);
}
