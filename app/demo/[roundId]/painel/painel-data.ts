import type { Car, CarStatus, SellerSlot, Visit } from "../../../../lib/contracts";

export const timeZone = "America/Sao_Paulo";
const moneyFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const isoDate = new Intl.DateTimeFormat("en-CA", {
  timeZone, year: "numeric", month: "2-digit", day: "2-digit",
});
const clock = new Intl.DateTimeFormat("pt-BR", {
  timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const fullDate = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "UTC", weekday: "long", day: "numeric", month: "long",
});
const shortDate = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "UTC", day: "numeric", month: "short",
});
const monthDate = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "UTC", month: "long", year: "numeric",
});

export const carStatuses: Record<CarStatus, string> = {
  available: "Disponível",
  hidden: "Oculto",
  sold: "Vendido",
};

export function carStatus(car: Car): CarStatus {
  return car.status ?? (car.available ? "available" : "hidden");
}

export function carPhotos(car: Car) {
  if (car.imageUrls?.length) return car.imageUrls;
  return car.imageUrl ? [car.imageUrl] : [];
}

export function money(cents: number) {
  return moneyFormat.format(cents / 100);
}

export function dateKey(value: string | Date) {
  const parts = Object.fromEntries(isoDate.formatToParts(new Date(value)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function timeLabel(value: string) {
  return clock.format(new Date(value));
}

export function dateLabel(key: string, short = false) {
  const value = (short ? shortDate : fullDate).format(new Date(`${key}T12:00:00Z`));
  return value.charAt(0).toLocaleUpperCase("pt-BR") + value.slice(1);
}

export function monthLabel(key: string) {
  return monthDate.format(new Date(`${key}-01T12:00:00Z`));
}

export function monthKey(date: Date) {
  return date.toISOString().slice(0, 7);
}

export function sortChronologically<T extends { startsAt: string }>(a: T, b: T) {
  return Date.parse(a.startsAt) - Date.parse(b.startsAt);
}

export function groupSchedule(visits: Visit[], slots: SellerSlot[]) {
  const days = new Map<string, { visits: Visit[]; free: SellerSlot[]; reserved: number }>();
  const day = (startsAt: string) => {
    const key = dateKey(startsAt);
    const existing = days.get(key);
    if (existing) return existing;
    const next = { visits: [] as Visit[], free: [] as SellerSlot[], reserved: 0 };
    days.set(key, next);
    return next;
  };
  const knownVisits = new Set(visits.map((visit) => visit.id));
  for (const visit of [...visits].sort(sortChronologically)) {
    const date = day(visit.startsAt);
    date.visits.push(visit);
    date.reserved++;
  }
  for (const slot of [...slots].sort(sortChronologically)) {
    const date = day(slot.startsAt);
    if (!slot.visitId) date.free.push(slot);
    else if (!knownVisits.has(slot.visitId)) date.reserved++;
  }
  return days;
}

export function sellerPanelHref(roundId: string, visitId?: string | null) {
  const path = `/demo/${encodeURIComponent(roundId)}/painel`;
  return visitId ? `${path}?visita=${encodeURIComponent(visitId)}` : path;
}

export function sellerLoginHref(roundId: string, visitId?: string | null) {
  const query = new URLSearchParams({ rodada: roundId });
  if (visitId) query.set("visita", visitId);
  return `/vendedor?${query}`;
}

export async function responseError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  return fallback;
}
