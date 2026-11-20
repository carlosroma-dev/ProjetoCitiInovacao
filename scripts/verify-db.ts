import assert from "node:assert/strict";
import nextEnv from "@next/env";
import { NextResponse } from "next/server";
import { createConversation, createRound, editCar, getRoundSnapshot, getSellerRoundSnapshot, listOpenSlotsOnDate, listPreferredSlots, reservePreferredVisit } from "../lib/demo";
import type { SellerSlot } from "../lib/contracts";
import { getPool } from "../lib/db";
import { PATCH as patchCar } from "../app/api/demo/[roundId]/cars/[carId]/route";
import { setSellerSession } from "../lib/seller-session";

nextEnv.loadEnvConfig(process.cwd());
process.env.SELLER_DEMO_EMAIL = "seller-verification@example.test";
process.env.SELLER_DEMO_PASSWORD = "seller-verification-password";
process.env.SELLER_SESSION_SECRET = "seller-verification-secret-used-only-in-tests";

async function main() {
  const roundId = await createRound();
  const snapshot = await getRoundSnapshot(roundId);
  assert(snapshot && snapshot.cars.length === 4, "round seeds four cars");
  const hb20 = snapshot.cars.find((car) => car.name.startsWith("Hyundai HB20"));
  assert(hb20?.available, "HB20 starts available");
  const agendaDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", dateStyle: "short" });
  const agendaTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const { rows: [{ now }] } = await getPool().query<{ now: Date }>("select statement_timestamp() as now");
  const seller = await getSellerRoundSnapshot(roundId);
  assert(seller);
  const today = agendaDay.format(now);
  const days = [...new Set(seller.slots.map(({ startsAt }) => agendaDay.format(new Date(startsAt))))];
  const completeDays = Array.from({ length: 27 }, (_, index) =>
    new Date(Date.parse(today) + (index + 1) * 86_400_000).toISOString().slice(0, 10));
  assert.deepEqual(days.filter((day) => day > today), completeDays, "the agenda includes every day in the four-week window");
  assert(seller.slots.every(({ startsAt }) => new Date(startsAt) > now), "only future starts are open");
  const dailyTimes = Array.from({ length: 21 }, (_, index) =>
    `${String(8 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`);
  const dailySchedule = dailyTimes.flatMap((time) => [[time, "Júlia"], [time, "Rafa"]]);
  for (const day of completeDays) {
    const dateSlots: SellerSlot[] = seller.slots.filter(({ startsAt }) => agendaDay.format(new Date(startsAt)) === day);
    assert.deepEqual(dateSlots.map(({ startsAt, sellerName }) => [agendaTime.format(new Date(startsAt)), sellerName]), dailySchedule,
      "both sellers have half-hour starts from 08:00 through 18:00 in Sao Paulo local time");
  }
  const localDate = completeDays[0];
  const openTimes = async () => (await listOpenSlotsOnDate(roundId, localDate)).map(({ startsAt }) => agendaTime.format(new Date(startsAt)));
  assert.deepEqual(await openTimes(), dailyTimes, "customer availability lists each start once");
  assert.deepEqual(await listOpenSlotsOnDate(roundId, "2026-02-30"), [], "invalid dates do not query availability");
  const firstMorning = seller.slots.find(({ startsAt, sellerId }) => agendaDay.format(new Date(startsAt)) === localDate
    && agendaTime.format(new Date(startsAt)) === "09:00" && sellerId === "julia");
  assert(firstMorning);
  const convA = await createConversation(roundId, { budgetCents: 8_000_000 });
  const convB = await createConversation(roundId, { tradeIn: "Palio" });
  const convC = await createConversation(roundId);
  assert(convA && convB && convC && convA.id !== convB.id && convA.id !== convC.id && convB.id !== convC.id, "conversations have distinct IDs");
  const requestA = { roundId, conversationId: convA.id, turnId: "turn-same-slot", localDate, localTime: "09:00", carId: hb20.id, tradeIn: "Palio", budgetCents: 8_000_000, summary: "Quer conhecer o HB20 e avaliar o Palio." };
  const requestB = { ...requestA, conversationId: convB.id };
  const first = await reservePreferredVisit(requestA);
  assert(first.ok);
  assert.equal(first.visit.sellerName, "Júlia");
  assert.deepEqual(await openTimes(), dailyTimes, "customers can still book a start with one seller free");
  assert.deepEqual((await listPreferredSlots(roundId, localDate, "09:00")).map(({ sellerName }) => sellerName), ["Rafa"]);
  const competingRequests = [requestB, { ...requestA, conversationId: convC.id }];
  const competingResults = await Promise.all(competingRequests.map(reservePreferredVisit));
  assert.deepEqual(competingResults.flatMap((result) => result.ok ? [result.visit.sellerName] : []), ["Rafa"],
    "only one concurrent reservation can take the remaining seller slot");
  assert.equal(competingResults.filter((result) => !result.ok && result.reason === "slot_taken").length, 1);
  assert.deepEqual(await openTimes(), dailyTimes.filter((time) => time !== "09:00"), "fully occupied starts disappear from customer availability");
  assert.deepEqual(await listPreferredSlots(roundId, localDate, "09:00"), []);
  const retry = await reservePreferredVisit(requestA);
  assert(retry.ok && retry.idempotent && retry.visit.id === first.visit.id, "retry returns same visit");
  const wrongRoundReplay = await reservePreferredVisit({ ...requestA, roundId: crypto.randomUUID() });
  assert(!wrongRoundReplay.ok && wrongRoundReplay.reason === "not_found", "replay cannot cross round scope");
  const after = await getSellerRoundSnapshot(roundId);
  assert.deepEqual(after?.slots.find((slot) => slot.id === firstMorning.id), { ...firstMorning, visitId: first.visit.id },
    "seller agenda links the assigned slot to the visit");
  const originalPrice = hb20.priceCents;
  const edited = await editCar(roundId, hb20.id, { priceCents: originalPrice - 100_000 });
  assert.equal(edited?.priceCents, originalPrice - 100_000, "car price edit is persisted");
  const session = new NextResponse();
  setSellerSession(session, roundId);
  const cookie = session.headers.get("set-cookie")?.split(";")[0];
  assert(cookie, "seller session has a cookie");
  const oversizedPatch = await patchCar(new Request("http://localhost/api/demo/round/cars/car", {
    method: "PATCH", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ priceCents: 2_147_483_648 }),
  }), { params: Promise.resolve({ roundId, carId: hb20.id }) });
  assert.equal(oversizedPatch.status, 400, "PATCH rejects values above PostgreSQL INTEGER");
  const oversizedBody = await oversizedPatch.json() as { error: string };
  assert.match(oversizedBody.error, /2_147_483_647|2147483647/, "validation error includes the valid upper bound");
  await editCar(roundId, hb20.id, { priceCents: 8_100_000 });
  const overBudget = await reservePreferredVisit({ ...requestA, turnId: "turn-over-budget", localTime: "14:00" });
  assert.deepEqual(overBudget, { ok: false, reason: "over_budget", priceCents: 8_100_000, budgetCents: 8_000_000 });
  assert.equal((await listPreferredSlots(roundId, localDate, "14:00")).length, 2, "price rejection leaves both seller slots free");
  await editCar(roundId, hb20.id, { available: false });
  const [sameKeyA, sameKeyB] = await Promise.all([reservePreferredVisit(requestA), reservePreferredVisit(requestA)]);
  assert(sameKeyA.ok && sameKeyB.ok && sameKeyA.idempotent && sameKeyB.idempotent, "concurrent same-key retries replay after car edit");
  assert.equal(sameKeyA.visit.id, first.visit.id);
  assert.equal(sameKeyB.visit.id, first.visit.id);
  const nextRound = await createRound();
  const isolated = await getRoundSnapshot(nextRound);
  assert.equal(isolated?.visits.length, 0, "round data is isolated");
  assert.equal(isolated?.cars.find((car) => car.name.startsWith("Hyundai HB20"))?.priceCents, originalPrice, "new round retains seed price");
  console.log("Database verification passed: round isolation, seller schedules, booking races, scoped idempotency, and edits.");
}

main().finally(() => getPool().end()).catch((error) => {
  console.error(error instanceof Error ? error.message : "Database verification failed");
  process.exitCode = 1;
});
