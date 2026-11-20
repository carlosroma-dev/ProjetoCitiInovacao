import { useCallback, useEffect, useRef, useState } from "react";
import { CHAT_IDLE_MS, type ChatMessage, type ConversationHistory, type TurnReply } from "../../../lib/contracts";

type OutgoingText = Extract<ChatMessage, { role: "user" }> & { source: "text" };
type History = ConversationHistory & { replyAfter: number };

class ChatRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function chatError(payload: unknown, fallback: string) {
  return payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
    ? payload.error : fallback;
}

async function readJson<T>(url: string, options: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options }).catch(() => {
    throw new ChatRequestError(fallback, 0);
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new ChatRequestError(chatError(payload, fallback), response.status);
  return payload as T;
}

function readLocal(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* The conversation can still work in browsers with storage disabled. */ }
}

function outboxKey(conversationId: string) { return `patio-voz:outbox:${conversationId}:`; }
function activityKey(conversationId: string) { return `patio-voz:activity:${conversationId}`; }

function restoreOutbox(conversationId: string, messages: ChatMessage[]) {
  const saved = new Set(messages.map(({ id }) => id));
  const prefix = outboxKey(conversationId);
  const outgoing: OutgoingText[] = [];
  const acknowledged: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (saved.has(id)) {
        acknowledged.push(key);
        continue;
      }
      const value = readLocal(key);
      if (!value) continue;
      try {
        const message = JSON.parse(value) as OutgoingText;
        if (message?.id === id && message.role === "user" && message.source === "text"
          && typeof message.text === "string" && Number.isFinite(Date.parse(message.createdAt))) outgoing.push(message);
      } catch { /* Ignore an unreadable local entry and restore the other messages. */ }
    }
  } catch { /* Storage may be unavailable. */ }
  acknowledged.forEach((key) => writeLocal(key, null));
  return outgoing.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function activityDeadline(conversationId: string) {
  const stored = Number(readLocal(activityKey(conversationId)));
  return stored <= Date.now() + CHAT_IDLE_MS ? stored : 0;
}

function withDeadline(snapshot: ConversationHistory): History {
  return { ...snapshot, replyAfter: snapshot.humanHandoff ? 0 : Date.now() + snapshot.retryAfterMs };
}

function mergeHistory(current: History, incoming: History): History {
  // A slower response can arrive after another request reports the handoff.
  if (current.humanHandoff || incoming.humanHandoff) {
    incoming = { ...incoming, humanHandoff: true, pending: false, retryAfterMs: 0, replyAfter: 0 };
  }
  const incomingIds = new Set(incoming.messages.map(({ id }) => id));
  if (current.messages.every(({ id }) => incomingIds.has(id))) return incoming;
  const knownIds = new Set(current.messages.map(({ id }) => id));
  const additions = incoming.messages.filter(({ id }) => !knownIds.has(id));
  if (!additions.length && current.humanHandoff === incoming.humanHandoff) return current;
  return {
    ...current,
    canListen: incoming.canListen,
    humanHandoff: incoming.humanHandoff,
    messages: [...current.messages, ...additions].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    pending: !incoming.humanHandoff && (current.pending || incoming.pending),
    replyAfter: incoming.humanHandoff ? 0 : Math.max(current.replyAfter, incoming.replyAfter),
  };
}

export function useChatHistory(roundId: string) {
  const roundUrl = `/api/demo/${encodeURIComponent(roundId)}`;
  const conversationKey = `patio-voz:conversation:${roundId}`;
  const lifetime = useRef<AbortController | null>(null);
  const opening = useRef(false);
  const lastActivity = useRef(0);
  const [conversationId, setConversationId] = useState("");
  const [history, setHistory] = useState<History | null>(null);
  const [outbox, setOutbox] = useState<OutgoingText[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [replyError, setReplyError] = useState("");
  const [replying, setReplying] = useState(false);
  const [activityUntil, setActivityUntil] = useState(0);
  const conversationUrl = `${roundUrl}/conversations/${encodeURIComponent(conversationId)}`;
  const messagesUrl = `${conversationUrl}/messages`;
  const humanHandoff = history?.humanHandoff === true;
  const pending = (!humanHandoff && history?.pending === true) || outbox.length > 0;
  const replyAfter = history?.replyAfter ?? 0;

  const applyHistory = useCallback((snapshot: ConversationHistory) => {
    const incoming = withDeadline(snapshot);
    setHistory((current) => current ? mergeHistory(current, incoming) : incoming);
  }, []);

  const openConversation = useCallback(async (fresh = false) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || opening.current) return;
    opening.current = true;
    setLoading(true);
    setLoadError("");
    try {
      let id = fresh ? null : readLocal(conversationKey);
      let snapshot: ConversationHistory | null = null;
      if (id) {
        try {
          snapshot = await readJson<ConversationHistory>(`${roundUrl}/conversations/${encodeURIComponent(id)}/messages`, { signal }, "Não foi possível carregar o histórico da conversa.");
        } catch (cause) {
          if (!(cause instanceof ChatRequestError) || cause.status !== 404) throw cause;
          id = null;
        }
      }
      if (!id || !snapshot) {
        const created = await readJson<{ conversationId: string; canListen: boolean }>(`${roundUrl}/conversations`, { method: "POST", signal }, "Não foi possível abrir uma conversa.");
        if (typeof created.conversationId !== "string" || !created.conversationId) throw new Error("Não foi possível abrir uma conversa.");
        id = created.conversationId;
        snapshot = { messages: [], pending: false, retryAfterMs: 0, canListen: created.canListen === true };
      }
      if (signal.aborted) return;

      writeLocal(conversationKey, id);
      lastActivity.current = activityDeadline(id);
      setActivityUntil(lastActivity.current);
      setOutbox(restoreOutbox(id, snapshot.messages));
      setHistory(withDeadline(snapshot));
      setSaveError("");
      setReplyError("");
      setConversationId(id);
    } catch (cause) {
      if (!signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Não foi possível abrir a conversa.");
    } finally {
      opening.current = false;
      if (!signal.aborted) setLoading(false);
    }
  }, [conversationKey, roundUrl]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    queueMicrotask(() => {
      if (!controller.signal.aborted) void openConversation();
    });
    return () => controller.abort();
  }, [openConversation]);

  const refreshHistory = useCallback(async (signal: AbortSignal) => {
    const snapshot = await readJson<ConversationHistory>(messagesUrl, { signal }, "Não foi possível atualizar a conversa.");
    if (!signal.aborted) applyHistory(snapshot);
    return snapshot;
  }, [applyHistory, messagesUrl]);

  useEffect(() => {
    if (!conversationId || loading) return;
    const controller = new AbortController();
    const { signal } = controller;
    let refreshing = false;
    async function refresh() {
      if (signal.aborted || refreshing || document.visibilityState !== "visible") return;
      refreshing = true;
      try {
        await refreshHistory(signal);
      } catch (cause) {
        if (!signal.aborted && cause instanceof ChatRequestError && cause.status === 404) {
          void openConversation();
        }
      } finally {
        refreshing = false;
      }
    }
    if (humanHandoff) void refresh();
    const timer = window.setInterval(() => void refresh(), humanHandoff ? 3_000 : 12_000);
    const onVisibility = () => void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [conversationId, humanHandoff, loading, openConversation, refreshHistory]);

  useEffect(() => {
    if (!conversationId) return;
    function syncActivity(event: StorageEvent) {
      if (event.key !== activityKey(conversationId)) return;
      const until = activityDeadline(conversationId);
      if (until <= lastActivity.current) return;
      lastActivity.current = until;
      setActivityUntil(until);
    }
    window.addEventListener("storage", syncActivity);
    return () => window.removeEventListener("storage", syncActivity);
  }, [conversationId]);

  function noteActivity() {
    if (humanHandoff) return;
    const until = Date.now() + CHAT_IDLE_MS;
    lastActivity.current = until;
    setActivityUntil(until);
    writeLocal(activityKey(conversationId), String(until));
  }

  function sendText(text: string) {
    if (!conversationId || loading || opening.current) return false;
    const message: OutgoingText = { id: crypto.randomUUID(), role: "user", source: "text", text, createdAt: new Date().toISOString() };
    writeLocal(`${outboxKey(conversationId)}${message.id}`, JSON.stringify(message));
    noteActivity();
    setOutbox((current) => [...current, message]);
    return true;
  }

  const nextMessage = outbox[0];
  useEffect(() => {
    const signal = lifetime.current?.signal;
    if (!signal || !nextMessage || saveError || loading) return;
    const { id, text } = nextMessage;
    void readJson<ConversationHistory>(messagesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text }),
      keepalive: true,
      signal,
    }, "Não foi possível salvar a mensagem.").then((snapshot) => {
      if (signal.aborted) return;
      applyHistory(snapshot);
      writeLocal(`${outboxKey(conversationId)}${id}`, null);
      setOutbox((current) => current.filter((message) => message.id !== id));
    }).catch((cause) => {
      if (!signal.aborted) setSaveError(cause instanceof Error ? cause.message : "Não foi possível salvar a mensagem.");
    });
  }, [nextMessage, saveError, loading, messagesUrl, conversationId, applyHistory]);

  useEffect(() => {
    const signal = lifetime.current?.signal;
    if (!signal || humanHandoff || !pending || nextMessage || replying || replyError || loading) return;
    let timer: ReturnType<typeof setTimeout>;
    function requestReply() {
      if (signal?.aborted) return;
      const wait = Math.max(lastActivity.current, activityDeadline(conversationId), replyAfter) - Date.now();
      if (wait > 0) {
        timer = setTimeout(requestReply, wait);
        return;
      }
      setReplying(true);
      void readJson<ConversationHistory>(`${messagesUrl}/reply`, { method: "POST", signal }, "Não foi possível obter a resposta.")
        .then((snapshot) => {
          if (signal?.aborted) return;
          applyHistory({ ...snapshot, retryAfterMs: snapshot.pending ? Math.max(500, snapshot.retryAfterMs) : 0 });
        }).catch((cause) => {
          if (!signal?.aborted) setReplyError(cause instanceof Error ? cause.message : "Não foi possível obter a resposta.");
        }).finally(() => {
          if (!signal?.aborted) setReplying(false);
        });
    }
    timer = setTimeout(requestReply, Math.max(0, Math.max(activityUntil, replyAfter) - Date.now()));
    return () => clearTimeout(timer);
  }, [activityUntil, applyHistory, conversationId, humanHandoff, loading, messagesUrl, nextMessage, pending, replying, replyAfter, replyError]);

  function appendAudioTurn(reply: TurnReply) {
    const createdAt = new Date().toISOString();
    const user: ChatMessage = { role: "user", source: "audio", id: `user:${reply.turnId}`, text: reply.transcript, createdAt };
    const assistant: ChatMessage = { role: "assistant", id: reply.turnId, reply, createdAt };
    setHistory((current) => {
      if (!current) return current;
      const messages = current.messages.some(({ id }) => id === assistant.id)
        ? current.messages : [...current.messages, user, assistant];
      return reply.humanHandoff
        ? { ...current, messages, humanHandoff: true, pending: false, retryAfterMs: 0, replyAfter: 0 }
        : { ...current, messages };
    });
  }

  const savedMessages = history?.messages ?? [];
  const savedIds = new Set(savedMessages.map(({ id }) => id));
  const unsaved = outbox.filter(({ id }) => !savedIds.has(id));

  return {
    conversationId,
    conversationUrl,
    canListen: history?.canListen ?? false,
    humanHandoff,
    messages: [...savedMessages, ...unsaved],
    unsavedIds: new Set(unsaved.map(({ id }) => id)),
    loading,
    loadError,
    saveError,
    replyError: humanHandoff ? "" : replyError,
    pending,
    replying: !humanHandoff && replying,
    openConversation,
    refreshHistory,
    noteActivity,
    sendText,
    appendAudioTurn,
    retrySave: () => setSaveError(""),
    retryReply: () => setReplyError(""),
  };
}
