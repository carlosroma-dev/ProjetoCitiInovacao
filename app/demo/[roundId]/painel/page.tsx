import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isUuid } from "@/lib/api";
import { getSellerRoundId } from "@/lib/seller-session";
import PainelClient from "./painel-client";
import { sellerLoginHref } from "./painel-data";

export const metadata = { title: "Painel da revenda | Pátio Voz" };

export default async function PainelPage({
  params,
  searchParams,
}: {
  params: Promise<{ roundId: string }>;
  searchParams: Promise<{ visita?: string | string[] }>;
}) {
  const [{ roundId: requestedRound }, { visita }, requestHeaders] = await Promise.all([params, searchParams, headers()]);
  if (!isUuid(requestedRound)) notFound();
  const roundId = requestedRound.toLowerCase();
  const highlightId = typeof visita === "string" ? visita : null;
  if (getSellerRoundId({ headers: requestHeaders }) !== roundId) redirect(sellerLoginHref(roundId, highlightId));
  return <PainelClient key={`${roundId}:${highlightId ?? ""}`} roundId={roundId} highlightId={highlightId} />;
}
