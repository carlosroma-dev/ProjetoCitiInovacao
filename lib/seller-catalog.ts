import "server-only";
import { internalError, jsonError } from "./api";
import { CatalogRequestError, readCatalogPhotos, type CatalogPhoto } from "./catalog-photos";
import { MAX_PRICE_CENTS, type CarStatus } from "./contracts";
import { isRecord } from "./db";
import { CatalogPhotoLimitError } from "./demo";

const maxMultipartBytes = 4_400_000;
const fields = ["name", "model", "priceCents", "status"] as const;
type CarFields = { name: string; model: string; priceCents: number; status: CarStatus };
type CarEdits = Partial<CarFields> & { move?: "up" | "down"; replacePhotos?: boolean };

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120 || value.includes("\0")) {
    throw new CatalogRequestError(`Informe ${label} com até 120 caracteres.`, 400);
  }
  return value.trim();
}

function readCarFields(body: Record<string, unknown>, multipart: boolean): Partial<CarFields> {
  const changes: Partial<CarFields> = {};
  if ("name" in body) changes.name = readText(body.name, "o nome do veículo");
  if ("model" in body) changes.model = readText(body.model, "o modelo do veículo");
  if ("priceCents" in body) {
    const amount = multipart && typeof body.priceCents === "string" && /^\d+$/.test(body.priceCents) ? Number(body.priceCents) : body.priceCents;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > MAX_PRICE_CENTS) {
      throw new CatalogRequestError(`Informe o preço em centavos entre 0 e ${MAX_PRICE_CENTS}.`, 400);
    }
    changes.priceCents = amount;
  }
  if ("status" in body) {
    const status = body.status;
    if (status !== "available" && status !== "hidden" && status !== "sold") throw new CatalogRequestError("Estado do veículo inválido.", 400);
    changes.status = status;
  }
  return changes;
}

function requestType(request: Request) {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

async function readMultipart(request: Request, allowReplace: boolean) {
  const invalidSize = () => new CatalogRequestError("O envio deve ter até 4,4 MB no total.", 413);
  if (Number(request.headers.get("content-length")) > maxMultipartBytes) throw invalidSize();
  const reader = request.body?.getReader();
  if (!reader) throw new CatalogRequestError("Formulário inválido.", 400);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxMultipartBytes) {
      await reader.cancel();
      throw invalidSize();
    }
    chunks.push(Buffer.from(value));
  }

  let form: FormData;
  try {
    const response = new Response(Buffer.concat(chunks, total), { headers: { "content-type": request.headers.get("content-type")! } });
    form = await response.formData();
  } catch {
    throw new CatalogRequestError("Formulário inválido.", 400);
  }
  const allowed = new Set<string>([...fields, "photos", ...(allowReplace ? ["replacePhotos"] : [])]);
  const body: Record<string, unknown> = {};
  form.forEach((value, key) => {
    if (!allowed.has(key) || key in body) throw new CatalogRequestError("Campos do formulário inválidos.", 400);
    if (key !== "photos") body[key] = value;
  });
  const changes = readCarFields(body, true);
  const replacePhotos = body.replacePhotos;
  if (replacePhotos !== undefined && replacePhotos !== "true" && replacePhotos !== "false") {
    throw new CatalogRequestError("Valor de replacePhotos inválido.", 400);
  }
  const photos = await readCatalogPhotos(form.getAll("photos"));
  return { changes, photos, replacePhotos: replacePhotos === "true" };
}

export async function readNewCatalogCar(request: Request) {
  if (requestType(request) !== "multipart/form-data") throw new CatalogRequestError("Envie o cadastro em multipart/form-data.", 415);
  const { changes, photos } = await readMultipart(request, false);
  const { name, model, priceCents, status } = changes;
  if (name === undefined || model === undefined || priceCents === undefined || status === undefined) {
    throw new CatalogRequestError("Informe o nome, modelo, preço e estado do veículo.", 400);
  }
  return { car: { name, model, priceCents, status }, photos };
}

export async function readCatalogEdits(request: Request): Promise<{ changes: CarEdits; photos: CatalogPhoto[] }> {
  const type = requestType(request);
  if (type === "multipart/form-data") {
    const { changes, photos, replacePhotos } = await readMultipart(request, true);
    if (!Object.keys(changes).length && !photos.length && !replacePhotos) throw new CatalogRequestError("Informe os campos para editar.", 400);
    return { changes: { ...changes, replacePhotos }, photos };
  }
  if (type !== "application/json") throw new CatalogRequestError("Envie a edição em JSON ou multipart/form-data.", 415);
  let body: unknown;
  try { body = await request.json(); } catch { throw new CatalogRequestError("JSON inválido.", 400); }
  const allowed = new Set<string>([...fields, "move"]);
  if (!isRecord(body) || !Object.keys(body).length || Object.keys(body).some((key) => !allowed.has(key))) {
    throw new CatalogRequestError("Campos do veículo inválidos.", 400);
  }
  const move = body.move;
  if (move !== undefined && move !== "up" && move !== "down") throw new CatalogRequestError("Use up ou down para mover o veículo.", 400);
  return { changes: { ...readCarFields(body, false), move }, photos: [] };
}

export function respondToCatalogError(error: unknown) {
  if (error instanceof CatalogRequestError) return jsonError(error.message, error.status);
  if (error instanceof CatalogPhotoLimitError) return jsonError(error.message, 400);
  return internalError();
}
