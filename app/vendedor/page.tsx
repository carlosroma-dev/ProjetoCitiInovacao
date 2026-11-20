import Login from "./seller-login";
import { isUuid } from "../../lib/api";

export const metadata = { title: "Área do vendedor | Pátio Voz" };

export default async function SellerPage({ searchParams }: {
  searchParams: Promise<{ rodada?: string | string[]; visita?: string | string[] }>;
}) {
  const { rodada, visita } = await searchParams;
  const roundId = typeof rodada === "string" && isUuid(rodada) ? rodada.toLowerCase() : null;
  const visitId = typeof visita === "string" ? visita : null;
  return <Login roundId={roundId} visitId={visitId} />;
}
