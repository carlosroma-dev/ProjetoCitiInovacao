import "server-only";
import { NextResponse } from "next/server";

export const noStore = { "Cache-Control": "no-store, max-age=0" };
export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}
export function internalError() {
  return jsonError("Erro interno ao acessar a demo.", 500);
}
export const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
