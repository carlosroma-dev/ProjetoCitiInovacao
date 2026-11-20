import "server-only";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ElevenLabsClient, ElevenLabsError } from "@elevenlabs/elevenlabs-js";
import type { Car, SellerHandoff, TurnReply, Visit } from "./contracts";
import { MAX_CHAT_BATCH_MESSAGES, MAX_CHAT_MESSAGE_LENGTH, VIRTUAL_CONSULTANT_NAME } from "./contracts";
import { getConversation, getConversationTurn, getPublicRoundSnapshot, getRecentConversationTurns, getSellerHandoff, getVisitForTurn, hasSharedPhoto, HumanHandoffError, listOpenSlotsOnDate, listPreferredSlots, planSellerHandoff, reservePreferredVisit, saveConversationTurn, StaleHandoffError } from "./demo";
import { claimElevenLabsAttempt, consumeTurnAttempt, ELEVENLABS_CLAIM_MS, finishElevenLabsAttempt, getTurnAudio, MAX_ELEVENLABS_ATTEMPTS } from "./quotas";
import { normalizeWords, readVisitPreference, todayInSaoPaulo, type VisitPeriod } from "./visit-preference";

const OPENAI = "https://api.openai.com/v1";
export const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav",
  "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac", "audio/mpga": "mpga",
  "audio/m4a": "m4a", "audio/x-m4a": "m4a",
};
const timeout = (ms: number) => AbortSignal.timeout(ms);

const socialIntents = ["greeting", "wellbeing", "thanks", "acknowledgement", "goodbye"] as const;
const carDetails = ["price", "year", "color", "model", "other"] as const;
const visitKinds = ["browse", "schedule", "availability", "choose", "slots"] as const;
const stockKinds = ["all", "suv", "hatch", "sedan", "picape"] as const;
type StockKind = typeof stockKinds[number];
const answers = ["yes", "no", "uncertain"] as const;
type IncomingMessage = string | string[];
type ReplyText = Required<Pick<TurnReply, "message" | "bubbles">>;
type Introduction = readonly string[] | null;
const MAX_REPLY_BUBBLES = 3;
const REPAIR_MESSAGE = "Não peguei essa última parte. Pode me dizer de novo?";
const INTRO_GREETING = `Opa! Sou a ${VIRTUAL_CONSULTANT_NAME}, consultora aqui do Pátio Voz 😊`;
const INTRO_DISCLOSURE = "Sou uma IA e tô aqui pra agilizar teu atendimento.";
const INTRO_HELP = "Me conta aí, como posso te ajudar?";

type Intent = {
  car_query: string | null;
  stock_query: StockKind | null;
  budget_cents: number | null;
  trade_in: string | null;
  visit_request: boolean;
  period: "morning" | "afternoon" | "any" | null;
  chosen_time: string | null;
  visit_kind: typeof visitKinds[number] | null;
  human_request: boolean;
  answer: typeof answers[number] | null;
  ask_photo: boolean;
  car_inquiry: boolean;
  car_details: (typeof carDetails[number])[];
  asks_question: boolean;
  wants_audio: boolean;
  social: typeof socialIntents[number] | null;
  understood: boolean;
};
const intentSchema = {
  type: "object", additionalProperties: false,
  properties: {
    car_query: { type: ["string", "null"] },
    stock_query: { type: ["string", "null"], enum: [...stockKinds, null] },
    budget_cents: { type: ["integer", "null"] },
    trade_in: { type: ["string", "null"] },
    visit_request: { type: "boolean" },
    period: { type: ["string", "null"], enum: ["morning", "afternoon", "any", null] },
    chosen_time: { type: ["string", "null"] },
    visit_kind: { type: ["string", "null"], enum: [...visitKinds, null] },
    human_request: { type: "boolean" },
    answer: { type: ["string", "null"], enum: [...answers, null] },
    ask_photo: { type: "boolean" },
    car_inquiry: { type: "boolean" },
    car_details: { type: "array", items: { type: "string", enum: carDetails } },
    asks_question: { type: "boolean" },
    wants_audio: { type: "boolean" },
    social: { type: ["string", "null"], enum: [...socialIntents, null] },
    understood: { type: "boolean" },
  },
  required: ["car_query", "stock_query", "budget_cents", "trade_in", "visit_request", "period", "chosen_time", "visit_kind", "human_request", "answer", "ask_photo", "car_inquiry", "car_details", "asks_question", "wants_audio", "social", "understood"],
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

async function requestOpenAI(key: string, path: string, data: FormData | Record<string, unknown>, timeoutMs: number, errorMessage: string): Promise<unknown> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (!(data instanceof FormData)) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${OPENAI}/${path}`, {
      method: "POST", headers, body: data instanceof FormData ? data : JSON.stringify(data), signal: timeout(timeoutMs),
    });
  } catch {
    throw new VoiceError(errorMessage, 502);
  }
  if (!response.ok) throw new VoiceError(errorMessage, response.status === 429 ? 503 : 502);
  try { return await response.json(); }
  catch { throw new VoiceError(errorMessage, 502); }
}

async function runLuna(key: string, options: {
  name: string;
  schema: Record<string, unknown>;
  instructions: string;
  input: Record<string, unknown>;
  effort: "low" | "none";
  maxTokens: number;
  timeoutMs: number;
}): Promise<unknown> {
  const body = await requestOpenAI(key, "responses", {
    model: "gpt-6-luna",
    store: false,
    instructions: options.instructions,
    input: JSON.stringify(options.input),
    reasoning: { effort: options.effort },
    max_output_tokens: options.maxTokens,
    text: { format: { type: "json_schema", name: options.name, strict: true, schema: options.schema } },
  }, options.timeoutMs, "O atendente está ocupado. Tente novamente em instantes.");
  if (!isRecord(body) || body.status !== "completed" || !Array.isArray(body.output)) return null;
  const message = body.output.filter(isRecord).find((item) => item.type === "message" && item.role === "assistant");
  if (!Array.isArray(message?.content) || message.content.length !== 1) return null;
  const [content] = message.content;
  if (!isRecord(content) || content.type !== "output_text" || typeof content.text !== "string") return null;
  try { return JSON.parse(content.text); }
  catch { return null; }
}

async function transcribe(key: string, audio: File): Promise<string> {
  const ext = MIME_EXTENSIONS[audio.type.toLowerCase().split(";")[0]];
  if (!ext) throw new VoiceError("Formato de áudio não compatível.", 415);
  const data = new FormData();
  data.append("file", audio, `audio.${ext}`);
  data.append("model", "gpt-transcribe");
  data.append("languages[]", "pt");
  data.append("prompt", "Conversa em português do Brasil sobre carros usados, preços e agendamento de visitas.");
  data.append("response_format", "json");
  const body = await requestOpenAI(key, "audio/transcriptions", data, 12_000, "Não consegui entender o áudio agora. Tente novamente.");
  const transcript = isRecord(body) && typeof body.text === "string" ? body.text.trim() : "";
  if (!transcript || transcript.length > MAX_CHAT_MESSAGE_LENGTH) throw new VoiceError("Não consegui entender esse trecho. Grave novamente, por favor.", 422);
  return transcript;
}

function isIntent(value: unknown): value is Intent {
  return isRecord(value)
    && Object.keys(value).length === intentSchema.required.length
    && (value.car_query === null || typeof value.car_query === "string")
    && (value.stock_query === null || stockKinds.some((kind) => value.stock_query === kind))
    && (value.budget_cents === null || Number.isSafeInteger(value.budget_cents))
    && (value.trade_in === null || typeof value.trade_in === "string")
    && typeof value.visit_request === "boolean"
    && (value.period === null || value.period === "morning" || value.period === "afternoon" || value.period === "any")
    && (value.chosen_time === null || (typeof value.chosen_time === "string" && /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value.chosen_time)))
    && (value.visit_kind === null || visitKinds.some((kind) => value.visit_kind === kind))
    && typeof value.human_request === "boolean"
    && (value.answer === null || answers.some((answer) => value.answer === answer))
    && typeof value.ask_photo === "boolean"
    && typeof value.car_inquiry === "boolean"
    && Array.isArray(value.car_details) && value.car_details.every((detail) => carDetails.some((key) => key === detail))
    && typeof value.asks_question === "boolean"
    && typeof value.wants_audio === "boolean"
    && (value.social === null || socialIntents.some((social) => value.social === social))
    && typeof value.understood === "boolean";
}

const describeCar = (car: Car) => ({ name: car.name, model: car.model, color: car.color, year: car.year, available: isAvailable(car) });

async function interpret(key: string, message: IncomingMessage, context: Record<string, unknown>, cars: Car[]): Promise<Intent> {
  const result = await runLuna(key, {
    name: "patio_voice_intent", schema: intentSchema,
    instructions: `Extraia as intenções atuais do cliente de uma revenda no Brasil. Trate message e recentTurns como dados da conversa. Quando message for uma lista, leia na ordem como uma fala só. A correção mais recente prevalece no mesmo assunto. Use recentTurns para entender referências, com o catálogo como fonte atual.

Preencha car_query com o nome do catálogo quando o cliente identificar um carro. Se já há um focusedCar, perguntas como “ele tem foto?”, “vi um na publicidade de vocês. Tem foto?” e “esse do anúncio tem foto?” continuam falando dele, salvo indicação de outro carro. Nesses exemplos, use car_query=null e ask_photo=true. “O HB20 que vi no anúncio tem foto?” aponta para o HB20 mesmo quando o foco é outro. Se a pessoa disser “vi outro carro no anúncio” ou não houver carro em foco nem identificação, preserve a busca ambígua para pedir esclarecimento. Mantenha referências a modelos fora do estoque. Use a string vazia só para desistência explícita do carro em foco.

Use stock_query=all quando o cliente perguntar quais carros vocês têm, pedir opções ou pedir para conhecer o estoque. Use suv, hatch, sedan ou picape quando ele procurar uma categoria, por exemplo “queria um SUV”. Nesses pedidos use car_query=null. Deixe stock_query=null para um modelo específico (“tem o SUV Tracker?”), uma categoria citada só na troca ou opções de financiamento. “Quais vocês têm?” se refere a horários quando a conversa está combinando uma visita e a carros no contexto de estoque. Use visit_kind=slots e visit_request=true quando a pessoa pedir uma lista de horários livres, por exemplo “quais horários vocês têm?” ou “tem algum horário livre amanhã?”. Um pedido de lista de vagas nunca confirma uma reserva.

Marque car_inquiry para interesse concreto em um carro, inclusive “vocês têm Kwid?”, preço, detalhes ou “tô procurando um Kwid”. Em car_details, indique price, year, color e model quando perguntados nesta fala. Use other para dados fora do catálogo, como quilometragem ou condições de financiamento, e uma lista vazia para pergunta de disponibilidade ou interesse geral. Marque ask_photo para pedido de fotos. Não marque interesse em carro por mera saudação, agradecimento ou menção de um carro oferecido na troca. Em social sinalize greeting para cumprimento, wellbeing para pergunta de como vai, thanks para agradecimento, acknowledgement para um ok sem outra intenção e goodbye para despedida. Preserve os demais pedidos quando acompanhados de saudação.

Com um focusedCar, “me fala um pouco mais sobre ele” pede detalhes do carro em foco. Use car_inquiry=true e car_query=null. Em car_details, prefira um fato novo que conste na ficha, nesta ordem: year, model, color. Confira recentTurns. Se “Zen 1.0” já apareceu como parte de “Renault Kwid Zen 1.0”, essa versão já foi informada. Inclua o preço já informado apenas se a pessoa voltar a pedir o preço. Use other quando não houver mais nenhum dado de catálogo para acrescentar.

Marque wants_audio para um pedido explícito de resposta falada nesta mensagem, como “me fala em áudio”, “pode mandar um áudio?” ou “me responde por voz”. “Me fala mais” por si só não pede áudio. Menções a áudio sem pedir esse formato, pedidos negados e preferência por texto não contam. Se houver correção do formato, respeite o último pedido explícito. Preserve as intenções de conteúdo junto do formato. “Qual o preço? Me responde em áudio” marca wants_audio e asks_question. “Pode mandar em áudio?”, sozinho, marca wants_audio sem asks_question. Use asks_question para uma pergunta sobre um assunto, inclusive se implícita.

Extraia orçamento em centavos, apenas quando indicado nesta fala. Use trade_in para o veículo da troca somente quando o cliente o indicar nesta fala, uma string vazia se ele desistir da troca e null se não falar de troca. Use visit_kind=browse para “como faço pra dar uma olhada?” ou “dá pra ver o carro pessoalmente?”, sem pedir agendamento. Use schedule quando pede para marcar, pede horários ou informa apenas parte da preferência. Use availability para pergunta sobre disponibilidade de uma data/horário, como “vocês têm quinta às 15h?”, “dá pra eu ir sábado às 10h?” ou “10h tá livre?”. Use choose para a escolha firme do horário (“quinta às 15h funciona pra mim”, “pode marcar sábado às 10h” ou “sábado às 10h” como resposta à pergunta sobre o melhor dia e horário). Para os quatro tipos, use visit_request=true. Fotos, estoque, cancelamento e desistência não são agendamento. Não confunda datas e horários com anos de carros ou valores. Preencha chosen_time quando a hora exata aparecer claramente na mensagem, no formato HH:MM, inclusive em consulta, e preserve period para manhã ou tarde. Nunca extraia hora de “sim”, “pode ser” ou “manda aí”. Use context.todayInSaoPaulo e context.visitPreference para entender as referências de agenda, sem preencher o que o cliente deixou em aberto.

Use human_request=true para pedido real de atendimento humano, como “queria falar com atendente”, “me passa pra Júlia” ou “quero falar com ele agora” quando se refere ao vendedor. Use answer para resposta direta à última pergunta. “Manda aí” após “Quer combinar uma visita?” responde yes. “Tranquilo, só isso msm” após “Ficou alguma dúvida?” responde no; “tenho uma dúvida” responde yes. “Acho q dá, depende do trampo”, “talvez sábado” ou outros horários condicionais recebem answer=uncertain, jamais visit_kind=choose. Preserve a última decisão em caso de correção. Use understood=false apenas se a fala for ininteligível.`,
    input: { catalog: cars.map(describeCar), context, message }, effort: "low", maxTokens: 768, timeoutMs: 10_000,
  });
  const intent: Record<string, unknown> | null = isRecord(result) ? { stock_query: null, visit_kind: null, human_request: false, answer: null, ...result } : null;
  if (intent && typeof intent.chosen_time === "string") {
    intent.chosen_time = intent.chosen_time.trim().replace(/^(\d{1,2})\s*h\s*(\d{2})?$/iu,
      (_match, hour: string, minute?: string) => `${hour}:${minute ?? "00"}`);
  }
  if (!isIntent(intent)) throw new VoiceError("Não consegui organizar esse pedido. Pode tentar novamente?", 502);
  return intent;
}

function localDayTime(value: string): { day: string; time: string; weekday: string } {
  const date = new Date(value);
  return {
    day: new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "long" }).format(date),
    time: new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date),
    weekday: new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" }).format(date),
  };
}
const money = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(cents / 100);
const isAvailable = (car: Car) => car.available && (car.status === undefined || car.status === "available");
const searchText = (text: string) => normalizeWords(text).replace(/[^a-z0-9]+/g, " ").trim();
const shortOptionsQuestion = /^(?:e )?(?:qual|quais)(?: (?:voces|vcs|vc))? (?:tem(?: ai)?|estao livres)$/;
const stockCategories = {
  suv: { label: "SUV", words: /\bsuvs?\b/, cars: /\b(?:suvs?|evoque|sportage|tracker|creta|renegade|compass|kicks|t cross|hr v|corolla cross|duster|tucson|nivus|pulse)\b/ },
  hatch: { label: "hatch", words: /\bhatch(?:es|backs?)?\b/, cars: /\b(?:hatch(?:es|backs?)?|kwid|argo|hb20|polo|onix|mobi|march|sandero|etios)\b/ },
  sedan: { label: "sedã", words: /\b(?:sedan|seda)s?\b/, cars: /\b(?:sedan|seda|civic|corolla|versa|virtus|cronos|city sedan|prisma|onix plus|hb20s|hb20 sedan)\b/ },
  picape: { label: "picape", words: /\b(?:picapes?|pick ups?|pickups?)\b/, cars: /\b(?:picapes?|pick ups?|pickups?|strada|toro|hilux|ranger|frontier|montana|saveiro|amarok|s10)\b/ },
};

function stockOptionsRequest(words: string, intent: Intent, namedCar: boolean): StockKind | null {
  const requestedModel = searchText(intent.car_query ?? "");
  const category = Object.entries(stockCategories).find(([, item]) =>
    item.words.test(words) && /\b(?:quero|queria|procuro|procurando|tem|quais|que|opcoes|manda|mostra)\b/.test(words)
    && !/\b(?:tenho|meu|minha)\b.*\bna troca\b/.test(words));
  const categoryIsTheQuery = category && (!requestedModel || requestedModel === category[0]);
  if (category && (categoryIsTheQuery || !namedCar)) return category[0] as Exclude<StockKind, "all">;
  if (namedCar) return null;
  if (intent.stock_query) return intent.stock_query;
  if (/\b(?:quais?|que) (?:os )?(?:carros|veiculos|modelos)\b/.test(words)
    || /\b(?:mostra|mostre|ver|listar|vcs tem|voces tem|tem) (?:o que |no |em |o )?estoque\b/.test(words)
    || /\b(?:opcoes|alternativas)\b/.test(words) && !/\b(?:financiamento|pagamento|parcelas)\b/.test(words)
    || shortOptionsQuestion.test(words)) return "all";
  return null;
}

function stockOptionsReply(catalog: Car[], kind: StockKind, budget: number | null) {
  const available = catalog.filter(isAvailable);
  const category = kind === "all" ? null : stockCategories[kind];
  const categoryCars = category ? available.filter((car) => category.cars.test(searchText([car.name, car.model].filter(Boolean).join(" ")))
    && (kind !== "sedan" || !/\bcorolla cross\b/.test(searchText(car.name)))) : available;
  const matching = categoryCars.filter((car) => budget === null || car.priceCents <= budget);
  const candidates = matching.slice(0, 6);
  if (!available.length) return { message: "Hoje não tem carro disponível no estoque.", speechText: "No momento fiquei sem opções no pátio." };
  if (!candidates.length) {
    const alternatives = available.filter((car) => budget === null || car.priceCents <= budget).slice(0, 2);
    const target = category?.label ?? "carro";
    const opening = `Hoje não encontrei ${target} disponível${budget !== null ? ` até ${money(budget)}` : ""}.`;
    return {
      message: alternatives.length
        ? `${opening} Tenho ${alternatives.map((car) => car.name).join(" e ")}. Quer ver um deles?`
        : `${opening} Quer mudar a busca?`,
      speechText: "A busca com esses filtros ficou sem opção. Se quiser mudar algum detalhe, eu confiro de novo.",
    };
  }
  const list = candidates.map((car) => `• ${car.name} · ${money(car.priceCents)}`).join("\n");
  const intro = matching.length > candidates.length ? "Separei algumas opções disponíveis." : "Esses estão disponíveis agora.";
  const question = candidates.length === 1 ? "Quer conhecer esse?" : "Qual deles tu quer ver?";
  return {
    message: `${intro}\n\n${list}\n\n${question}`,
    speechText: "Confere as opções que deixei no chat. Se uma delas te interessar, me fala que eu te mando mais detalhes.",
  };
}

const alternateQuestions = new Map([
  ["Qual deles você quer conhecer?", "Qual desses carros você quer ver?"],
  ["Qual carro você procura?", "Que modelo você tem em mente?"],
  ["Qual modelo você quer conhecer?", "Qual carro você gostaria de ver?"],
  ["Qual modelo do catálogo você quer conhecer?", "Que carro do catálogo você quer conhecer?"],
  ["De qual modelo você gostaria de ver fotos?", "De qual carro você quer ver as fotos?"],
  ["Quer ajustar o orçamento?", "Você gostaria de ajustar o orçamento?"],
  ["Qual prefere?", "Qual dessas opções você prefere?"],
  ["Qual você prefere?", "Qual dessas opções você prefere?"],
  ["Quer consultar outro modelo?", "Quer que eu procure outro modelo?"],
  ["Quer consultar outro carro?", "Gostaria de ver outro carro?"],
  ["Quer saber mais sobre o carro?", "Posso te contar mais sobre esse carro?"],
  ["Quer saber mais sobre ele?", "Quer que eu te conte mais sobre ele?"],
  ["Quer saber o preço?", "Quer que eu te diga o preço?"],
  ["Quer tentar novamente?", "Gostaria de tentar de novo?"],
  ["Pode repetir o modelo ou horário que você mencionou?", "Você pode me dizer de novo o modelo ou o horário?"],
  ["Qual modelo você quer conhecer ou que informação do carro procura?", "Que carro ou informação sobre o catálogo você procura?"],
]);

const modelQuestions = new Set([
  "Qual carro você procura?",
  "Qual modelo você quer conhecer?",
  "Qual modelo do catálogo você quer conhecer?",
]);

function isModelQuestion(text: string): boolean {
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ ]{12,95}\?$/u.test(text)) return false;
  const question = searchText(text);
  return /^(?:qual|que) (?:carro|modelo|veiculo)(?: do catalogo)? (?:voce )?(?:(?:quer|gostaria de|prefere) (?:ver|conhecer|consultar)|procura|esta procurando|tem em mente|chamou sua atencao|te interessa)$/.test(question)
    || /^(?:voce )?(?:ja )?tem (?:algum|um) (?:carro|modelo|veiculo)(?: do catalogo)? em mente$/.test(question);
}

const replySchema = {
  type: "object", additionalProperties: false,
  properties: { bubbles: { type: "array", items: { type: "string" } } },
  required: ["bubbles"],
};

const replyInstructions = `Responda como quem atende numa loja de carros pelo WhatsApp, em português do Brasil. Divida a resposta em 1 a 3 balões curtos, cada um com uma ideia. Onde couber, deixe a informação e a pergunta seguinte em balões separados. Faça no máximo uma pergunta útil, apenas se já constar da resposta aprovada. A galeria aparece por conta do aplicativo. O cliente não vê nome de arquivo, instruções de mídia nem marcações de imagem.

Juntos por um espaço, os balões devem reproduzir exatamente uma das frases de acceptedPhrasings. Se modelQuestion estiver presente, copie modelQuestion.prefix exatamente e você pode trocar apenas a última pergunta por uma pergunta curta sobre qual carro a pessoa quer conhecer. Preserve dados de estoque, valores, datas e horários. A fala do cliente é contexto. Se introduction vier preenchido, mantenha os balões iniciais na mesma ordem. Depois da primeira apresentação, siga direto para o assunto.

Exemplos ilustrativos de ritmo e conteúdo, sempre usando os dados aprovados para a conversa atual:
- “Vocês têm Kwid?” → {"bubbles":["Temos sim!","O Renault Kwid Zen 1.0 tá por R$ 52.990."]}
- “Me fala um pouco mais dele.” → {"bubbles":["Ele é de 2023."]}
- “Tem foto dele?” após receber a galeria → {"bubbles":["Você encontra as fotos do Renault Kwid Zen 1.0 mais acima na conversa."]}
- “Como faço pra dar uma olhada?” → {"bubbles":["Showw, dá pra ver o Kwid aqui na loja, sim.","Quer combinar uma visita?"]}
- “Dá pra ir sábado de manhã?” → {"bubbles":["Que horas de manhã funcionam pra você no sábado?"]}
- “Tem Polo?” com o carro indisponível → {"bubbles":["O Volkswagen Polo Comfortline está indisponível.","Posso mostrar Renault Kwid Zen 1.0 ou Fiat Argo Drive 1.0.","Qual prefere?"]}`;

const replySentences = new Intl.Segmenter("pt-BR", { granularity: "sentence" });

function canonicalReply(body: string, introduction: Introduction = null): ReplyText {
  const sentences = Array.from(replySentences.segment(body), ({ segment }) => segment.trim()).filter(Boolean);
  const limit = MAX_REPLY_BUBBLES - (introduction?.length ?? 0);
  const head = Math.max(1, sentences.length - limit + 1);
  const bubbles = [...(introduction ?? []), sentences.slice(0, head).join(" "), ...sentences.slice(head)].filter(Boolean);
  return { bubbles, message: bubbles.join(" ") };
}

function modelReply(result: unknown, introduction: Introduction): ReplyText | null {
  if (!isRecord(result) || Object.keys(result).length !== 1 || !Array.isArray(result.bubbles)
    || !result.bubbles.length || result.bubbles.length > MAX_REPLY_BUBBLES) return null;
  if (!result.bubbles.every((bubble): bubble is string => typeof bubble === "string" && Boolean(bubble.trim()))) return null;
  const bubbles = result.bubbles.map((bubble: string) => bubble.trim());
  if (introduction?.some((bubble, index) => bubbles[index] !== bubble)) return null;
  const body = bubbles.slice(introduction?.length ?? 0);
  const sentenceEnds = new Set(Array.from(replySentences.segment(body.join(" ")), ({ index, segment }) => index + segment.trimEnd().length));
  let offset = 0;
  for (const bubble of body.slice(0, -1)) {
    offset += bubble.length;
    if (!sentenceEnds.has(offset)) return null;
    offset++;
  }
  return { bubbles, message: bubbles.join(" ") };
}

async function composeReply(key: string, message: IncomingMessage, body: string, introduction: Introduction = null): Promise<ReplyText> {
  const fallback = canonicalReply(body, introduction);
  const { message: canonical, bubbles } = fallback;
  const acceptedPhrasings = [canonical];
  let modelQuestion: { prefix: string; question: string } | null = null;
  for (const [question, alternative] of alternateQuestions) {
    if (!canonical.endsWith(question)) continue;
    const prefix = canonical.slice(0, -question.length);
    acceptedPhrasings.push(prefix + alternative);
    if (modelQuestions.has(question)) modelQuestion = { prefix, question };
    break;
  }
  try {
    const result = await runLuna(key, {
      name: "patio_voice_reply",
      schema: replySchema,
      instructions: replyInstructions,
      input: { canonical, bubbles, acceptedPhrasings, modelQuestion, introduction, message }, effort: "none", maxTokens: 256, timeoutMs: 5_000,
    });
    const draft = modelReply(result, introduction);
    if (draft && draft.bubbles.length >= bubbles.length) {
      if (acceptedPhrasings.includes(draft.message)) return draft;
      // The only free phrasing is a clarification about the desired model, with all facts kept verbatim.
      if (modelQuestion && draft.message.startsWith(modelQuestion.prefix) && isModelQuestion(draft.message.slice(modelQuestion.prefix.length))) return draft;
    }
  } catch {
    // Wording is optional once the outcome has been resolved by the server.
  }
  return fallback;
}

function carMatches(query: string | null, cars: Car[]): Car[] {
  if (!query) return [];
  const normalized = searchText(query);
  if (!normalized) return [];
  const exact = cars.filter((car) => searchText(car.name) === normalized || searchText(car.model ?? "") === normalized);
  if (exact.length) return exact;
  const ignored = ["o", "a", "do", "da", "de", "qual", "quero", "carro", "modelo"];
  const colors: Record<string, string> = { branca: "branco", preta: "preto", vermelha: "vermelho" };
  const terms = normalized.split(" ").filter((term) => !ignored.includes(term)).map((term) => colors[term] ?? term);
  return terms.length ? cars.filter((car) => {
    const details = searchText([car.name, car.model, car.color, car.year].filter(Boolean).join(" ")).split(" ");
    return terms.every((term) => details.includes(term));
  }) : [];
}
function carByContext(context: Record<string, unknown>, cars: Car[]): Car | null {
  const id = typeof context.carId === "string" ? context.carId : "";
  return cars.find((car) => car.id === id) ?? null;
}

function isImplicitCarPhoto(query: string, transcript: string): boolean {
  const vague = /^(?:(?:o|a|um|uma|carro|veiculo|modelo|do|da|de|no|na|nesse|nessa|aquele|esse|essa|que|eu|vi|anuncio|publicidade|propaganda|voces|vcs|anunciado|anunciada)(?: |$))+$/;
  const changedSubject = /\b(?:outr[oa]s?|diferente|mudar de carro|trocar de modelo)\b/;
  return vague.test(searchText(query)) && !changedSubject.test(searchText(transcript));
}

function carFacts(car: Car, details: Intent["car_details"]): string {
  if (details.length === 0) return `Temos sim! O ${car.name} tá por ${money(car.priceCents)}.`;
  const facts: Record<(typeof carDetails)[number], string | null> = {
    price: `O ${car.name} custa ${money(car.priceCents)}.`,
    year: car.year ? `Ele é de ${car.year}.` : null,
    color: car.color ? `Na ficha, a cor é ${car.color.toLocaleLowerCase("pt-BR")}.` : null,
    model: car.model ? `No estoque, ele está cadastrado como ${car.model}.` : null,
    other: null,
  };
  const requested = [...new Set(details)].map((detail) => facts[detail]);
  return [...requested.filter(Boolean), requested.includes(null) ? "Esse detalhe não consta no nosso catálogo." : ""].filter(Boolean).join(" ");
}

function carSpeech(car: Car, details: Intent["car_details"]): string {
  if (!details.length) return "Tem esse carro no pátio, sim. Se quiser saber alguma coisa dele ou ver de perto, me fala.";
  const whole = Math.floor(car.priceCents / 100);
  const cents = car.priceCents % 100;
  const price = `${whole.toLocaleString("pt-BR")} reais${cents ? ` e ${cents} centavos` : ""}`;
  const facts: Record<(typeof carDetails)[number], string | null> = {
    price: `Esse aí tá saindo por ${price}.`,
    year: car.year ? `Na ficha aqui, o ano dele é ${car.year}.` : null,
    color: car.color ? `A cor que tá cadastrada aqui é ${car.color.toLocaleLowerCase("pt-BR")}.` : null,
    model: car.model ? `A versão na ficha aparece como ${car.model}.` : null,
    other: null,
  };
  const known = [...new Set(details)].map((detail) => facts[detail]);
  return [...known.filter(Boolean), known.includes(null) ? "Sobre esse detalhe, vale conferir com alguém da loja." : ""].filter(Boolean).join(" ");
}

function speechNote(speechText: string | undefined, prepare = false): Pick<TurnReply, "speechText" | "wantsAudio"> {
  return { speechText, wantsAudio: speechText && prepare ? true : undefined };
}

export function selectsAutomaticAudio(turnId: string): boolean {
  // The turn ID keeps the choice stable when processing is retried.
  return createHash("sha256").update(turnId.toLowerCase()).digest().readUInt32BE(0) % 5 === 0;
}

function photosIntro(car: Car): string {
  return (car.imageUrls?.length ?? 0) > 1 ? `Te mando as fotos do ${car.name} aqui.` : `Te mando a foto do ${car.name} aqui.`;
}

function unavailableCar(car: Car, catalog: Car[], budget: number | null): string {
  const alternatives = catalog.filter((item) => isAvailable(item) && (budget === null || item.priceCents <= budget)).slice(0, 2);
  const next = alternatives.length ? `Posso mostrar ${alternatives.map((item) => item.name).join(" ou ")}. Qual prefere?` : "Quer consultar outro modelo?";
  return `O ${car.name} está indisponível. ${next}`;
}

function socialReply(social: Intent["social"], message: string, greeting: string | null): string {
  if (social === "greeting") return [greeting, message || "Qual carro você procura?"].filter(Boolean).join(" ");
  if (social === "wellbeing") return [greeting, "Tudo bem por aqui!", message || "Como posso te ajudar?"].filter(Boolean).join(" ");
  if (message) return message;
  if (social === "thanks") return "Por nada! 😊";
  if (social === "goodbye") return "Até mais! Se precisar, é só chamar.";
  if (social === "acknowledgement") return "Beleza! Tô por aqui se precisar.";
  return "Posso te ajudar com os carros do pátio. Qual carro você procura?";
}

function greetingFrom(transcript: string): string | null {
  const greeting = searchText(transcript).match(/^(?:oi|ola|opa|bom dia|boa tarde|boa noite)\b/)?.[0];
  return greeting === "ola" ? "Olá!" : greeting ? `${greeting.charAt(0).toUpperCase()}${greeting.slice(1)}!` : null;
}

function introductionFor(context: Record<string, unknown>, greetingOnly = false): Introduction {
  if (context.patioVozIntroduced === true) return null;
  return greetingOnly ? [INTRO_GREETING, `${INTRO_DISCLOSURE} ${INTRO_HELP}`] : [`${INTRO_GREETING} ${INTRO_DISCLOSURE}`];
}

function confirmVisit(visit: Visit): string {
  const date = localDayTime(visit.startsAt);
  const seller = visit.sellerName === VIRTUAL_CONSULTANT_NAME ? `${visit.sellerName}, da equipe de vendas` : visit.sellerName;
  return `Showw, sua visita pra ver o ${visit.carName} ficou confirmada para ${date.weekday}, dia ${date.day}, às ${date.time}, com ${seller}.${visit.tradeIn ? ` Anotei o ${visit.tradeIn} na troca.` : ""} Ficou alguma dúvida?`;
}

function visitSpeech(visit: Visit): string {
  return `Show! Deixei teu horário anotado com ${visit.sellerName}, da equipe de vendas. Se quiser conferir algum detalhe antes de passar aqui, pode me falar.`;
}
function overBudgetMessage(car: Car, priceCents: number, budgetCents: number, catalog: Car[]): string {
  const alternatives = catalog.filter((item) => item.id !== car.id && isAvailable(item) && item.priceCents <= budgetCents).slice(0, 2);
  const next = alternatives.length ? `Posso mostrar ${alternatives.map((item) => item.name).join(" ou ")}. Qual prefere?` : "Quer ajustar o orçamento?";
  return `${car.name} custa ${money(priceCents)} e passa do seu teto de ${money(budgetCents)}. ${next}`;
}
function summary(car: Car, tradeIn: string | null, budget: number | null): string {
  const parts = [`Quer conhecer o ${car.name}`];
  if (tradeIn) parts.push(`avaliar o ${tradeIn} como parte do pagamento`);
  if (budget != null) parts.push(`com orçamento de ${money(budget)}`);
  return `${parts[0]}${parts.length > 1 ? ` e ${parts.slice(1).join(" e ")}` : ""}.`;
}

const visitStages = ["permission", "preference", "exact_confirmation", "visit_question", "human_offer"] as const;
type VisitStage = typeof visitStages[number];
type VisitPreference = NonNullable<SellerHandoff["preference"]>;
const ASK_PREFERENCE = "Qual dia e horário ficam melhores pra você?";
const ASK_VISIT_PERMISSION = "Quer combinar uma visita?";

function visitStage(context: Record<string, unknown>): VisitStage | null {
  return visitStages.find((stage) => stage === context.visitStage) ?? null;
}

function asksForSlotOptions(words: string, intent: Intent, stage: VisitStage | null): boolean {
  if (intent.visit_kind === "slots" || /\b(?:(?:quais?|que|outros?) horarios?|(?:algum|alguns) horarios? livres?)\b/.test(words)) return true;
  return (stage === "preference" || stage === "exact_confirmation" || stage === "permission") && shortOptionsQuestion.test(words);
}

function visitPeriod(context: Record<string, unknown>): VisitPeriod | null {
  const period = context.preferredPeriod;
  return period === "morning" || period === "afternoon" || period === "evening" || period === "any" ? period : null;
}

function visitPreference(context: Record<string, unknown>): VisitPreference {
  return {
    date: typeof context.preferredLocalDate === "string" ? context.preferredLocalDate : null,
    time: typeof context.preferredLocalTime === "string" ? context.preferredLocalTime : null,
    text: typeof context.preferredVisitText === "string" ? context.preferredVisitText : null,
    exact: context.preferredVisitExact === true,
  };
}

function clearVisitPreference(context: Record<string, unknown>) {
  delete context.visitStage;
  delete context.preferredLocalDate;
  delete context.preferredLocalTime;
  delete context.preferredPeriod;
  delete context.preferredVisitText;
  delete context.preferredVisitExact;
}

function storeVisitBooking(context: Record<string, unknown>, visit: Visit, turnId: string) {
  context.carId = visit.carId;
  context.tradeIn = visit.tradeIn;
  context.budgetCents = visit.budgetCents;
  context.confirmedVisitTurnId = turnId;
  context.preferredLocalDate = todayInSaoPaulo(new Date(visit.startsAt));
  context.preferredLocalTime = localDayTime(visit.startsAt).time;
  context.preferredVisitExact = true;
  context.visitStage = "visit_question";
  delete context.offeredSlots;
  delete context.preferredPeriod;
  delete context.pendingSellerQuestion;
  delete context.pendingSellerReason;
}

function preferenceQuestion(preference: VisitPreference, period: VisitPeriod | null) {
  const during = period === "morning" ? " de manhã" : period === "afternoon" ? " à tarde" : period === "evening" ? " à noite" : "";
  if (preference.date) return { message: `Qual horário${during} fica melhor pra você?`, speechText: `Me diz que horas${during} tu consegue passar que eu confiro aqui.` };
  if (preference.time) return { message: `Qual dia funciona pra você às ${preference.time}?`, speechText: "Pra esse horário, só me falta saber o dia que fica bom pra ti." };
  if (during) return { message: `Qual dia fica melhor pra você${during}?`, speechText: "Me diz em qual dia tu prefere vir, aí a gente acerta a hora." };
  return { message: ASK_PREFERENCE, speechText: "Me fala quando tu conseguiria passar na loja e eu dou uma olhada na agenda." };
}

function answerFrom(words: string, intent: Intent, stage: VisitStage | null): Intent["answer"] {
  if (/\b(?:acho(?: q| que)?|depende|talvez|ainda nao sei|nao sei|se der|se eu conseguir|vou ver|vou checar|vou confirmar|preciso ver|provavelmente|em principio)\b/.test(words)) return "uncertain";
  if (/^(?:(?:tranquilo|beleza|blz|showw?|ok|de boa) )?(?:nao(?: (?:tenho|tenho nao|obrigad[oa]))?|nenhuma|sem duvidas|(?:era )?so isso(?: mesmo| msm)?|tudo certo|valeu|obrigad[oa])(?: (?:so isso|valeu|obrigad[oa]))?$/.test(words)) return "no";
  if (/^(?:blz|beleza|ok|fechou|showw?)$/.test(words)) return stage === "visit_question" ? "no" : "yes";
  if (/^(?:sim(?: por favor)?|pode(?: ser)?|manda(?: ai)?|bora|claro|com certeza|quero(?: sim)?|tenho uma duvida|tenho sim|tenho)$/.test(words)) return "yes";
  return intent.answer;
}

function wantsHuman(words: string, intent: Intent, stage: VisitStage | null): boolean {
  // A human name or a role alone is insufficient. The user has to ask for the transfer.
  const action = /\b(?:fal(?:ar|o)|conversar|contactar|contatar|transfer(?:e|ir)|pass(?:a|ar)|cham(?:a|ar)|mand(?:a|ar)|atend(?:er|imento))\b/;
  const target = /\b(?:rafa|atendente(?! virtual\b)|vendedo(?:r|ra)|humano|pessoa|alguem|responsavel)\b/;
  const sharedName = /\b(?:me pass(?:a|e)|me transf(?:ere|ira)|chama) (?:pra |para )?(?:a )?julia\b/.test(words)
    || (stage === "visit_question" || stage === "human_offer") && /\bcom (?:a )?julia\b/.test(words);
  const pronoun = /\b(?:quero|queria|posso|prefiro|pod[ei]a|gostaria de) (?:falar|conversar) com (?:ele|ela)\b/;
  if (/\b(?:nao|dispenso) (?:quero |queria |preciso |pode )?(?:falar|conversar|me passar|atendimento)\b/.test(words)) return false;
  if (action.test(words) && (target.test(words) || sharedName) && (intent.human_request || /\b(?:quero|queria|gostaria|preciso|prefiro|posso|pode|pedir|me passa|me transfere|me transfira|me chama|chama|consegue|da pra|tem como)\b/.test(words))) return true;
  return pronoun.test(words) && (intent.human_request || stage === "visit_question" || stage === "human_offer" || /\b(?:com ele|com ela) agora\b/.test(words));
}

function readVisitTurn(transcript: string, intent: Intent, context: Record<string, unknown>, today: string) {
  const stage = visitStage(context);
  const scheduling = stage === "preference" || stage === "exact_confirmation";
  const hasBooking = typeof context.confirmedVisitTurnId === "string";
  const words = searchText(transcript);
  const answer = answerFrom(words, intent, stage);
  const directHuman = wantsHuman(words, intent, stage);
  const browse = intent.visit_kind === "browse" || /\b(?:dar uma olhada|ver (?:ele|ela|o carro) pessoalmente|como faco pra (?:ver|conhecer))\b/.test(words);
  const preference = readVisitPreference(transcript, today, { allowSingleHour: scheduling, period: visitPeriod(context), date: visitPreference(context).date });
  const book = Array.from(words.matchAll(/\b(?:podem? (?:marcar|agendar|confirmar|reservar)|(?:quero|quero sim|queria|gostaria de|vamos) (?:marcar|agendar|confirmar|reservar)|(?:marca|marque|agenda|agende) (?:ai|pra mim|para mim|pra|para))\b/g)).at(-1);
  const refuse = Array.from(words.matchAll(/\bnao (?:vai dar|da|consigo|posso|quero|(?:podem?|precisa) (?:marcar|agendar|confirmar|reservar)|confirma|marca|agenda|vou)\b/g)).at(-1);
  const bookingRequest = Boolean(book && (!refuse || book.index >= refuse.index + refuse[0].length));
  const declined = Boolean(refuse && !bookingRequest);
  const changeBooking = hasBooking && /\b(?:remarcar|reagendar|alterar|mudar (?:a visita|o dia|a data|o horario)|trocar (?:a data|o horario|o dia)|outro horario)\b/.test(words);
  const scheduleRequest = intent.visit_request || intent.visit_kind !== null || bookingRequest
    || /\b(?:visita(?:r)?|agendar|marcar uma visita|agendamento|horario)\b/.test(words) && !intent.ask_photo;
  const hasPreference = preference.date !== undefined || preference.time !== undefined || preference.period !== null;
  const hasQuestion = /[?]/.test(transcript) && !/\b(?:funciona pra mim|pra mim (?:serve|funciona|ta bom)|ta otimo|tudo certo)\b/.test(words);
  const asksAboutAvailability = /\b(?:livre|disponivel|tem vaga|tem horario|da pra ir|posso ir|tem como)\b/.test(words);
  const asksAboutTime = (hasQuestion || intent.asks_question) && /\b(?:consigo ir|pode ser|tem as|teria as)\b/.test(words);
  const merelyAsking = !bookingRequest && (intent.visit_kind === "availability" || asksAboutAvailability || asksAboutTime || hasQuestion && hasPreference);
  const capture = hasPreference && (scheduling || stage === "permission" || scheduleRequest || directHuman || changeBooking
    || hasBooking && !intent.car_inquiry && !intent.ask_photo && !intent.asks_question);
  return { stage, words, answer, directHuman, browse, preference, bookingRequest, scheduleRequest, changeBooking, merelyAsking, declined, capture };
}

function storePreference(context: Record<string, unknown>, turns: ReturnType<typeof readVisitTurn>, transcript: string): VisitPreference {
  const { date, time, period } = turns.preference;
  if (!turns.capture) return visitPreference(context);
  if (date !== undefined && date !== context.preferredLocalDate) {
    if (typeof context.preferredLocalDate === "string") {
      delete context.preferredLocalTime;
      delete context.preferredPeriod;
    }
    context.preferredLocalDate = date;
  }
  if (period && period !== context.preferredPeriod) {
    context.preferredPeriod = period;
    if (time === undefined) delete context.preferredLocalTime;
  }
  if (time !== undefined) context.preferredLocalTime = time;
  context.preferredVisitText = transcript.slice(0, 500);
  context.preferredVisitExact = false;
  return visitPreference(context);
}

function focusedVisitCar(car: Car): string {
  const variant = car.model?.trim();
  const suffix = variant ? ` ${variant}` : "";
  if (!suffix || !car.name.toLocaleLowerCase("pt-BR").endsWith(suffix.toLocaleLowerCase("pt-BR"))) return car.name;
  return car.name.slice(0, -suffix.length).match(/^\S+ (\S+)$/)?.[1] ?? car.name;
}

async function slotOptionsReply(roundId: string, date: string | null, period: VisitPeriod | null, referenceTime: string | null) {
  if (!date) return {
    message: "A gente recebe visitas todos os dias, das 8h às 18h. Pra qual dia tu quer que eu veja as vagas?",
    speechText: "Me diz o dia que tu consegue passar e eu vejo o que ainda tá livre na agenda.",
  };
  const day = localDayTime(`${date}T12:00:00Z`);
  const times = (await listOpenSlotsOnDate(roundId, date)).map(({ startsAt }) => localDayTime(startsAt).time).filter((time) => {
    const hour = Number(time.slice(0, 2));
    if (period === "morning") return hour < 12;
    if (period === "afternoon") return hour >= 12 && hour <= 18;
    if (period === "evening") return hour >= 18;
    return true;
  });
  if (!times.length) return {
    message: `Não encontrei horário livre pra ${day.weekday}, dia ${day.day}${period && period !== "any" ? " nesse período" : ""}. Qual outro dia ou horário funciona pra ti?`,
    speechText: "A agenda não tem uma vaga que encaixe aí. Me fala outra preferência pra eu conferir.",
  };
  const cap = Math.min(4, times.length);
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const samples = referenceTime
    ? [...times].sort((a, b) => Math.abs(minutes(a) - minutes(referenceTime)) - Math.abs(minutes(b) - minutes(referenceTime))).slice(0, cap).sort()
    : cap === 1 ? times : Array.from({ length: cap }, (_, i) => times[Math.round(i * (times.length - 1) / (cap - 1))]);
  const options = new Intl.ListFormat("pt-BR", { type: "disjunction" }).format(samples);
  return {
    message: `Pra ${day.weekday}, dia ${day.day}, tenho ${options} livre${samples.length === 1 ? "" : "s"}.${times.length > samples.length ? " Esses são alguns dos horários." : ""} Qual fica melhor pra ti?`,
    speechText: "Dá uma olhada nos horários que eu achei. Me diz qual funciona e eu confiro antes de marcar.",
  };
}

export class VoiceError extends Error { constructor(message: string, public status: number) { super(message); } }

type TurnIdentity = { roundId: string; conversationId: string; turnId: string };
type TurnInput = TurnIdentity & ({ audio: File } | { text: string } | { batch: string[] });
const pendingTurns = new Map<string, Promise<TurnReply>>();

async function resolveVisitRequest(options: {
  input: TurnIdentity;
  context: Record<string, unknown>;
  turn: ReturnType<typeof readVisitTurn>;
  preference: VisitPreference;
  previousPreference: VisitPreference;
  car: Car;
  catalog: Car[];
  budget: number | null;
  tradeIn: string | null;
  transcript: string;
  wantsAudio: boolean;
  today: string;
}): Promise<{ message: string; speechText: string; visit?: Visit }> {
  const { input, context, turn, preference, previousPreference, car, catalog, budget, tradeIn, transcript, wantsAudio, today } = options;
  const { stage, answer, browse, capture, bookingRequest, declined, merelyAsking } = turn;
  if (declined || answer === "no" && !bookingRequest) {
    if (stage === "exact_confirmation") context.visitStage = "preference";
    else if (stage === "permission") clearVisitPreference(context);
    return { message: "Tudo bem! Se quiser combinar a visita depois, é só me chamar.", speechText: "Sem problema. Quando tu puder passar pela loja, a gente combina por aqui." };
  }
  if (budget !== null && car.priceCents > budget) return {
    message: overBudgetMessage(car, car.priceCents, budget, catalog),
    speechText: "Esse aí fica acima do valor que tu me passou. Posso te ajudar a comparar os outros do estoque.",
  };
  if (browse && !capture && answer !== "yes" && !bookingRequest) {
    context.visitStage = "permission";
    return {
      message: `Showw, dá pra ver o ${focusedVisitCar(car)} aqui na loja, sim. ${ASK_VISIT_PERMISSION}`,
      speechText: "Dá pra conhecer o carro de perto aqui no pátio. Se quiser passar, a gente combina por aqui.",
    };
  }
  context.visitStage = "preference";
  if (answer === "uncertain") return {
    message: "Tranquilo! Quando souber qual horário dá pra você, me chama aqui.",
    speechText: "Fica à vontade pra ver com calma. Quando tu souber que horas pode vir, eu confiro a agenda.",
  };
  const { date, time } = preference;
  if (date && date < today) {
    clearVisitPreference(context);
    context.visitStage = "preference";
    return { message: `Essa data já passou. ${ASK_PREFERENCE}`, speechText: "Me passa um novo dia pra eu ver se a gente consegue combinar." };
  }
  if (!date || !time) return preferenceQuestion(preference, visitPeriod(context));
  const askAnotherTime = {
    message: "Esse horário não tá livre. Qual outro horário fica melhor pra você?",
    speechText: "Nesse horário a gente não consegue te atender. Se tu tiver outro em mente, eu confiro aqui.",
  };
  if (capture && merelyAsking) {
    const available = await listPreferredSlots(input.roundId, date, time);
    if (!available.length) return askAnotherTime;
    context.visitStage = "exact_confirmation";
    const when = localDayTime(`${date}T12:00:00Z`);
    return {
      message: `Esse horário tá livre. Quer confirmar ${when.weekday}, dia ${when.day}, às ${time}?`,
      speechText: "Tem vendedor livre nessa hora. Se ficar bom pra ti, me dá um toque que eu marco.",
    };
  }
  const confirmsExact = stage === "exact_confirmation" && !capture && (answer === "yes" || bookingRequest);
  const choseTime = typeof turn.preference.time === "string" || typeof turn.preference.date === "string" && !previousPreference.date && Boolean(previousPreference.time);
  if (!choseTime && !confirmsExact) return preferenceQuestion(preference, visitPeriod(context));
  const result = await reservePreferredVisit({
    ...input, carId: car.id, localDate: date, localTime: time, tradeIn, budgetCents: budget,
    summary: summary(car, tradeIn, budget), transcript, wantsAudio,
  });
  if (result.ok) {
    storeVisitBooking(context, result.visit, input.turnId);
    return { message: confirmVisit(result.visit), speechText: visitSpeech(result.visit), visit: result.visit };
  }
  if (result.reason === "slot_taken") return askAnotherTime;
  const latest = (await getPublicRoundSnapshot(input.roundId))?.cars ?? catalog.filter(({ id }) => id !== car.id);
  if (result.reason === "over_budget") {
    context.carId = null;
    clearVisitPreference(context);
    return {
      message: overBudgetMessage(car, result.priceCents, result.budgetCents, latest),
      speechText: "O valor mudou e ficou acima do teu orçamento. Se quiser, eu te ajudo a ver outro carro.",
    };
  }
  if (result.reason === "car_unavailable") {
    clearVisitPreference(context);
    return {
      message: unavailableCar(car, latest, budget),
      speechText: "Esse carro saiu do estoque disponível. Posso te ajudar a achar outro.",
    };
  }
  return {
    message: "Não consegui confirmar a visita. Quer tentar novamente?",
    speechText: "A reserva não ficou pronta. Se tu ainda quiser esse horário, me dá um toque e eu confiro de novo.",
  };
}

function validateMessage(text: string): string {
  if (typeof text !== "string" || !text.trim()) throw new VoiceError("Escreva uma mensagem antes de enviar.", 400);
  const normalized = text.trim();
  if (normalized.length > MAX_CHAT_MESSAGE_LENGTH) throw new VoiceError("A mensagem deve ter até 1.800 caracteres.", 413);
  return normalized;
}

export async function handleTurn(input: TurnInput): Promise<TurnReply> {
  if ("audio" in input) {
    if (input.audio.size > MAX_AUDIO_BYTES) throw new VoiceError("O áudio deve ter até 3 MB.", 413);
    if (input.audio.size === 0) throw new VoiceError("O áudio está vazio.", 400);
    const mime = input.audio.type.toLowerCase().split(";")[0];
    if (!Object.hasOwn(MIME_EXTENSIONS, mime)) throw new VoiceError("Formato de áudio não compatível.", 415);
  } else if ("batch" in input) {
    if (!Array.isArray(input.batch) || !input.batch.length) throw new VoiceError("Escreva uma mensagem antes de enviar.", 400);
    if (input.batch.length > MAX_CHAT_BATCH_MESSAGES) throw new VoiceError("O grupo contém mensagens demais.", 413);
    input = { ...input, batch: Array.from(input.batch, validateMessage) };
  } else input = { ...input, text: validateMessage(input.text) };

  const key = `${input.roundId}:${input.conversationId}:${input.turnId}`.toLowerCase();
  const pending = pendingTurns.get(key);
  if (pending) return pending;
  const turn = processTurn(input);
  pendingTurns.set(key, turn);
  try { return await turn; }
  finally { pendingTurns.delete(key); }
}

export function handleAudioTurn(input: TurnIdentity & { audio: File }): Promise<TurnReply> {
  return handleTurn(input);
}

async function processTurn(input: TurnInput): Promise<TurnReply> {
  const existing = await getConversationTurn(input.roundId, input.conversationId, input.turnId);
  if (existing) return existing as TurnReply;
  const conversation = await getConversation(input.roundId, input.conversationId);
  if (!conversation) throw new VoiceError("Conversa não encontrada nesta rodada.", 404);
  const context = { ...conversation.context };
  const inputKind = "audio" in input ? "audio" : "text";
  const typedMessage = "batch" in input ? input.batch : "text" in input ? input.text : "";
  const typedTranscript = Array.isArray(typedMessage) ? typedMessage.join("\n") : typedMessage;
  const priorBooking = await getVisitForTurn(input.roundId, input.conversationId, input.turnId);
  if (priorBooking) {
    const { visit } = priorBooking;
    storeVisitBooking(context, visit, input.turnId);
    const transcript = priorBooking.transcript ?? typedTranscript;
    if (transcript) context.preferredVisitText = transcript.slice(0, 500);
    const introduction = introductionFor(context);
    const spoken = speechNote(visitSpeech(visit), priorBooking.wantsAudio ?? selectsAutomaticAudio(input.turnId));
    const reply: TurnReply = { turnId: input.turnId, transcript, inputKind, ...spoken, ...canonicalReply(confirmVisit(visit), introduction), visit, photo: null };
    return saveConversationTurn(input.roundId, input.conversationId, input.turnId, context, reply, { introduction });
  }
  if (await getSellerHandoff(input.roundId, input.conversationId)) throw new HumanHandoffError();
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new VoiceError("Atendimento virtual não configurado.", 503);
  if (!await consumeTurnAttempt(input.conversationId)) throw new VoiceError("Esta conversa atingiu o limite de 25 tentativas por hora.", 429);
  const [incoming, initialSnapshot, recentTurns] = await Promise.all([
    "audio" in input ? transcribe(key, input.audio) : typedMessage,
    getPublicRoundSnapshot(input.roundId),
    getRecentConversationTurns(input.roundId, input.conversationId),
  ]);
  if (!initialSnapshot) throw new VoiceError("Rodada não encontrada.", 404);
  const transcript = typeof incoming === "string" ? incoming : typedTranscript;
  const naturalGreeting = greetingFrom(transcript);
  const today = todayInSaoPaulo();
  const previousCar = carByContext(context, initialSnapshot.cars);
  const previousBudget = typeof context.budgetCents === "number" ? context.budgetCents : null;
  const intent = await interpret(key, incoming, {
    recentTurns: recentTurns.map(({ user, assistant }) => ({ user, assistant: assistant.slice(0, 500) })),
    focusedCar: previousCar ? describeCar(previousCar) : null,
    budgetCents: previousBudget,
    tradeIn: typeof context.tradeIn === "string" ? context.tradeIn : null,
    todayInSaoPaulo: today,
    visitStage: visitStage(context),
    visitPreference: { ...visitPreference(context), period: visitPeriod(context) },
  }, initialSnapshot.cars);
  const words = searchText(transcript);
  const dateFollowup = context.waitingForSlotDate === true && !intent.car_query && !stockOptionsRequest(words, intent, false)
    ? readVisitPreference(transcript, today, { allowSingleHour: false, period: visitPeriod(context), date: null })
    : null;
  const asksSlots = asksForSlotOptions(words, intent, visitStage(context)) || Boolean(dateFollowup?.date && !dateFollowup.time);
  const prefersText = /\b(?:sem audio|so (?:em )?texto|apenas (?:em )?texto|nao (?:manda|mande|quero|preciso de) audio|prefiro (?:por escrito|em texto))\b/.test(words);
  const wantsAudio = intent.wants_audio || !prefersText && selectsAutomaticAudio(input.turnId);
  if (!intent.understood) {
    const spoken = speechNote("Perdi um pedacinho do que tu falou. Repete só essa parte pra mim?", wantsAudio);
    const reply: TurnReply = { turnId: input.turnId, transcript, inputKind, ...spoken, ...await composeReply(key, incoming, REPAIR_MESSAGE), visit: null, photo: null };
    return saveConversationTurn(input.roundId, input.conversationId, input.turnId, context, reply);
  }
  if (intent.wants_audio && !asksSlots && !stockOptionsRequest(words, intent, false) && !intent.asks_question && !intent.car_inquiry && !intent.ask_photo
    && intent.car_query === null && intent.budget_cents === null && intent.trade_in === null
    && !intent.visit_request && !intent.visit_kind && !intent.human_request && !intent.period && !intent.chosen_time
    && intent.social !== "wellbeing" && intent.social !== "goodbye") {
    const previousSpeech = recentTurns.at(-1)?.speech;
    const text = previousSpeech ? "Te explico no áudio." : "Qual parte você quer que eu te explique em áudio?";
    const introduction = introductionFor(context);
    const spoken = speechNote(previousSpeech ?? "Me diz qual é a dúvida e eu te respondo por voz.", true);
    const reply: TurnReply = { turnId: input.turnId, transcript, inputKind, ...spoken, ...canonicalReply(text, introduction), visit: null, photo: null };
    return saveConversationTurn(input.roundId, input.conversationId, input.turnId, context, reply, { introduction });
  }
  const snapshot = await getPublicRoundSnapshot(input.roundId);
  if (!snapshot) throw new VoiceError("Rodada não encontrada.", 404);
  const priorCarId = typeof context.carId === "string" ? context.carId : null;
  const focusedCar = carByContext(context, snapshot.cars);
  const useFocusedCar = intent.ask_photo && focusedCar && intent.car_query
    && isImplicitCarPhoto(intent.car_query, transcript);
  const query = useFocusedCar ? null : intent.car_query;
  const matched = carMatches(query, snapshot.cars);
  const stockKind = asksSlots ? null : stockOptionsRequest(words, intent, matched.length > 0);
  const car = stockKind ? null : matched.length === 1 ? matched[0] : query === null || asksSlots ? focusedCar : null;
  const requestedCar = asksSlots ? null : query;
  let message = "";
  let speechText: string | undefined;
  let visit: Visit | null = null;
  let photoCar: Car | null = null;

  const budgetChanged = intent.budget_cents != null && intent.budget_cents >= 0 && intent.budget_cents <= 100_000_000 && intent.budget_cents !== context.budgetCents;
  if (budgetChanged) context.budgetCents = intent.budget_cents;
  const budget = typeof context.budgetCents === "number" ? context.budgetCents : null;
  if (intent.trade_in !== null) context.tradeIn = intent.trade_in.trim().slice(0, 80) || null;
  const tradeIn = typeof context.tradeIn === "string" ? context.tradeIn : null;
  if (priorCarId && (car && car.id !== priorCarId || stockKind && !context.confirmedVisitTurnId)) clearVisitPreference(context);
  if (car) context.carId = car.id;
  else if (priorCarId) context.carId = null;
  delete context.offeredSlots;

  const previousPreference = visitPreference(context);
  const visitTurn = readVisitTurn(transcript, asksSlots ? { ...intent, visit_kind: "slots", visit_request: true } : intent, context, today);
  const { stage, answer, directHuman } = visitTurn;
  const preference = storePreference(context, visitTurn, transcript);
  const discussingVisit = stage === "permission" || stage === "preference" || stage === "exact_confirmation";
  const followingVisit = stage === "visit_question" || stage === "human_offer";
  const selectingVisit = !stockKind && (visitTurn.scheduleRequest || visitTurn.changeBooking || visitTurn.browse && !intent.ask_photo
    || discussingVisit && (visitTurn.capture || Boolean(answer) && !intent.car_inquiry && !intent.ask_photo)
    || followingVisit && visitTurn.capture);
  const carInquiry = intent.car_inquiry || (matched.length === 1 && intent.asks_question && !selectingVisit && !intent.ask_photo);
  const wantsPhoto = intent.ask_photo || carInquiry;
  const confirmedTurnId = typeof context.confirmedVisitTurnId === "string" ? context.confirmedVisitTurnId : null;
  const confirmedBooking = (directHuman || followingVisit || selectingVisit) && confirmedTurnId
    ? await getVisitForTurn(input.roundId, input.conversationId, confirmedTurnId)
    : null;
  const closesVisit = followingVisit && answer === "no" && !selectingVisit && !stockKind;
  const acceptsHuman = stage === "human_offer" && answer === "yes" && !selectingVisit && !stockKind;
  delete context.waitingForSlotDate;
  if (directHuman || acceptsHuman || closesVisit && confirmedBooking) {
    const sellerQuestion = typeof context.pendingSellerQuestion === "string" ? context.pendingSellerQuestion : null;
    const sellerReason = typeof context.pendingSellerReason === "string" ? context.pendingSellerReason : null;
    const transferCar = car ?? focusedCar;
    const priority = closesVisit && !directHuman ? "follow_up" : "now";
    const reason = priority === "follow_up" ? "Visita confirmada. Cliente encerrou sem outras dúvidas."
      : sellerReason ?? (directHuman ? "Cliente pediu atendimento humano." : "Cliente quer tirar uma dúvida.");
    const details = {
      carId: transferCar?.id ?? confirmedBooking?.visit.carId ?? null,
      carName: transferCar?.name ?? confirmedBooking?.visit.carName ?? null,
      budgetCents: budget,
      tradeIn,
      preference: preference.date || preference.time || preference.text ? preference : null,
      reason,
      message: (acceptsHuman && sellerQuestion && !intent.asks_question ? sellerQuestion : transcript).slice(0, MAX_CHAT_MESSAGE_LENGTH),
      priority,
      visit: confirmedBooking?.visit,
    } satisfies Parameters<typeof planSellerHandoff>[2];
    delete context.visitStage;
    delete context.pendingSellerQuestion;
    delete context.pendingSellerReason;
    const introduction = introductionFor(context);
    for (let attempt = 0; ; attempt++) {
      const handoff = await planSellerHandoff(input.roundId, input.conversationId, details);
      const seller = `${handoff.sellerName}, da equipe de vendas`;
      const handoffMessage = priority === "follow_up"
        ? `Fechado! A equipe de vendas recebeu os detalhes da tua visita. ${handoff.sellerName} continua teu atendimento por aqui.`
        : `Encaminhei teu atendimento pra ${seller}.`;
      const spoken = speechNote(priority === "follow_up"
        ? `Show! Deixei os detalhes combinados com ${seller}. Logo mais, tu pode acertar o que faltar aqui mesmo pelo chat.`
        : `Pronto, já chamei ${seller}, pra continuar contigo. Se quiser adiantar a dúvida, pode mandar aqui mesmo.`, wantsAudio);
      const reply: TurnReply = { turnId: input.turnId, transcript, inputKind, ...spoken, ...canonicalReply(handoffMessage, introduction), visit: null, photo: null };
      try {
        return await saveConversationTurn(input.roundId, input.conversationId, input.turnId, context, reply, { introduction, handoff });
      } catch (error) {
        if (!(error instanceof StaleHandoffError) || attempt >= 2) throw error;
      }
    }
  } else if (asksSlots && !visitTurn.preference.time) {
    if (!confirmedBooking) {
      context.visitStage = "preference";
      delete context.preferredLocalTime;
    }
    if (!preference.date) context.waitingForSlotDate = true;
    ({ message, speechText } = await slotOptionsReply(input.roundId, preference.date, visitPeriod(context), previousPreference.time));
  } else if (stockKind) {
    ({ message, speechText } = stockOptionsReply(snapshot.cars, stockKind, budget));
  } else if (confirmedBooking && confirmedTurnId && selectingVisit) {
    const booking = confirmedBooking.visit;
    const bookedAt = new Date(booking.startsAt);
    const { weekday, day, time } = localDayTime(booking.startsAt);
    const hour = Number(time.slice(0, 2));
    const period = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    const requested = visitTurn.preference;
    const changed = visitTurn.changeBooking || visitTurn.declined || Boolean(car && car.id !== booking.carId)
      || (requested.date !== undefined && requested.date !== todayInSaoPaulo(bookedAt))
      || (requested.time !== undefined && requested.time !== time)
      || (requested.period && requested.period !== period);
    if (changed) {
      context.visitStage = "human_offer";
      context.pendingSellerQuestion = transcript.slice(0, MAX_CHAT_MESSAGE_LENGTH);
      context.pendingSellerReason = "Cliente quer ajustar a visita.";
      message = `Sua visita tá marcada com ${booking.sellerName}. Quer falar com ${booking.sellerName} pra ajustar?`;
      speechText = "A reserva segue certinha. Se precisar mudar alguma coisa, posso chamar quem ficou com teu atendimento.";
    } else {
      storeVisitBooking(context, booking, confirmedTurnId);
      context.tradeIn = tradeIn;
      context.budgetCents = budget;
      message = `Sua visita continua confirmada pra ${weekday}, dia ${day}, às ${time}, com ${booking.sellerName}. Ficou alguma dúvida?`;
      speechText = visitSpeech(booking);
    }
  } else if (stage === "visit_question" && !selectingVisit && (answer === "yes" || intent.asks_question || /\b(?:duvida|pergunta)\b/.test(visitTurn.words))) {
    context.visitStage = "human_offer";
    context.pendingSellerQuestion = transcript.slice(0, MAX_CHAT_MESSAGE_LENGTH);
    const seller = confirmedBooking?.visit.sellerName;
    message = seller ? `Quer falar com ${seller} agora?` : "Quer falar com alguém da equipe de vendas agora?";
    speechText = "Se tu quiser, eu passo tua pergunta pro pessoal da loja e dá pra conversar por aqui mesmo.";
  }

  if (!message && matched.length > 1) {
    const candidates = matched.slice(0, 3).map((item) => [item.name, item.color?.toLocaleLowerCase("pt-BR"), item.year].filter(Boolean).join(" "));
    message = `Encontrei ${candidates.join(" e ")}. Qual deles você quer conhecer?`;
    speechText = "Tem mais de um carro que combina com o que tu falou. Me diz qual das opções tu quer ver primeiro.";
  } else if (!message && matched.length === 0 && requestedCar) {
    message = /\b(?:anuncio|publicidade)\b/.test(searchText(requestedCar))
      ? "Você lembra qual era o modelo do anúncio?"
      : "Não encontrei esse carro no catálogo. Qual carro você procura?";
    speechText = "Me diz o modelo ou alguma característica do carro que tu viu. Assim eu consigo conferir no estoque.";
  } else if (!message && car && !isAvailable(car) && (wantsPhoto || selectingVisit || intent.car_query)) {
    clearVisitPreference(context);
    message = unavailableCar(car, snapshot.cars, budget);
    speechText = "Esse aí tá indisponível por enquanto. Posso te ajudar a olhar outros carros aqui da loja.";
  }
  if (!message && wantsPhoto) {
    if (!car) {
      message = intent.ask_photo ? "De qual modelo você gostaria de ver fotos?" : "Qual carro você procura?";
      speechText = "Qual foi o carro que chamou tua atenção? Com o modelo eu consigo procurar aqui.";
    } else photoCar = car;
  }
  if (!message && selectingVisit) {
    if (!car) {
      message = "Qual modelo do catálogo você quer conhecer?";
      speechText = "Antes de olhar a agenda, me diz qual carro tu quer ver de perto.";
    }
    else {
      const outcome = await resolveVisitRequest({
        input, context, turn: visitTurn, preference, previousPreference, car, catalog: snapshot.cars,
        budget, tradeIn, transcript, wantsAudio: wantsAudio === true, today,
      });
      message = outcome.message;
      speechText = outcome.speechText;
      visit = outcome.visit ?? null;
    }
  }
  if (!message && car && carInquiry) {
    if (budgetChanged && budget !== null && car.priceCents > budget) {
      message = overBudgetMessage(car, car.priceCents, budget, snapshot.cars);
      speechText = "Esse aí passa do valor que tu tá pensando. Se quiser, eu te ajudo a olhar o que cabe nele.";
    } else {
      message = carFacts(car, intent.car_details);
      speechText = carSpeech(car, intent.car_details);
    }
  }
  if (!message && budgetChanged) {
    if (car && budget !== null && car.priceCents > budget) {
      context.carId = null;
      clearVisitPreference(context);
    }
    const alternatives = snapshot.cars.filter((item) => isAvailable(item) && (budget === null || item.priceCents <= budget)).slice(0, 2);
    message = alternatives.length ? `Com esse teto, posso sugerir ${alternatives.map((item) => `${item.name} por ${money(item.priceCents)}`).join(" ou ")}. Qual você prefere?` : "Não encontrei carro disponível dentro desse teto. Quer ajustar o orçamento?";
    speechText = alternatives.length
      ? "Olha as opções que deixei no chat. Se uma delas te interessar, posso te contar mais."
      : "Nesse valor eu fiquei sem uma opção disponível hoje. Se mudar o orçamento, é só me falar.";
  }
  if (!message && !photoCar && intent.trade_in !== null) {
    message = tradeIn ? `Anotei o ${tradeIn} na troca. ${car ? `Quer saber mais sobre o ${car.name}?` : "Qual carro você procura?"}` : "Beleza, sem troca.";
    speechText = tradeIn ? "Já guardei o usado que tu comentou pra equipe poder avaliar depois." : "Fechado, sigo contigo só com a compra do carro.";
  }
  if (!message && intent.car_query === "") {
    message = "Tudo bem! Quer ver outro modelo?";
    speechText = "Se tiver outro carro em mente, me fala que eu olho aqui contigo.";
  }
  const photo = photoCar && (photoCar.imageUrl || photoCar.imageUrls?.length) ? photoCar : null;
  const repeatCar = photoCar ?? (intent.ask_photo ? car : null);
  const photoShared = repeatCar && await hasSharedPhoto(input.roundId, input.conversationId, repeatCar.id);
  const greetingOnly = !message && !photoCar && (intent.social === "greeting" || intent.social === "wellbeing"
    || /^(?:oi|ola|opa|bom dia|boa tarde|boa noite)$/.test(visitTurn.words));
  const introduction = introductionFor(context, greetingOnly);
  const greeting = introduction ? null : naturalGreeting ?? (intent.social === "greeting" ? "Oi!" : null);
  const priorPhotos = repeatCar && intent.ask_photo ? `Você encontra as fotos do ${repeatCar.name} mais acima na conversa.` : "";
  const repeatMessage = socialReply(intent.social, [priorPhotos, message].filter(Boolean).join(" "), greeting);
  const repeatSpeech = speechText ?? (priorPhotos ? "As imagens já tão ali mais pra cima. Se quiser tirar alguma dúvida desse carro, me fala." : undefined);
  let photoMessage = message;
  if (photo && (!message || intent.ask_photo)) {
    photoMessage = `${photosIntro(photo)} ${message || "Quer saber o preço?"}`;
  } else if (photoCar && !photo) {
    photoMessage = `Ainda não temos fotos do ${photoCar.name}. ${message || "Quer saber mais sobre ele?"}`;
    speechText ??= "Ainda não tenho imagem desse carro aqui. Se quiser, posso te contar o que tem na ficha dele.";
  }
  const gallery = photoShared ? null : photo;
  if (gallery && !selectingVisit) {
    const photos = (gallery.imageUrls?.length ?? 0) > 1 ? "nas fotos" : "na foto";
    speechText = budget !== null && gallery.priceCents > budget
      ? `Dá uma olhada ${photos}. Se quiser ficar no teu orçamento, posso te ajudar a comparar outros carros.`
      : `Dá uma olhada ${photos} com calma. Se curtir o carro, é só me dizer que eu te ajudo a combinar uma passada na loja.`;
  } else if (photoShared) {
    speechText = repeatSpeech;
  }
  if (!speechText) {
    if (introduction && greetingOnly) speechText = `Oi, tudo bem? Aqui é a ${VIRTUAL_CONSULTANT_NAME}, a consultora virtual da loja. Quer me contar o que tu tá procurando?`;
    else if (intent.social === "thanks" || intent.social === "goodbye" || intent.social === "acknowledgement") {
      speechText = "Imagina! Quando quiser olhar mais alguma coisa, pode chamar aqui no chat.";
    } else speechText = "Me conta um pouco do que tu procura que eu te ajudo a conferir o estoque.";
  }
  const canonical = introduction && greetingOnly ? "" : photoShared ? repeatMessage : socialReply(intent.social, photoMessage, greeting);
  const text = stockKind || asksSlots ? canonicalReply(canonical, introduction) : await composeReply(key, incoming, canonical, introduction);
  const reply: TurnReply = {
    turnId: input.turnId, transcript, inputKind, ...speechNote(speechText, wantsAudio), ...text, visit, photo: gallery,
  };
  const repeatPhoto = repeatCar && !photoShared
    ? { carId: repeatCar.id, reply: {
      ...(repeatMessage === canonical ? text : canonicalReply(repeatMessage, introduction)),
      ...speechNote(repeatSpeech, wantsAudio),
    } }
    : undefined;
  return saveConversationTurn(input.roundId, input.conversationId, input.turnId, context, reply, { introduction, repeatPhoto });
}

export function hasReplyAudio(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim() && process.env.ELEVENLABS_VOICE_ID?.trim());
}

const pendingAudio = new Map<string, Promise<Buffer | null>>();
const audioError = () => new VoiceError("Não consegui gerar o áudio agora. Tente novamente.", 502);

async function requestReplyAudio(key: string, voiceId: string, text: string): Promise<Buffer> {
  const signal = timeout(20_000);
  let responseStatus: number | undefined;
  try {
    const client = new ElevenLabsClient({
      apiKey: key,
      maxRetries: 0,
      timeoutInSeconds: 20,
      headers: { Accept: "audio/mpeg" },
      fetch: async (input, init) => {
        const response = await fetch(input, { ...init, redirect: "error" });
        responseStatus = response.status;
        return response;
      },
    });
    const { data: stream, rawResponse } = await client.textToSpeech.convert(voiceId, {
      text,
      modelId: "eleven_flash_v2_5",
      languageCode: "pt",
      outputFormat: "mp3_44100_128",
      voiceSettings: { stability: 0.5, similarityBoost: 0.75 },
    }, { abortSignal: signal }).withRawResponse();

    const reader = stream.getReader();
    const cancelRead = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancelRead, { once: true });
    try {
      if (rawResponse.status >= 300 || rawResponse.headers.get("content-type")?.split(";")[0].toLowerCase() !== "audio/mpeg") {
        throw audioError();
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (!value.byteLength) continue;
        bytes += value.byteLength;
        if (bytes > MAX_AUDIO_BYTES) throw audioError();
        chunks.push(value);
      }
      signal.throwIfAborted();
      if (bytes === 0) throw audioError();
      return Buffer.concat(chunks, bytes);
    } finally {
      signal.removeEventListener("abort", cancelRead);
      cancelRead();
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof VoiceError) throw error;
    const status = error instanceof ElevenLabsError ? error.statusCode ?? responseStatus : responseStatus;
    let body = error instanceof ElevenLabsError ? error.body : undefined;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { body = undefined; }
    }
    const code = isRecord(body) && isRecord(body.detail) ? body.detail.status : null;
    if (code === "quota_exceeded" || status === 402) {
      throw new VoiceError("A cota de áudio da demo foi atingida. O texto continua disponível.", 503);
    }
    if (status === 429) throw new VoiceError("A geração de áudio está ocupada. Tente novamente em instantes.", 503);
    if (code === "voice_not_found" || status === 401 || status === 403 || status === 404) {
      throw new VoiceError("A voz da demo está indisponível agora. O texto continua disponível.", 503);
    }
    throw audioError();
  }
}

async function waitForReplyAudio({ roundId, conversationId, turnId }: TurnIdentity): Promise<Buffer | null> {
  const deadline = Date.now() + ELEVENLABS_CLAIM_MS;
  do {
    const turn = await getTurnAudio(roundId, conversationId, turnId);
    if (!turn) return null;
    if (turn.audio) return turn.audio;
    if (!turn.generating) break;
    await delay(500);
  } while (Date.now() < deadline);
  throw audioError();
}

async function generateTurnAudio(scope: TurnIdentity): Promise<Buffer | null> {
  const { roundId, conversationId, turnId } = scope;
  const turn = await getTurnAudio(roundId, conversationId, turnId);
  if (!turn) return null;
  if (turn.audio) return turn.audio;
  if (turn.generating) return waitForReplyAudio(scope);

  const key = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!key || !voiceId) throw new VoiceError("Voz de resposta não configurada.", 503);
  if (turn.attempts >= MAX_ELEVENLABS_ATTEMPTS) {
    throw new VoiceError(`Este áudio atingiu o limite de ${MAX_ELEVENLABS_ATTEMPTS} tentativas. O texto da resposta continua disponível.`, 429);
  }
  if (turn.speech_text.length > MAX_CHAT_MESSAGE_LENGTH) throw new VoiceError("Esta resposta está disponível em texto.", 422);

  const attempt = await claimElevenLabsAttempt(roundId, conversationId, turnId);
  if (attempt === null) return waitForReplyAudio(scope);

  let audio: Buffer | null = null;
  let finished: boolean;
  try {
    audio = await requestReplyAudio(key, voiceId, turn.speech_text);
  } finally {
    finished = await finishElevenLabsAttempt(conversationId, turnId, attempt, audio);
  }
  return finished ? audio : waitForReplyAudio(scope);
}

export async function synthesizeTurnAudio(roundId: string, conversationId: string, turnId: string): Promise<Buffer | null> {
  const id = `${roundId}:${conversationId}:${turnId}`.toLowerCase();
  const pending = pendingAudio.get(id);
  if (pending) return pending;
  const audio = generateTurnAudio({ roundId, conversationId, turnId });
  pendingAudio.set(id, audio);
  try { return await audio; }
  finally { pendingAudio.delete(id); }
}
