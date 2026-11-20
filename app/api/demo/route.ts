import { NextResponse } from "next/server";
import { createRound } from "@/lib/demo";
import { internalError, noStore } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const roundId = await createRound();
    return NextResponse.json({ roundId }, { status: 201, headers: noStore });
  } catch {
    return internalError();
  }
}
