import assert from "node:assert/strict";
import nextEnv from "@next/env";
import { sendSellerHandoffMessage } from "../lib/chat-history";
import { MAX_CHAT_BATCH_MESSAGES, type ConversationHistory, type TurnReply } from "../lib/contracts";
import { addCatalogCar, changeCatalogCar, createConversation, createRound, getConversation, getConversationTurn, getRoundSnapshot, getSellerRoundSnapshot, getVisitForTurn, listPreferredSlots, reservePreferredVisit } from "../lib/demo";
import { getPool } from "../lib/db";
import { handleAudioTurn, handleTurn, selectsAutomaticAudio, synthesizeTurnAudio, VoiceError } from "../lib/voice";
import { consumeTurnAttempt } from "../lib/quotas";
import { POST as openConversation } from "../app/api/demo/[roundId]/conversations/route";
import { POST as postTurn } from "../app/api/demo/[roundId]/conversations/[conversationId]/turns/route";
import { GET as readMessages, POST as enqueueMessage } from "../app/api/demo/[roundId]/conversations/[conversationId]/messages/route";
import { POST as replyToMessages } from "../app/api/demo/[roundId]/conversations/[conversationId]/messages/reply/route";

nextEnv.loadEnvConfig(process.cwd());
process.env.OPENAI_API_KEY = "voice-test-double";
process.env.ELEVENLABS_API_KEY = "voice-test-double";
process.env.ELEVENLABS_VOICE_ID = "voice-test-pt-br";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const completedResponse = (payload: unknown) => json({
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
});
type StubIntent = Record<string, string | number | boolean | string[] | null>;
function sampledTurn(selected: boolean): string {
  let id = crypto.randomUUID();
  while (selectsAutomaticAudio(id) !== selected) id = crypto.randomUUID();
  return id;
}
function verifyBubbles(reply: TurnReply) {
  assert(reply.bubbles?.length && reply.bubbles.length <= 3, "a reply has up to three text bubbles");
  assert.equal(reply.bubbles.join(" "), reply.message, "the rendered bubbles preserve the full reply");
  return reply.bubbles;
}
async function main() {
  const pool = getPool();
  const roundId = await createRound();
  const conversation = await createConversation(roundId);
  assert(conversation);
  const snapshot = await getRoundSnapshot(roundId);
  assert(snapshot);
  const hb20 = snapshot.cars.find((car) => car.name.startsWith("Hyundai HB20"));
  assert(hb20);
  const agenda = await getSellerRoundSnapshot(roundId);
  const agendaTime = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", timeStyle: "short" });
  const morning = agenda?.slots.find(({ startsAt }) => agendaTime.format(new Date(startsAt)) === "09:00");
  const laterMorning = agenda?.slots.find(({ startsAt }) => morning && Date.parse(startsAt) - Date.parse(morning.startsAt) > 86_400_000
    && agendaTime.format(new Date(startsAt)) === "09:00");
  assert(morning && laterMorning);
  const isoDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", dateStyle: "short" });
  const shortDate = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" });
  const localDate = isoDate.format(new Date(morning.startsAt));
  const saturday = shortDate.format(new Date(morning.startsAt));
  const laterSaturday = shortDate.format(new Date(laterMorning.startsAt));
  const firstTranscript = `Quero visitar o HB20 dia ${saturday} de manhã, tenho um Palio na troca e meu teto é 80 mil.`;
  const originalFetch = globalThis.fetch;
  const intentResponses: StubIntent[] = [
    { car_query: "HB20", budget_cents: 8_000_000, trade_in: "Palio", visit_request: true, visit_kind: "schedule", period: "morning", chosen_time: null, ask_photo: false, asks_question: false, understood: true },
    { car_query: null, budget_cents: null, trade_in: null, visit_request: true, visit_kind: "choose", period: null, chosen_time: "10:30", ask_photo: false, asks_question: false, understood: true },
    { car_query: "HB20", budget_cents: null, trade_in: null, visit_request: false, period: null, chosen_time: null, ask_photo: true, asks_question: false, understood: true },
    { car_query: "HB20", budget_cents: null, trade_in: null, visit_request: true, visit_kind: "schedule", period: "morning", chosen_time: null, ask_photo: true, asks_question: false, understood: true },
    { car_query: null, budget_cents: 6_000_000, trade_in: null, visit_request: false, period: null, chosen_time: null, ask_photo: false, asks_question: false, understood: true },
    { car_query: "HB20", budget_cents: null, trade_in: null, visit_request: true, visit_kind: "choose", period: null, chosen_time: "10:30", ask_photo: false, asks_question: false, understood: true },
    { car_query: "o branco", budget_cents: null, trade_in: null, visit_request: false, period: null, chosen_time: null, ask_photo: true, asks_question: false, understood: true },
    { car_query: null, budget_cents: null, trade_in: null, visit_request: false, period: null, chosen_time: "10:30", ask_photo: false, asks_question: false, understood: false },
  ];
  let processingCalls = 0;
  let transcriptionCalls = 0;
  let replyCalls = 0;
  let nextWriterReply: ((input: Record<string, unknown>) => unknown) | undefined;
  let lastInterpreterCatalog: Array<{ name: string; model?: string; available: boolean }> = [];
  let lastInterpreterInput: { message?: unknown; context?: Record<string, unknown> } = {};
  let ttsText = "";
  let ttsCalls = 0;
  let failSynthesis = false;
  let beforeInterpretAnswer: (() => Promise<unknown>) | undefined;
  const transcripts = [
    firstTranscript, "Pode marcar às 10h30.", "Pode mandar as fotos do HB20?",
    `Quero agendar o HB20 dia ${laterSaturday} de manhã e ver a foto.`, "Meu teto agora é 60 mil.",
    "Pode marcar o HB20 às 10h30.", "Tem foto do branco?", "Pode marcar às 10h30.",
  ];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.openai.com/v1/audio/transcriptions") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer voice-test-double");
      assert(init?.body instanceof FormData);
      assert.equal(init.body.get("model"), "gpt-transcribe");
      assert.equal(init.body.get("languages[]"), "pt");
      const file = init.body.get("file");
      assert(file instanceof File);
      assert.equal(file.name, "audio.webm");
      processingCalls++;
      transcriptionCalls++;
      return json({ text: transcripts[transcriptionCalls - 1] ?? "audio de teste" });
    }
    if (url === "https://api.openai.com/v1/responses") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer voice-test-double");
      const request = JSON.parse(String(init?.body));
      assert.equal(request.model, "gpt-6-luna");
      assert.equal(request.store, false);
      assert.equal(request.text.format.strict, true);
      if (request.text.format.name === "patio_voice_reply") {
        replyCalls++;
        const respond = nextWriterReply;
        nextWriterReply = undefined;
        if (respond) return completedResponse(respond(JSON.parse(request.input)));
        return json({ error: "temporary OpenAI failure" }, 503);
      }
      assert.equal(request.text.format.name, "patio_voice_intent");
      const intent = intentResponses.shift();
      assert(intent, "unexpected extra interpreter call");
      processingCalls++;
      const interpreterInput = JSON.parse(request.input);
      lastInterpreterInput = interpreterInput;
      lastInterpreterCatalog = interpreterInput.catalog;
      const edit = beforeInterpretAnswer;
      beforeInterpretAnswer = undefined;
      await edit?.();
      return completedResponse({
        visit_kind: null, human_request: false, answer: null, social: null, car_inquiry: false, car_details: [], wants_audio: false, ...intent,
      });
    }
    if (url.includes("/text-to-speech/")) {
      assert.equal(url, "https://api.elevenlabs.io/v1/text-to-speech/voice-test-pt-br?output_format=mp3_44100_128");
      assert.equal(new Headers(init?.headers).get("xi-api-key"), "voice-test-double");
      ttsCalls++;
      const tts = JSON.parse(String(init?.body));
      assert.equal(tts.model_id, "eleven_flash_v2_5");
      assert.equal(tts.language_code, "pt");
      ttsText = String(tts.text);
      if (ttsCalls === 1 || failSynthesis) return json({ error: "temporary provider failure" }, 503);
      return new Response(new Uint8Array([73, 68, 51, 1]), { headers: { "content-type": "audio/mpeg" } });
    }
    throw new Error(`Unexpected provider URL ${url}`);
  };
  try {
    const makeFile = () => new File([new Uint8Array([1, 2, 3])], "voice.webm", { type: "audio/webm" });
    nextWriterReply = ({ canonical, bubbles }) => {
      assert.equal(typeof canonical, "string");
      assert(Array.isArray(bubbles));
      return { bubbles };
    };
    const turn1 = sampledTurn(true);
    const first = await handleAudioTurn({ roundId, conversationId: conversation.id, turnId: turn1, audio: makeFile() });
    assert.equal(first.transcript, firstTranscript);
    assert.equal(first.wantsAudio, true, "the sampled recorded turn includes audio");
    assert.doesNotMatch(first.message, /\b\d{2}:\d{2}\b/, "a period preference does not cause the attendant to propose times");
    assert.match(first.message, /hor[aá]rio.*manh[ãa].*\?/i);
    assert(verifyBubbles(first).length >= 2, "the introduction and availability question have separate bubbles");
    assert.equal(first.visit, null);
    assert.equal(replyCalls, 1, "Luna receives the server's preference question for composition");

    nextWriterReply = () => ({ bubbles: ["Sua visita está confirmada para amanhã às 20:00."] });
    const turn2 = sampledTurn(true);
    const second = await handleAudioTurn({ roundId, conversationId: conversation.id, turnId: turn2, audio: makeFile() });
    assert(second.visit, "the supplied time and remembered date book a visit");
    assert.match(second.message, /10:30/);
    assert.doesNotMatch(second.message, /20:00/, "the writer cannot change a confirmed time");
    assert.equal(second.visit.carId, hb20.id);
    assert.equal(second.visit.tradeIn, "Palio");
    assert.equal(second.visit.budgetCents, 8_000_000);
    assert.equal(second.visit.sellerName, "Júlia");
    assert.match(second.message, /com Júlia.*Ficou alguma dúvida\?/);
    const beforeReplayQuota = await pool.query<{ attempts: number }>("select attempts from patio_voz.groq_conversation_usage where conversation_id=$1", [conversation.id]);
    const callsAfterBook = processingCalls;
    const compositionsAfterBook = replyCalls;
    const replay = await handleAudioTurn({ roundId, conversationId: conversation.id, turnId: turn2, audio: makeFile() });
    assert.equal(replay.visit?.id, second.visit.id, "same turn replay recovers persisted visit");
    assert.equal(processingCalls, callsAfterBook, "turn replay does not call providers again");
    assert.equal(replyCalls, compositionsAfterBook, "turn replay does not regenerate the message");
    const afterReplayQuota = await pool.query<{ attempts: number }>("select attempts from patio_voz.groq_conversation_usage where conversation_id=$1", [conversation.id]);
    assert.equal(afterReplayQuota.rows[0]?.attempts, beforeReplayQuota.rows[0]?.attempts, "persisted turn replay does not consume the turn quota");
    await assert.rejects(synthesizeTurnAudio(roundId, conversation.id, turn2), (error: unknown) => error instanceof VoiceError && error.status === 502, "failed TTS is charged but can be retried");
    const [mp3, sameAudio] = await Promise.all([
      synthesizeTurnAudio(roundId, conversation.id, turn2),
      synthesizeTurnAudio(roundId, conversation.id, turn2),
    ]);
    assert.deepEqual([...mp3 ?? []], [73, 68, 51, 1]);
    assert.deepEqual(sameAudio, mp3, "concurrent requests receive the same audio");
    assert.equal(ttsText, second.speechText, "TTS receives the dedicated script saved for the reply");
    assert.notEqual(ttsText, second.message, "TTS does not narrate the confirmation bubble");
    assert.deepEqual(await synthesizeTurnAudio(roundId, conversation.id, turn2), mp3, "another visit to the audio route uses the cache");
    assert.equal(ttsCalls, 2, "only the failed request and successful retry use ElevenLabs");
    failSynthesis = true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(synthesizeTurnAudio(roundId, conversation.id, turn1), (error: unknown) => error instanceof VoiceError && error.status === 502);
    }
    await assert.rejects(synthesizeTurnAudio(roundId, conversation.id, turn1), (error: unknown) => error instanceof VoiceError && error.status === 429 && /3 tentativas/.test(error.message), "fourth TTS attempt gets a clear local 429");
    failSynthesis = false;
    assert.equal(ttsCalls, 5, "no more than three ElevenLabs requests are made for a failing turn");
    assert.equal(await synthesizeTurnAudio(roundId, crypto.randomUUID(), turn2), null, "TTS turn is scoped to conversation");
    const ttsAttempts = await pool.query<{ attempts: number }>("select attempts from patio_voz.elevenlabs_turn_usage where conversation_id=$1 and turn_id=$2", [conversation.id, turn2]);
    assert.equal(ttsAttempts.rows[0]?.attempts, 2, "unauthorized TTS lookup does not increment attempts");

    const turn3 = crypto.randomUUID();
    const photoReply = await handleAudioTurn({ roundId, conversationId: conversation.id, turnId: turn3, audio: makeFile() });
    assert.equal(photoReply.photo?.id, hb20.id, "photo intent resolves to catalog car");
    assert.equal(photoReply.photo?.imageUrl, hb20.imageUrl, "local image remains fallback when storage unset");
    const saved = await getConversationTurn(roundId, conversation.id, turn3);
    assert(saved);

    const turn4 = crypto.randomUUID();
    const combined = await handleAudioTurn({ roundId, conversationId: conversation.id, turnId: turn4, audio: makeFile() });
    assert.equal(combined.photo, null, "a scheduling request does not resend an already shared photo");
    assert.equal(combined.visit, null, "a change to an existing visit does not create another reservation");
    assert.match(combined.message, /Quer falar com Júlia pra ajustar\?/);
    assert.equal(combined.message.match(/\?/g)?.length, 1, "the reply asks one question");

    const turn5 = crypto.randomUUID();
    const budget = await handleAudioTurn({ roundId, conversationId: conversation.id, turnId: turn5, audio: makeFile() });
    assert.match(budget.message, /Kwid|Argo/);
    assert(!budget.message.includes("HB20"), "budget-only change suggests in-budget inventory");
    assert.equal((await getConversation(roundId, conversation.id))?.context.tradeIn, "Palio", "budget update preserves trade-in");

    const missingDateConversation = await createConversation(roundId);
    assert(missingDateConversation);
    const turn6 = crypto.randomUUID();
    const missingDate = await handleAudioTurn({ roundId, conversationId: missingDateConversation.id, turnId: turn6, audio: makeFile() });
    assert.equal(missingDate.visit, null, "a time without a date never books");
    assert.match(missingDate.message, /Qual dia.*10:30/);

    const colorConversation = await createConversation(roundId);
    assert(colorConversation);
    const turn7 = crypto.randomUUID();
    const colorPhoto = await handleAudioTurn({ roundId, conversationId: colorConversation.id, turnId: turn7, audio: makeFile() });
    assert.equal(colorPhoto.photo?.id, snapshot.cars.find((car) => car.color === "Branco")?.id, "color query resolves against catalog color");

    const turn8 = crypto.randomUUID();
    const misunderstood = await handleAudioTurn({ roundId, conversationId: colorConversation.id, turnId: turn8, audio: makeFile() });
    assert.equal(misunderstood.visit, null, "ununderstood selection never reserves a slot");

    const quotaConversation = await createConversation(roundId);
    assert(quotaConversation);
    const quotaReservations = await Promise.all(Array.from({ length: 32 }, () => consumeTurnAttempt(quotaConversation.id)));
    assert.equal(quotaReservations.filter(Boolean).length, 25, "atomic hourly quota admits exactly 25 concurrent turn attempts");
    const callsBeforeQuotaRejection = processingCalls;
    await assert.rejects(handleAudioTurn({ roundId, conversationId: quotaConversation.id, turnId: crypto.randomUUID(), audio: makeFile() }), (error: unknown) => error instanceof VoiceError && error.status === 429 && /25 tentativas/.test(error.message), "exhausted turn quota returns a clear local 429");
    assert.equal(processingCalls, callsBeforeQuotaRejection, "exhausted local quota blocks provider call");

    const conversationUrl = `http://localhost/api/demo/${roundId}/conversations`;
    const begin = () => openConversation(new Request(conversationUrl, { method: "POST" }), { params: Promise.resolve({ roundId }) });
    const typed = await begin();
    assert.equal(typed.status, 201);
    const { conversationId, canListen } = await typed.json();
    assert.equal(canListen, true, "voice-enabled conversation advertises optional playback");
    const turnUrl = `${conversationUrl}/${conversationId}/turns`;
    const params = Promise.resolve({ roundId, conversationId });
    const postText = (text: string, turnId: string = crypto.randomUUID()) => postTurn(new Request(turnUrl, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, turnId }),
    }), { params });
    const textReply = async (text: string, turnId?: string) => {
      const response = await postText(text, turnId);
      assert.equal(response.status, 200);
      return await response.json() as TurnReply;
    };
    assert.equal((await postText("  ")).status, 400);
    assert.equal((await postText("a".repeat(1801))).status, 413);

    const photos = ["frente", "lateral", "interior"].map((view) => `https://catalog.example.test/${view}.webp`);
    const car = await addCatalogCar(roundId, { name: "Sedã azul", model: "Civic Touring", priceCents: 8_349_900, status: "available", imageUrls: photos });
    assert(car);
    const photoIntent = { car_query: "Civic Touring", budget_cents: null, trade_in: null, visit_request: false, period: null, chosen_time: null, ask_photo: true, asks_question: false, understood: true };
    intentResponses.push({ ...photoIntent, trade_in: "Fit", visit_request: true, visit_kind: "schedule", period: "morning" });
    const photoQuestion = `Quero fotos do Civic Touring e visitar dia ${saturday} de manhã. Tenho um Fit na troca.`;
    const callsBeforeText = processingCalls;
    const writesBeforeText = replyCalls;
    const transcriptionsBeforeText = transcriptionCalls;
    const voiceBeforeText = ttsCalls;
    const textTurn = crypto.randomUUID();
    const [textScheduling, duplicateReply] = await Promise.all([textReply(photoQuestion, textTurn), textReply(photoQuestion, textTurn)]);
    assert.deepEqual(duplicateReply, textScheduling, "in-flight retries share the reply");
    assert.equal(processingCalls, callsBeforeText + 1, "typed turn only calls interpreter once");
    assert.equal(replyCalls, writesBeforeText + 1, "typed turn calls Luna once for formulation");
    assert.equal(textScheduling.transcript, photoQuestion);
    assert.deepEqual(textScheduling.photo?.imageUrls, photos, "next turn returns the newly inserted photo URLs in order");
    assert.equal(textScheduling.photo?.id, car.id, "a new car is found by its separate model field");
    assert.match(textScheduling.message, /hor[aá]rio.*manh[ãa]/i);
    assert.doesNotMatch(textScheduling.message, /\b\d{2}:\d{2}\b/);
    assert(lastInterpreterCatalog.some((item) => item.name === car.name && item.model === car.model));

    intentResponses.push({ ...photoIntent, car_query: null, ask_photo: false, visit_request: true, visit_kind: "choose", chosen_time: "09:00" });
    const bookingTurn = crypto.randomUUID();
    const selection = "Pode marcar às 9h.";
    const textBooking = await textReply(selection, bookingTurn);
    assert.equal(textBooking.visit?.carId, car.id, "text booking uses context and persists a visit");
    assert.equal(textBooking.visit?.tradeIn, "Fit");
    assert.match(textBooking.message, /09:00/);
    const typedReplay = await textReply(selection, bookingTurn);
    assert.equal(typedReplay.visit?.id, textBooking.visit?.id, "typed replay returns the same visit");
    const seller = await getRoundSnapshot(roundId);
    assert.equal(seller?.visits.filter((visit) => visit.carId === car.id).length, 1, "typed replay saves one visit");
    assert.equal(ttsCalls, voiceBeforeText, "typed turns do not synthesize responses");
    assert.equal(transcriptionCalls, transcriptionsBeforeText, "typed turns never transcribe");

    const replacementPhoto = "https://catalog.example.test/nova-frente.webp";
    const updatedCar = await changeCatalogCar(roundId, car.id, { priceCents: 8_120_000, replacePhotos: true, imageUrls: [replacementPhoto] });
    assert(updatedCar);
    intentResponses.push(photoIntent);
    const repeatedPhoto = await textReply("Mostre as fotos do Civic Touring");
    assert.equal(repeatedPhoto.photo, null, "updating a photo does not reshare the car within this chat");
    const newPhotoConversation = await createConversation(roundId);
    assert(newPhotoConversation);
    intentResponses.push(photoIntent);
    const updatedPhoto = await handleTurn({
      roundId, conversationId: newPhotoConversation.id, turnId: crypto.randomUUID(), text: "Mostre as fotos do Civic Touring.",
    });
    assert.deepEqual(updatedPhoto.photo?.imageUrls, [replacementPhoto], "a new conversation sees the current photos");
    assert.equal(updatedPhoto.photo?.priceCents, 8_120_000);

    await changeCatalogCar(roundId, car.id, { status: "sold" });
    intentResponses.push({ ...photoIntent, ask_photo: false, visit_request: true, visit_kind: "schedule" });
    const sold = await handleTurn({
      roundId, conversationId: newPhotoConversation.id, turnId: crypto.randomUUID(), text: "Posso visitar o Civic Touring?",
    });
    assert.equal(sold.visit, null);
    assert.match(sold.message, /indisponível/);
    assert(lastInterpreterCatalog.some((item) => item.name === car.name && !item.available));
    await changeCatalogCar(roundId, car.id, { status: "hidden" });
    intentResponses.push(photoIntent);
    const hidden = await textReply("Quero fotos do Civic Touring");
    assert.equal(hidden.photo, null);
    assert(!lastInterpreterCatalog.some((item) => item.name === car.name), "hidden car is absent from the interpreter catalog");

    const multipart = new FormData();
    multipart.append("turnId", crypto.randomUUID());
    multipart.append("audio", makeFile());
    intentResponses.push({ ...photoIntent, car_query: "HB20" });
    const voice = await postTurn(new Request(turnUrl, { method: "POST", body: multipart }), { params });
    assert.equal(voice.status, 200);
    assert.equal((await voice.json() as TurnReply).transcript, "audio de teste");
    assert.equal(transcriptionCalls, transcriptionsBeforeText + 1, "multipart still transcribes through the shared pipeline");
    const priorHistory = await readMessages(new Request(turnUrl.replace(/\/turns$/, "/messages")), { params });
    assert.equal(priorHistory.status, 200);
    const priorMessages = (await priorHistory.json() as ConversationHistory).messages;
    assert(priorMessages.some((message) => message.role === "user" && message.source === "audio" && message.text === "audio de teste"));

    const reopened = await begin();
    assert.equal(reopened.status, 201);
    const reopenedId = (await reopened.json()).conversationId;
    assert.notEqual(reopenedId, conversationId, "explicitly opening a new chat creates a distinct conversation");
    assert.deepEqual((await getConversation(roundId, reopenedId))?.context, {});
    assert.equal(await getConversationTurn(roundId, reopenedId, bookingTurn), null, "the new conversation cannot see past messages");

    intentResponses.push({ ...photoIntent, car_query: null, ask_photo: false, visit_request: true, visit_kind: "schedule" });
    nextWriterReply = ({ modelQuestion, introduction }) => {
      assert(modelQuestion && typeof modelQuestion === "object" && "prefix" in modelQuestion && typeof modelQuestion.prefix === "string");
      assert(Array.isArray(introduction));
      assert.match(modelQuestion.prefix, /Pátio Voz/);
      return { bubbles: [...introduction, "Você já tem um carro em mente?"] };
    };
    const clarification = await handleTurn({
      roundId, conversationId: reopenedId, turnId: crypto.randomUUID(), text: "Quero marcar uma visita.",
    });
    assert.equal(verifyBubbles(clarification).at(-1), "Você já tem um carro em mente?");
    assert.equal(clarification.visit, null);

    const grouped = await createConversation(roundId);
    assert(grouped);
    const chatPath = `${conversationUrl}/${grouped.id}/messages`;
    const chatParams = { params: Promise.resolve({ roundId, conversationId: grouped.id }) };
    const history = () => readMessages(new Request(chatPath), chatParams);
    const enqueue = (text: string, id: string) => enqueueMessage(new Request(chatPath, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, text }),
    }), chatParams);
    const flush = () => replyToMessages(new Request(chatPath + "/reply", { method: "POST" }), chatParams);
    const readHistory = async (response: Response) => {
      assert(response.ok, `history route should succeed (HTTP ${response.status})`);
      return await response.json() as ConversationHistory;
    };
    const idleOut = () => pool.query("update patio_voz.chat_messages set created_at = created_at - interval '9 seconds' where round_id=$1 and conversation_id=$2 and batch_turn_id is null", [roundId, grouped.id]);
    const greeting = "Oi!";
    const askKwid = "Vocês têm Kwid?";
    const firstMessageId = crypto.randomUUID();
    const secondMessageId = crypto.randomUUID();
    const beforeQueue = processingCalls;
    assert.equal((await readHistory(await enqueue(greeting, firstMessageId))).messages.length, 1);
    await idleOut();
    await readHistory(await enqueue(askKwid, secondMessageId));
    await readHistory(await enqueue(askKwid, secondMessageId));
    const pending = await readHistory(await history());
    assert.deepEqual(pending.messages.map((item) => item.role === "user" ? item.text : item.reply.message), [greeting, askKwid]);
    assert(pending.pending && pending.retryAfterMs > 0, "a new message restarts the eight-second delay");
    assert((await readHistory(await flush())).pending, "an early flush returns pending history");
    assert.equal(processingCalls, beforeQueue, "persisting and reading pending messages does not call the model");

    await idleOut();
    const openAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      assert.equal((await flush()).status, 503, "an unavailable provider leaves the batch pending");
      assert.equal((await readHistory(await history())).messages.length, 2);
    } finally {
      process.env.OPENAI_API_KEY = openAIKey;
    }
    const failedBatch = (await pool.query<{ batch_turn_id: string }>(
      "select batch_turn_id from patio_voz.chat_messages where round_id=$1 and conversation_id=$2 and id=$3",
      [roundId, grouped.id, firstMessageId],
    )).rows[0]?.batch_turn_id;
    assert(failedBatch, "the failed attempt retains a stable batch ID for retry");
    const correction = "O Kwid mesmo, por favor.";
    await readHistory(await enqueue(correction, crypto.randomUUID()));
    await idleOut();
    nextWriterReply = ({ bubbles }) => {
      assert(Array.isArray(bubbles) && bubbles.length === 3);
      return { bubbles: [bubbles[0], bubbles.slice(1).join(" ")] };
    };
    intentResponses.push({ ...photoIntent, car_query: "Kwid", ask_photo: false, asks_question: true, car_inquiry: true, social: "greeting" });
    const [sent, parallel] = await Promise.all([flush().then(readHistory), flush().then(readHistory)]);
    const result = [sent, parallel].find((candidate) => !candidate.pending);
    assert(result, "one flush completes the batch");
    assert.equal(processingCalls, beforeQueue + 1, "two concurrent flushes call Luna once for interpretation");
    assert.deepEqual(lastInterpreterInput.message, [greeting, askKwid, correction], "a retry includes the latest incoming correction");
    assert.deepEqual(result.messages.map((item) => item.role), ["user", "user", "user", "assistant"]);
    const automatic = result.messages.at(-1);
    assert(automatic?.role === "assistant");
    assert.equal(automatic.reply.turnId, failedBatch);
    assert.match(automatic.reply.message, /Kwid.*52\.990/);
    const greetingBubbles = verifyBubbles(automatic.reply);
    assert.equal(greetingBubbles.length, 3, "Luna cannot merge the first-contact fact and question into one bubble");
    assert.match(greetingBubbles[0], /Sou a Júlia, consultora aqui do Pátio Voz/);
    assert.equal(Boolean(automatic.reply.wantsAudio), selectsAutomaticAudio(automatic.reply.turnId), "the gallery follows the same voice sample as other turns");
    assert.match(automatic.reply.speechText ?? "", /olhada.*loja/);
    assert.notEqual(automatic.reply.speechText, automatic.reply.message);
    const galleryAudio = await synthesizeTurnAudio(roundId, grouped.id, automatic.reply.turnId);
    assert.equal(Boolean(galleryAudio), Boolean(automatic.reply.wantsAudio));
    if (galleryAudio) assert.equal(ttsText, automatic.reply.speechText);
    assert(greetingBubbles.some((bubble) => /Zen 1\.0.*52\.990/.test(bubble)), "vehicle name and price fit in one bubble");
    assert.match(automatic.reply.photo?.name ?? "", /Kwid/, "an inventory inquiry shows the photo without an explicit request");
    assert.deepEqual((await readHistory(await history())).messages, result.messages, "a fresh history request restores the full conversation");
    assert.equal((await readMessages(new Request(chatPath), { params: Promise.resolve({ roundId: crypto.randomUUID(), conversationId: grouped.id }) })).status, 404, "history is scoped to the round");

    const adQuestion = "Eu vi um na publicidade de vocês. Tem foto?";
    await readHistory(await enqueue(adQuestion, crypto.randomUUID()));
    await idleOut();
    intentResponses.push({ ...photoIntent, car_query: "um carro da publicidade de vocês" });
    const followUp = (await readHistory(await flush())).messages.at(-1);
    assert(followUp?.role === "assistant");
    assert.equal(followUp.reply.photo, null, "a new request for the same car's photo does not resend it");
    assert.equal(Boolean(followUp.reply.wantsAudio), selectsAutomaticAudio(followUp.reply.turnId));
    assert.match(followUp.reply.message, /acima/);
    assert.doesNotMatch(followUp.reply.message, /Pátio Voz/, "the attendant only introduces itself at the start");
    verifyBubbles(followUp.reply);
    assert.match(JSON.stringify(lastInterpreterInput.context?.focusedCar), /Kwid/);
    assert.match(JSON.stringify(lastInterpreterInput.context?.recentTurns), /Vocês têm Kwid/);
    await readHistory(await enqueue("Me fala um pouco mais sobre ele em áudio.", crypto.randomUUID()));
    await idleOut();
    const details = { ...photoIntent, car_query: null, ask_photo: false, car_inquiry: true, asks_question: true };
    intentResponses.push({ ...details, car_details: ["year"], wants_audio: true });
    const more = (await readHistory(await flush())).messages.at(-1);
    assert(more?.role === "assistant");
    assert.equal(more.reply.wantsAudio, true, "asking for audio in text adds the preference to the saved response");
    assert.equal(more.reply.photo, null, "asking for details keeps the existing gallery in place");
    assert.match(more.reply.message, /2023/);
    assert.doesNotMatch(more.reply.message, /52\.990/, "a request for a new detail does not repeat the price");

    await readHistory(await enqueue("Pode mandar essa resposta em áudio?", crypto.randomUUID()));
    await idleOut();
    intentResponses.push({ ...details, car_inquiry: false, asks_question: false, wants_audio: true });
    const repeatInAudio = (await readHistory(await flush())).messages.at(-1);
    assert(repeatInAudio?.role === "assistant");
    assert.equal(repeatInAudio.reply.wantsAudio, true);
    assert.equal(repeatInAudio.reply.speechText, more.reply.speechText, "an audio request uses the prior spoken script");
    assert.notEqual(repeatInAudio.reply.message, more.reply.message, "the chat does not repeat the previous bubble alongside the audio");
    assert.equal(repeatInAudio.reply.visit, null, "repeating text in audio does not repeat a visit");

    await readHistory(await enqueue("Vocês têm HB20?", crypto.randomUUID()));
    await idleOut();
    intentResponses.push({ ...details, car_query: "HB20" });
    const secondCar = (await readHistory(await flush())).messages.at(-1);
    assert(secondCar?.role === "assistant");
    assert.equal(secondCar.reply.photo?.id, hb20.id, "a different car can have its own gallery in the same chat");

    const simultaneous = await createConversation(roundId);
    assert(simultaneous);
    const photoRequest = { ...photoIntent, car_query: "Kwid" };
    intentResponses.push(photoRequest, photoRequest);
    const sentTogether = await Promise.all([0, 1].map(() => handleTurn({
      roundId, conversationId: simultaneous.id, turnId: crypto.randomUUID(), text: "Tem fotos do Kwid?",
    })));
    assert.equal(sentTogether.filter((reply) => reply.photo).length, 1, "concurrent replies persist one gallery for the same car");
    assert.equal(sentTogether.filter((reply) => verifyBubbles(reply)[0].includes("consultora aqui do Pátio Voz")).length, 1,
      "concurrent first replies introduce the attendant once");
    const repeated = sentTogether.find((reply) => !reply.photo);
    assert.match(repeated?.message ?? "", /acima/, "the concurrent reply points to the first gallery");

    const busyChat = await createConversation(roundId);
    assert(busyChat);
    await pool.query(`insert into patio_voz.chat_messages (round_id, conversation_id, id, text, created_at)
      select $1, $2, gen_random_uuid(), 'Mensagem ' || value, clock_timestamp() - interval '9 seconds'
      from generate_series(1, $3::integer) as sent(value)`, [roundId, busyChat.id, MAX_CHAT_BATCH_MESSAGES + 1]);
    const callsBeforeOverflow = processingCalls;
    const overflow = await readHistory(await replyToMessages(new Request(chatPath + "/reply", { method: "POST" }),
      { params: Promise.resolve({ roundId, conversationId: busyChat.id }) }));
    assert.equal(processingCalls, callsBeforeOverflow, "oversized bursts clarify the next action without acting on partial context");
    assert(!overflow.pending);
    assert.equal(overflow.messages.length, MAX_CHAT_BATCH_MESSAGES + 2, "oversized bursts retain all messages plus one clarification");
    const textOnly = overflow.messages.at(-1);
    assert(textOnly?.role === "assistant");
    assert.equal(await synthesizeTurnAudio(roundId, busyChat.id, textOnly.reply.turnId), null, "text-only responses never use the chat bubble as a TTS fallback");

    const sample = Array.from({ length: 500 }, (_, i) => selectsAutomaticAudio(`00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`));
    assert(sample.filter(Boolean).length >= 75 && sample.filter(Boolean).length <= 125, "automatic audio is sampled at about twenty percent");

    const stockChat = await createConversation(roundId);
    assert(stockChat);
    await addCatalogCar(roundId, { name: "Kia Sportage", model: "EX", priceCents: 11_490_000, status: "available", imageUrls: [] });
    await addCatalogCar(roundId, { name: "Chevrolet Tracker", model: "LTZ", priceCents: 12_490_000, status: "available", imageUrls: [] });
    await addCatalogCar(roundId, { name: "Tucson vendida", model: "GLS", priceCents: 8_490_000, status: "sold", imageUrls: [] });
    const stockIntent = { ...photoIntent, car_query: null, ask_photo: false, asks_question: true };
    const stockTurn = (text: string, intent: StubIntent = stockIntent) => {
      intentResponses.push(intent);
      return handleTurn({ roundId, conversationId: stockChat.id, turnId: sampledTurn(false), text });
    };
    const inventory = await stockTurn("queria saber quais carros vcs tem em estoque");
    assert.match(inventory.message, /HB20/);
    assert.match(inventory.message, /Sportage/);
    assert.doesNotMatch(inventory.message, /Polo|Tucson/);
    assert.equal(inventory.wantsAudio, undefined);
    assert.equal(await synthesizeTurnAudio(roundId, stockChat.id, inventory.turnId), null, "unsampled replies have no audio to generate");
    const suv = await stockTurn("queria um suv", { ...stockIntent, car_query: "suv", car_inquiry: true });
    assert.match(suv.message, /Sportage[\s\S]*Tracker/);
    assert.doesNotMatch(suv.message, /Kwid|Tucson|HB20/);
    const requestedAudio = await stockTurn("Quais opções vcs têm? Me fala em áudio", { ...stockIntent, wants_audio: true });
    assert.equal(requestedAudio.wantsAudio, true, "a direct request overrides the automatic audio sample");

    const schedule = await stockTurn("quais horarios meu irmao");
    assert.match(schedule.message, /8h às 18h.*qual dia/i);
    const dayOptions = await stockTurn(`Dia ${laterSaturday}.`, { ...stockIntent, asks_question: false });
    assert.match(dayOptions.message, /08:00.*18:00/);
    assert.equal(dayOptions.visit, null, "listing free times does not reserve one");
    const exactOption = await stockTurn("Quais vcs tem?");
    assert.match(exactOption.message, /08:00.*18:00/);
    assert.doesNotMatch(exactOption.message, /Sportage/, "the short question follows the visit context");

    const visitConversation = await createConversation(roundId);
    const urgentConversation = await createConversation(roundId);
    const kwid = snapshot.cars.find((item) => /Kwid/.test(item.name));
    assert(visitConversation && urgentConversation && kwid);
    const visitScope = { roundId, conversationId: visitConversation.id };
    const visitIntent = { ...photoIntent, car_query: null, ask_photo: false, visit_request: true };
    const visitTurn = (text: string, intent: StubIntent, turnId: string = crypto.randomUUID()) => {
      intentResponses.push(intent);
      return handleTurn({ ...visitScope, turnId, text });
    };
    const browse = await visitTurn("Como faço pra dar uma olhada no Kwid?", { ...visitIntent, car_query: "Kwid", visit_kind: "browse" });
    assert.match(browse.message, /Quer combinar uma visita\?/);
    assert.equal(browse.visit, null);
    const permission = await visitTurn("Manda aí. Tenho um Palio na troca, meu teto é 80 mil.", {
      ...visitIntent, visit_request: false, answer: "yes", trade_in: "Palio", budget_cents: 8_000_000,
    });
    assert.match(permission.message, /Qual dia e horário.*\?/);
    assert.doesNotMatch(permission.message, /\b\d{2}:\d{2}\b/);
    const unsure = await visitTurn(`Talvez dia ${saturday} às 10h30. Depende do trampo.`, {
      ...visitIntent, visit_kind: "choose", chosen_time: "10:30", answer: "uncertain",
    });
    assert.equal(unsure.visit, null, "a conditional preference never books");
    const unavailable = await visitTurn(`Pode marcar dia ${saturday} às 11h15.`, { ...visitIntent, visit_kind: "choose", chosen_time: "11:15" });
    assert.equal(unavailable.visit, null);
    assert.match(unavailable.message, /Qual outro horário/);
    assert.doesNotMatch(unavailable.message, /\b\d{2}:\d{2}\b/, "unavailable time does not produce a list of alternatives");
    const availability = await visitTurn(`Dia ${saturday} às 10h30 tá livre?`, { ...visitIntent, visit_kind: "availability", chosen_time: "10:30" });
    assert.equal(availability.visit, null, "checking availability waits for the customer's choice");
    assert.match(availability.message, /confirmar.*10:30/);
    const confirmed = await visitTurn("Pode marcar.", { ...visitIntent, visit_kind: "choose", answer: "yes" });
    assert(confirmed.visit, "confirmation books the previously supplied preference");
    assert.equal(confirmed.visit.sellerName, "Rafa", "the other seller still has room at the same time");
    assert.equal(confirmed.visit.carId, kwid.id);
    assert.equal(confirmed.visit.tradeIn, "Palio");
    assert.equal(confirmed.visit.budgetCents, 8_000_000);
    assert.match(confirmed.message, /10:30.*Rafa.*Ficou alguma dúvida\?/);
    const closed = await visitTurn("Tranquilo, só isso msm.", { ...visitIntent, visit_request: false, answer: "no" }, sampledTurn(true));
    assert.equal(closed.humanHandoff, true);
    assert.match(closed.message, /Rafa/);
    assert.equal(closed.wantsAudio, true, "a sampled handoff includes a voice note");
    assert.match(closed.speechText ?? "", /Rafa.*pelo chat/);
    assert.notEqual(closed.speechText, closed.message);
    assert(await synthesizeTurnAudio(roundId, visitConversation.id, closed.turnId));
    assert.equal(ttsText, closed.speechText);

    intentResponses.push({ ...visitIntent, car_query: "Kwid", visit_request: false, human_request: true, trade_in: "Palio", budget_cents: 8_000_000 });
    const urgent = await handleTurn({
      roundId, conversationId: urgentConversation.id, turnId: crypto.randomUUID(),
      text: "Quero falar com um vendedor agora sobre o Kwid. Tenho um Palio na troca, meu teto é 80 mil.",
    });
    assert.equal(urgent.visit, null);
    assert.equal(urgent.humanHandoff, true);
    const contact = (await getSellerRoundSnapshot(roundId))?.handoffs;
    assert.deepEqual(contact?.map(({ conversationId, priority }) => [conversationId, priority]), [
      [urgentConversation.id, "now"], [visitConversation.id, "follow_up"],
    ]);
    const [immediate, routine] = contact ?? [];
    assert(immediate && routine);
    assert.match(urgent.message, new RegExp(immediate.sellerName));
    assert.equal(routine.sellerName, "Rafa");
    assert.equal(routine.carName, kwid.name);
    assert.equal(routine.tradeIn, "Palio");
    assert.equal(routine.budgetCents, 8_000_000);
    assert.equal(routine.visitId, confirmed.visit.id);
    assert.equal(routine.preference?.date, localDate);
    assert.equal(routine.preference?.time, "10:30");
    assert.equal(routine.preference?.exact, true);

    const handedOffPath = `${conversationUrl}/${visitConversation.id}/messages`;
    const handedOffParams = { params: Promise.resolve(visitScope) };
    const callsBeforeHandoffMessage = processingCalls;
    const postHandoffMessage = await enqueueMessage(new Request(handedOffPath, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), text: "Obrigado, Rafa!" }),
    }), handedOffParams);
    const handedOff = await readHistory(postHandoffMessage);
    assert(handedOff.humanHandoff && !handedOff.pending);
    assert.equal(handedOff.messages.at(-1)?.role, "user");
    assert(!(await readHistory(await replyToMessages(new Request(handedOffPath + "/reply", { method: "POST" }), handedOffParams))).pending);
    assert.equal(processingCalls, callsBeforeHandoffMessage, "new text after transfer is available to the seller without calling the assistant");
    const manualReply = "Oi! Pode trazer o Palio para avaliação no dia da visita.";
    await sendSellerHandoffMessage(visitScope, crypto.randomUUID(), manualReply);
    const updatedHistory = await readHistory(await readMessages(new Request(handedOffPath), handedOffParams));
    const lastMessage = updatedHistory.messages.at(-1);
    assert(lastMessage?.role === "assistant");
    assert.equal(lastMessage.reply.message, manualReply);
    assert.equal(lastMessage.reply.sellerName, routine.sellerName, "the customer sees the seller's reply under the assigned name");
    assert.equal(await synthesizeTurnAudio(roundId, visitConversation.id, lastMessage.reply.turnId), null, "the seller's text does not play in the virtual consultant's voice");

    const pricedConversation = await createConversation(roundId);
    assert(pricedConversation);
    const requestPrice = (text: string) => handleTurn({ roundId, conversationId: pricedConversation.id, turnId: crypto.randomUUID(), text });
    intentResponses.push({ ...photoIntent, car_query: "HB20", budget_cents: 8_000_000, ask_photo: false, visit_request: true, visit_kind: "schedule", period: "afternoon" });
    const afternoon = await requestPrice("Quero visitar o HB20 à tarde. Meu teto é 80 mil.");
    assert.match(afternoon.message, /Qual dia.*tarde/);
    assert.doesNotMatch(afternoon.message, /14:00/);
    intentResponses.push({ ...photoIntent, car_query: null, ask_photo: false, chosen_time: "14:00", visit_request: true, visit_kind: "choose", period: "afternoon" });
    const timeInquiry = await requestPrice(`Vocês ainda têm dia ${saturday} às 14h livre?`);
    assert.equal(timeInquiry.visit, null, "a time inquiry keeps the slot free even when the model classifies it as a selection");
    assert.match(timeInquiry.message, /14:00/);
    assert.equal((await listPreferredSlots(roundId, localDate, "14:00")).length, 2);
    intentResponses.push({ ...photoIntent, car_query: null, ask_photo: false, chosen_time: "14:00", visit_request: true, visit_kind: "choose" });
    beforeInterpretAnswer = () => changeCatalogCar(roundId, hb20.id, { priceCents: 8_150_000 });
    const priceRejected = await requestPrice("Pode marcar às 14h");
    assert.equal(priceRejected.visit, null, "the server rechecks price changes made after the interpreter reads the catalog");
    assert.match(priceRejected.message, /81\.500.*teto.*80\.000.*Kwid/);
    assert.equal((await listPreferredSlots(roundId, localDate, "14:00")).length, 2, "the price check leaves the requested time available");

    const recoverySession = await createConversation(roundId);
    assert(recoverySession);
    const recoveryTurn = { roundId, conversationId: recoverySession.id, turnId: crypto.randomUUID() };
    const originalTranscript = `Pode marcar dia ${saturday} às 14h. Tenho um Fit para a troca.`;
    const orphanedBooking = await reservePreferredVisit({ ...recoveryTurn, carId: hb20.id, localDate, localTime: "14:00",
      budgetCents: 8_500_000, tradeIn: "Fit", summary: "Quer visitar o HB20 e avaliar o Fit.", transcript: originalTranscript });
    assert(orphanedBooking.ok);
    assert.equal(await getConversationTurn(roundId, recoverySession.id, recoveryTurn.turnId), null, "booking committed before a reply exists");
    assert.equal(await getVisitForTurn(crypto.randomUUID(), recoverySession.id, recoveryTurn.turnId), null, "recovery lookup is scoped to round");
    assert.equal(await getVisitForTurn(roundId, reopenedId, recoveryTurn.turnId), null, "recovery lookup is scoped to conversation");
    await changeCatalogCar(roundId, hb20.id, { status: "hidden", priceCents: 9_100_000 });
    const callsBeforeRecovery = processingCalls;
    const configuredOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const recovered = await handleAudioTurn({ ...recoveryTurn, audio: makeFile() });
      assert.equal(recovered.transcript, originalTranscript);
      assert.equal(recovered.visit?.id, orphanedBooking.visit.id);
      assert.match(recovered.message, new RegExp(`14:00.*${orphanedBooking.visit.sellerName}.*Fit.*Ficou alguma dúvida`));
      verifyBubbles(recovered);
      assert.deepEqual(await getConversationTurn(roundId, recoverySession.id, recoveryTurn.turnId), recovered);
      assert.deepEqual((await getConversation(roundId, recoverySession.id))?.context, {
        carId: hb20.id, tradeIn: "Fit", budgetCents: 8_500_000, patioVozIntroduced: true, confirmedVisitTurnId: recoveryTurn.turnId,
        preferredLocalDate: localDate, preferredLocalTime: "14:00", preferredVisitExact: true,
        preferredVisitText: originalTranscript, visitStage: "visit_question",
      });
    } finally {
      if (configuredOpenAIKey) process.env.OPENAI_API_KEY = configuredOpenAIKey;
    }
    assert.equal(processingCalls, callsBeforeRecovery, "recovering a committed visit does not call providers");
    assert.equal(intentResponses.length, 0, "all scripted user turns reached the intended interpreter");
    console.log("Voice and text verification passed: persistent history, batching, automatic photos, quotas, live catalog, exact scheduling, handoffs and committed visit recovery.");
  } finally {
    globalThis.fetch = originalFetch;
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Voice verification failed");
  process.exitCode = 1;
});
