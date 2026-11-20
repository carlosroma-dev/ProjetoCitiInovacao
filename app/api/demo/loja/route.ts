import { NextResponse } from "next/server";
import { internalError, noStore } from "@/lib/api";
import { openSellerWorkspace } from "@/lib/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const roundId = await openSellerWorkspace();
    return NextResponse.json({ roundId }, { headers: noStore });
  } catch {
    return internalError();
  }
}
