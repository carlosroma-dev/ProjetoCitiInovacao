import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
import { POST as openPublicStore } from "../app/api/demo/loja/route";
import { GET as readPublicRound } from "../app/api/demo/[roundId]/route";
import { PATCH as patchLegacyCar } from "../app/api/demo/[roundId]/cars/[carId]/route";
import { POST as openConversation } from "../app/api/demo/[roundId]/conversations/route";
import { POST as enqueueMessage } from "../app/api/demo/[roundId]/conversations/[conversationId]/messages/route";
import { POST as replyToMessages } from "../app/api/demo/[roundId]/conversations/[conversationId]/messages/reply/route";
import { GET as readSellerRound } from "../app/api/seller/rounds/[roundId]/route";
import { POST as postCar } from "../app/api/seller/rounds/[roundId]/cars/route";
import { PATCH as patchCar } from "../app/api/seller/rounds/[roundId]/cars/[carId]/route";
import { DELETE as logout, GET as readSession, PATCH as restoreWorkspace, POST as login } from "../app/api/seller/session/route";
import { carImageCredit } from "../lib/car-images";
import { CHAT_IDLE_MS, MAX_PRICE_CENTS, type Car, type ConversationHistory, type RoundSnapshot, type SellerSnapshot } from "../lib/contracts";
import { getPool } from "../lib/db";
import { createRound, listAvailableSlots, reserveVisit } from "../lib/demo";

nextEnv.loadEnvConfig(process.cwd());
const email = "seller-verification@example.test";
const password = "seller-verification-password";
process.env.SELLER_DEMO_EMAIL = email;
process.env.SELLER_DEMO_PASSWORD = password;
process.env.SELLER_SESSION_SECRET = "seller-verification-secret-used-only-in-tests";
const baseUrl = "http://localhost:3000";

function jsonRequest(path: string, method: string, body: unknown, cookie = "") {
  return new Request(`${baseUrl}${path}`, {
    method, headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
  });
}

function carForm(photos: File[]) {
  const form = new FormData();
  form.set("name", "Toyota Corolla");
  form.set("model", "GLi 2.0");
  form.set("priceCents", "11990000");
  form.set("status", "available");
  for (const photo of photos) form.append("photos", photo);
  return form;
}

async function verifyChatGallery(roundId: string, conversationId: string, car: Car) {
  const params = { params: Promise.resolve({ roundId, conversationId }) };
  const chatPath = `/api/demo/${roundId}/conversations/${conversationId}/messages`;
  const id = crypto.randomUUID();
  const text = `Vocês têm o ${car.model}?`;
  const queued = await enqueueMessage(jsonRequest(chatPath, "POST", { id, text }), params);
  assert.equal(queued.status, 200, await queued.clone().text());
  await getPool().query(`update patio_voz.chat_messages set created_at = created_at - $4::integer * interval '1 millisecond'
    where round_id = $1 and conversation_id = $2 and id = $3`, [roundId, conversationId, id, CHAT_IDLE_MS]);

  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  const testKey = "seller-catalog-verification";
  process.env.OPENAI_API_KEY = testKey;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${testKey}`);
    const request = JSON.parse(String(init?.body));
    if (request.text.format.name === "patio_voice_reply") return new Response(null, { status: 503 });
    assert.equal(request.text.format.name, "patio_voice_intent");
    const { catalog, message } = JSON.parse(request.input) as { catalog: Pick<Car, "name" | "model" | "available">[]; message: string[] };
    assert.deepEqual(message, [text]);
    assert(catalog.some((item) => item.name === car.name && item.model === car.model && item.available),
      "the next turn sends the newly saved car to the interpreter");
    const intent = {
      car_query: car.model, budget_cents: null, trade_in: null, visit_request: false, period: null, chosen_time: null,
      visit_kind: null, human_request: false, answer: null, ask_photo: false, car_inquiry: true,
      car_details: [], asks_question: true, social: null, wants_audio: false, understood: true,
    };
    return Response.json({
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(intent) }] }],
    });
  };
  try {
    const result = await replyToMessages(new Request(`${baseUrl}${chatPath}/reply`, { method: "POST" }), params);
    assert.equal(result.status, 200, await result.clone().text());
    const history = await result.json() as ConversationHistory;
    assert.equal(history.pending, false);
    const reply = history.messages.at(-1);
    assert(reply?.role === "assistant");
    assert.deepEqual(reply.reply.photo, car, "the open chat returns the saved vehicle with the real photo URLs in upload order");
    assert.match(reply.reply.message, /119\.900/, "the chat quotes the price saved in the seller panel");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  assert(supabaseUrl && supabaseKey, "Configure Supabase Storage before verifying the seller catalog");
  const bucketName = process.env.SUPABASE_CATALOG_BUCKET || "catalogo";
  const seedCatalogUrl = "https://seed-fixture.supabase.co/storage/v1/object/public/catalogo";
  process.env.SUPABASE_CATALOG_URL = seedCatalogUrl;
  const storage = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }).storage.from(bucketName);

  const roundId = await createRound();
  const anotherRoundId = await createRound();
  const params = Promise.resolve({ roundId });
  const sellerPath = `/api/seller/rounds/${roundId}`;
  const sessionPath = "/api/seller/session";
  const anonymous = new Request(`${baseUrl}${sellerPath}`);
  assert.equal((await readSellerRound(anonymous, { params })).status, 401, "seller snapshot requires authentication");
  assert.equal((await login(jsonRequest(sessionPath, "POST", { email, password: "wrong" }))).status, 401);

  const workspaceLogins = await Promise.all(Array.from({ length: 3 }, () => login(jsonRequest(sessionPath, "POST", { email, password }))));
  assert(workspaceLogins.every((response) => response.ok), "seller workspace opens under concurrent logins");
  const workspaces = await Promise.all(workspaceLogins.map((response) => response.json() as Promise<{ roundId: string }>));
  assert.equal(new Set(workspaces.map((workspace) => workspace.roundId)).size, 1, "seller workspace round is stable");
  const workspaceId = workspaces[0].roundId;
  const publicStore = await openPublicStore();
  assert.equal(publicStore.status, 200);
  assert.equal(publicStore.headers.get("set-cookie"), null, "opening the public chat does not grant a seller session");
  assert.deepEqual(await publicStore.json(), { roundId: workspaceId }, "public store and seller panel use the same round");
  const publicParams = { params: Promise.resolve({ roundId: workspaceId }) };
  assert.equal((await readSellerRound(anonymous, publicParams)).status, 401, "the shared round still has a protected panel");

  const session = await login(jsonRequest(sessionPath, "POST", { email, password, roundId }));
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { roundId });
  const setCookie = session.headers.get("set-cookie");
  assert(setCookie?.includes("HttpOnly") && /SameSite=strict/i.test(setCookie));
  const cookie = setCookie!.split(";")[0];
  const newSellerRequest = (path: string, init: RequestInit = {}) => new Request(`${baseUrl}${path}`, { ...init, headers: { cookie } });
  assert.deepEqual(await (await readSession(newSellerRequest(sessionPath))).json(), { roundId });
  assert.equal((await readSession(new Request(`${baseUrl}${sessionPath}`, { headers: { cookie: cookie.replace(roundId, anotherRoundId) } }))).status, 401);
  assert.equal((await readSellerRound(newSellerRequest(sellerPath), { params: Promise.resolve({ roundId: anotherRoundId }) })).status, 403);

  assert.equal((await restoreWorkspace(new Request(`${baseUrl}${sessionPath}`, { method: "PATCH" }))).status, 401);
  const restored = await restoreWorkspace(newSellerRequest(sessionPath, { method: "PATCH" }));
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), { roundId: workspaceId }, "a session in a public demo returns to the persistent workspace");
  const workspaceCookie = restored.headers.get("set-cookie")?.split(";")[0];
  assert(workspaceCookie);
  const workspaceRequest = new Request(`${baseUrl}${sessionPath}`, { headers: { cookie: workspaceCookie } });
  assert.deepEqual(await (await readSession(workspaceRequest)).json(), { roundId: workspaceId });
  assert.equal((await readSellerRound(workspaceRequest, { params })).status, 403, "the restored session is scoped to the workspace");

  const reviewer = { email: "reviewer@example.test", password: "reviewer-verification-password" };
  process.env.SELLER_REVIEW_EMAIL = reviewer.email;
  process.env.SELLER_REVIEW_PASSWORD = reviewer.password;
  assert.equal((await login(jsonRequest(sessionPath, "POST", { email: reviewer.email, password }))).status, 401);
  const reviewerLogin = await login(jsonRequest(sessionPath, "POST", { ...reviewer, roundId }));
  assert.equal(reviewerLogin.status, 200);
  const reviewerCookie = reviewerLogin.headers.get("set-cookie")?.split(";")[0];
  assert(reviewerCookie);
  const restoredReviewer = await restoreWorkspace(new Request(`${baseUrl}${sessionPath}`, { method: "PATCH", headers: { cookie: reviewerCookie } }));
  assert.equal(restoredReviewer.status, 200);
  const restoredReviewerCookie = restoredReviewer.headers.get("set-cookie")?.split(";")[0];
  assert(restoredReviewerCookie);
  const reviewerRequest = new Request(`${baseUrl}${sessionPath}`, { headers: { cookie: restoredReviewerCookie } });
  assert.deepEqual(await (await readSession(reviewerRequest)).json(), { roundId: workspaceId });
  delete process.env.SELLER_REVIEW_PASSWORD;
  assert.equal((await readSession(reviewerRequest)).status, 401, "removing review access expires reviewer sessions");
  assert.equal((await readSession(workspaceRequest)).status, 200, "review access is independent of the owner account");

  const open = await openConversation(new Request(`${baseUrl}/api/demo/${roundId}/conversations`, { method: "POST" }), { params });
  assert.equal(open.status, 201, await open.clone().text());
  const { conversationId } = await open.json() as { conversationId: string };

  const imagePaths = ["vw-polo.webp", "renault-kwid.webp", "fiat-argo.webp"];
  const originals = await Promise.all(imagePaths.map((name) => readFile(`public/images/${name}`)));
  const photos = originals.map((bytes, index) => new File([bytes], imagePaths[index], { type: "image/webp" }));
  const submit = (form: FormData) => postCar(newSellerRequest(`${sellerPath}/cars`, { method: "POST", body: form }), { params });
  const invalid = new File(["<svg>imagem falsa</svg>"], "foto.png", { type: "image/png" });
  assert.equal((await submit(carForm([invalid]))).status, 415, "disguised SVG is rejected");
  assert.equal((await submit(carForm([...photos, photos[0]]))).status, 400, "more than three photos are rejected");

  const created = await submit(carForm(photos));
  assert.equal(created.status, 201, await created.clone().text());
  const { car } = await created.json() as { car: Car };
  assert.equal(car.name, "Toyota Corolla");
  assert.equal(car.model, "GLi 2.0");
  assert.equal(car.priceCents, 11_990_000);
  assert.equal(car.status, "available");
  assert(car.imageUrls?.length === 3 && car.imageUrl === car.imageUrls[0]);
  for (const [index, url] of car.imageUrls.entries()) {
    assert(new URL(url).pathname.startsWith(`/storage/v1/object/public/${bucketName}/${roundId}/`));
    const photo = await fetch(url);
    assert.equal(photo.status, 200, "photo downloads from Supabase Storage");
    assert.equal(photo.headers.get("content-type"), "image/webp");
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), originals[index], "download contains the original bytes");
  }
  await verifyChatGallery(roundId, conversationId, car);

  const carParams = Promise.resolve({ roundId, carId: car.id });
  const legacyPath = `/api/demo/${roundId}/cars/${car.id}`;
  assert.equal((await patchLegacyCar(jsonRequest(legacyPath, "PATCH", { priceCents: 99 }), { params: carParams })).status, 401);
  assert.equal((await patchLegacyCar(jsonRequest(legacyPath, "PATCH", { priceCents: MAX_PRICE_CENTS + 1 }, cookie), { params: carParams })).status, 400);
  assert.equal((await patchLegacyCar(jsonRequest(legacyPath, "PATCH", { priceCents: 99 }, cookie), {
    params: Promise.resolve({ roundId: anotherRoundId, carId: car.id }),
  })).status, 403);

  const update = (body: FormData) => patchCar(newSellerRequest(`${sellerPath}/cars/${car.id}`, { method: "PATCH", body }), { params: carParams });
  const append = new FormData();
  append.append("photos", photos[0]);
  assert.equal((await update(append)).status, 400, "appending a fourth photo leaves the gallery unchanged");
  const afterAppend = await storage.list(roundId);
  assert.equal(afterAppend.error, null);
  assert.equal(afterAppend.data.length, 3, "upload is cleaned up when the database rejects the gallery");

  const readSnapshot = async () => {
    const response = await readSellerRound(newSellerRequest(sellerPath), { params });
    assert.equal(response.status, 200);
    return await response.json() as SellerSnapshot;
  };
  const before = await readSnapshot();
  assert.deepEqual(before.cars.at(-1), car, "seller snapshot returns the new vehicle and all photos");
  const hb20 = before.cars.find((item) => item.name.startsWith("Hyundai HB20"));
  assert(hb20);
  assert.deepEqual(hb20.imageUrls, [`${seedCatalogUrl}/images/hyundai-hb20-2025.webp`]);
  assert.equal(hb20.imageUrl, hb20.imageUrls[0]);
  assert.equal(carImageCredit(hb20, hb20.imageUrl)?.source, "Hyundai HB20 · Just a Man");
  assert.equal(carImageCredit(hb20, car.imageUrl), null, "an uploaded photo does not get a seed credit");
  const availableSlots = await listAvailableSlots(roundId, car.id);
  assert(availableSlots.length >= 12, "the agenda seeds at least three full Saturdays");
  const reservation = { roundId, conversationId, turnId: "first-reservation", slotId: availableSlots[0].id, carId: car.id, tradeIn: "Palio" };
  const booking = await reserveVisit(reservation);
  assert(booking.ok);

  const edited = await patchCar(jsonRequest(`${sellerPath}/cars/${car.id}`, "PATCH", {
    name: "Toyota Corolla Seminovo", model: "GLi", priceCents: 11_590_000, status: "sold", move: "up",
  }, cookie), { params: carParams });
  assert.equal(edited.status, 200, await edited.clone().text());
  const after = await readSnapshot();
  const sold = after.cars.at(-2);
  assert.equal(sold?.id, car.id, "moved vehicle is one place higher");
  assert.equal(sold?.priceCents, 11_590_000);
  assert.equal(sold?.name, "Toyota Corolla Seminovo");
  assert.equal(sold?.model, "GLi");
  assert.equal(sold?.status, "sold");
  assert.equal(sold?.available, false);
  assert.deepEqual(sold?.imageUrls, car.imageUrls);
  assert.deepEqual(after.slots.find((slot) => slot.id === availableSlots[0].id), { ...availableSlots[0], visitId: booking.visit.id });
  assert.equal(after.visits[0]?.id, booking.visit.id, "booking is retained across catalog changes");
  assert.equal(after.visits[0]?.tradeIn, "Palio");
  assert.deepEqual(await reserveVisit({ ...reservation, turnId: "another-reservation", slotId: availableSlots[1].id }), { ok: false, reason: "car_unavailable" });
  const readPublicSnapshot = async () => await (await readPublicRound(new Request(`${baseUrl}/api/demo/${roundId}`), { params })).json() as RoundSnapshot;
  const publicSnapshot = await readPublicSnapshot();
  assert.deepEqual(publicSnapshot.visits, []);
  assert(!publicSnapshot.cars.some((item) => item.status === "hidden"));
  assert.equal(publicSnapshot.cars.find((item) => item.id === car.id)?.status, "sold");

  const replacement = new FormData();
  replacement.set("status", "hidden");
  replacement.set("replacePhotos", "true");
  replacement.append("photos", photos[1]);
  assert.equal((await update(replacement)).status, 200);
  assert(!(await readPublicSnapshot()).cars.some((item) => item.id === car.id), "newly hidden vehicle is removed from the public catalog");
  const removeAll = new FormData();
  removeAll.set("replacePhotos", "true");
  assert.equal((await update(removeAll)).status, 200);
  const removed = await storage.list(roundId);
  assert.equal(removed.error, null);
  assert.deepEqual(removed.data, [], "replaced files are removed from the round folder in Storage");

  assert.match((await logout()).headers.get("set-cookie") ?? "", /Max-Age=0/i);
  console.log("Seller verification passed: shared public entry, scoped login, real Supabase photos in an open chat, gallery cleanup, catalog ordering, visits and status.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Seller verification failed");
  process.exitCode = 1;
}).finally(() => getPool().end());
