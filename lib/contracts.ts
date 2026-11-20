export type CarStatus = "available" | "hidden" | "sold";

export type Car = {
  id: string;
  name: string;
  model?: string | null;
  priceCents: number;
  available: boolean;
  status?: CarStatus;
  imageUrl: string | null;
  imageUrls?: string[];
  color: string | null;
  year: number | null;
};

export type Visit = {
  id: string;
  carId: string;
  carName: string;
  sellerId: string;
  sellerName: string;
  startsAt: string;
  tradeIn: string | null;
  budgetCents: number | null;
  summary: string;
};

export type RoundSnapshot = { cars: Car[]; visits: Visit[] };
export type SellerSlot = { id: string; startsAt: string; sellerId: string; sellerName: string; visitId: string | null };

export type VisitPreference = { date: string | null; time: string | null; text: string | null; exact: boolean };
export type SellerHandoff = {
  conversationId: string;
  sellerId: string;
  sellerName: string;
  carId: string | null;
  carName: string | null;
  tradeIn: string | null;
  budgetCents: number | null;
  preference: VisitPreference | null;
  visitId: string | null;
  reason: string;
  message: string;
  priority: "now" | "follow_up";
  createdAt: string;
};

export type SellerSnapshot = RoundSnapshot & { slots: SellerSlot[]; handoffs: SellerHandoff[] };

export type TurnReply = {
  turnId: string;
  transcript: string;
  message: string;
  bubbles?: string[];
  visit: Visit | null;
  photo: Car | null;
  inputKind?: "text" | "audio";
  speechText?: string;
  wantsAudio?: true;
  sellerName?: string;
  humanHandoff?: true;
};

export type ChatMessage = {
  id: string;
  role: "user";
  text: string;
  createdAt: string;
  source: "text" | "audio";
} | {
  id: string;
  role: "assistant";
  reply: TurnReply;
  createdAt: string;
};

export type ConversationHistory = {
  messages: ChatMessage[];
  pending: boolean;
  retryAfterMs: number;
  canListen: boolean;
  humanHandoff?: boolean;
};

export const CHAT_IDLE_MS = 8_000;
export const VIRTUAL_CONSULTANT_NAME = "Júlia";
export const MAX_CHAT_BATCH_MESSAGES = 32;
export const MAX_CHAT_MESSAGE_LENGTH = 1_800;

// PostgreSQL INTEGER upper bound, in cents.
export const MAX_PRICE_CENTS = 2_147_483_647;
