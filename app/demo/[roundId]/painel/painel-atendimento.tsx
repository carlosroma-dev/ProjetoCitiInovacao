import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_CHAT_MESSAGE_LENGTH, VIRTUAL_CONSULTANT_NAME, type ChatMessage, type ConversationHistory, type SellerHandoff, type Visit } from "../../../../lib/contracts";
import { dateKey, dateLabel, money, responseError, timeLabel } from "./painel-data";
import { Empty, ErrorNotice, Icon, Loading } from "./painel-ui";
import styles from "./painel.module.css";

function priorityLabel(priority: SellerHandoff["priority"]) {
  return priority === "now" ? "Quer falar agora" : "Contato de rotina";
}

function contactPreference(preference: SellerHandoff["preference"]) {
  if (!preference) return "Não informada";
  const date = preference.date ? dateLabel(preference.date) : null;
  const when = date && preference.time ? `${date} às ${preference.time}` : date ?? preference.time;
  return [when, preference.text].filter(Boolean).join(" · ") || "Não informada";
}

function ContactDetails({ handoff, visit }: { handoff: SellerHandoff; visit: Visit | undefined }) {
  return (
    <dl className={styles.contactDetails}>
      <div><dt>Vendedor</dt><dd>{handoff.sellerName}</dd></div>
      <div><dt>Veículo de interesse</dt><dd>{handoff.carName || "Não informado"}</dd></div>
      <div><dt>Veículo na troca</dt><dd>{handoff.tradeIn || "Não informado"}</dd></div>
      {handoff.budgetCents != null ? <div><dt>Orçamento informado</dt><dd>{money(handoff.budgetCents)}</dd></div> : null}
      <div><dt>Preferência de dia e hora</dt><dd>{contactPreference(handoff.preference)}</dd></div>
      <div>
        <dt>Visita confirmada</dt>
        <dd>{visit ? (
          <><time dateTime={visit.startsAt}>{dateLabel(dateKey(visit.startsAt))} às {timeLabel(visit.startsAt)}</time>
          {visit.sellerName && visit.sellerName !== handoff.sellerName ? <span> com {visit.sellerName}</span> : null}</>
        ) : "Sem reserva confirmada"}</dd>
      </div>
      <div className={styles.contactNotes}>
        <dt>Observações</dt>
        <dd>{handoff.reason || handoff.message || "Nenhuma observação registrada"}
          {handoff.reason && handoff.message && handoff.message !== handoff.reason ? <p>{handoff.message}</p> : null}
        </dd>
      </div>
    </dl>
  );
}

function ContactMessages({ messages }: { messages: ChatMessage[] }) {
  if (!messages.length) return <p className={styles.noContactMessages}>Nenhuma mensagem nesta conversa.</p>;
  return (
    <ol className={styles.contactMessages} aria-label="Histórico da conversa" aria-live="polite">
      {messages.map((message) => {
        const reply = message.role === "assistant" ? message.reply : null;
        const author = message.role === "user" ? "Cliente" : reply?.sellerName || `${VIRTUAL_CONSULTANT_NAME} · consultora virtual`;
        return (
          <li key={message.id} className={styles.contactMessage}
            data-author={message.role === "user" ? "customer" : reply?.sellerName ? "seller" : "virtual"}>
            <div>
              <strong>{author}</strong>
              <time dateTime={message.createdAt}>{dateLabel(dateKey(message.createdAt), true)} · {timeLabel(message.createdAt)}</time>
            </div>
            {message.role === "user" ? <p>{message.source === "audio" ? <small>Transcrição do áudio</small> : null}{message.text}</p>
              : (message.reply.bubbles?.length ? message.reply.bubbles : [message.reply.message]).map((bubble, index) =>
                <p key={index}>{bubble}</p>)}
          </li>
        );
      })}
    </ol>
  );
}

function Conversation({ handoff, visit, messagesUrl, requestSignIn, dismiss, close }: {
  handoff: SellerHandoff;
  visit: Visit | undefined;
  messagesUrl: string;
  requestSignIn: () => void;
  dismiss: (message: string) => void;
  close: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const activeLoad = useRef<AbortController | null>(null);
  const activeSend = useRef<AbortController | null>(null);
  const previousAttempt = useRef<{ id: string; text: string } | null>(null);
  const transcript = useRef<HTMLDivElement>(null);

  const readMessages = useCallback(async (response: Response, fallback: string, signal: AbortSignal) => {
    if (signal.aborted) return null;
    if (response.status === 401 || response.status === 403) {
      requestSignIn();
      return null;
    }
    if (response.status === 404) {
      dismiss("Esta conversa não está mais disponível nesta rodada.");
      return null;
    }
    if (!response.ok) throw new Error(await responseError(response, fallback));
    return (await response.json() as ConversationHistory).messages;
  }, [dismiss, requestSignIn]);

  const loadMessages = useCallback(async () => {
    if (activeLoad.current || activeSend.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    activeLoad.current = controller;
    const fallback = "Não foi possível carregar a conversa.";
    try {
      const response = await fetch(messagesUrl, { cache: "no-store", signal });
      const next = await readMessages(response, fallback, signal);
      if (signal.aborted || !next) return;
      setMessages(next);
      setError("");
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof TypeError || !(cause instanceof Error) ? fallback : cause.message);
    } finally {
      if (activeLoad.current === controller) activeLoad.current = null;
    }
  }, [messagesUrl, readMessages]);

  useEffect(() => {
    heading.current?.focus();
    void loadMessages();
    const refresh = () => {
      if (document.visibilityState === "visible") void loadMessages();
    };
    const timer = window.setInterval(refresh, 4_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      activeLoad.current?.abort();
      activeLoad.current = null;
      activeSend.current?.abort();
      activeSend.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadMessages]);

  const lastMessageId = messages?.at(-1)?.id;
  useEffect(() => {
    const body = transcript.current;
    if (body && lastMessageId) body.scrollTop = body.scrollHeight;
  }, [lastMessageId]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !messages || activeSend.current) return;
    const message = previousAttempt.current?.text === text ? previousAttempt.current : { id: crypto.randomUUID(), text };
    previousAttempt.current = message;
    const controller = new AbortController();
    const { signal } = controller;
    activeSend.current = controller;
    activeLoad.current?.abort();
    activeLoad.current = null;
    setSending(true);
    setSendError("");
    const fallback = "Não foi possível enviar a resposta. Tente novamente.";
    try {
      const response = await fetch(messagesUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
        signal,
      });
      const next = await readMessages(response, fallback, signal);
      if (signal.aborted || !next) return;
      setMessages(next);
      setDraft("");
      setError("");
      previousAttempt.current = null;
    } catch (cause) {
      if (!signal.aborted) setSendError(cause instanceof TypeError || !(cause instanceof Error) ? fallback : cause.message);
    } finally {
      if (activeSend.current === controller) activeSend.current = null;
      if (!signal.aborted) setSending(false);
    }
  }

  return (
    <section className={styles.surface} aria-labelledby="contact-heading">
      <header className={styles.surfaceHeading}>
        <div>
          <h2 id="contact-heading" className={styles.contactHeading} tabIndex={-1}>{handoff.carName || "Conversa com cliente"}</h2>
          <p>{priorityLabel(handoff.priority)}</p>
        </div>
        <button type="button" className={styles.iconButton} onClick={close} aria-label="Fechar conversa" title="Fechar conversa"><Icon name="close" /></button>
      </header>
      <ContactDetails handoff={handoff} visit={visit} />
      <div className={styles.contactThread}>
        <h3>Conversa</h3>
        {error ? <ErrorNotice message={error} retry={() => void loadMessages()} /> : null}
        {!messages && !error ? <Loading label="Carregando conversa…" /> : null}
        {messages ? <div className={styles.contactTranscript} ref={transcript}><ContactMessages messages={messages} /></div> : null}
        <form className={styles.contactComposer} onSubmit={(event) => void sendMessage(event)}>
          <label htmlFor="seller-message">Responder como {handoff.sellerName}</label>
          <textarea id="seller-message" className={styles.control} rows={3} maxLength={MAX_CHAT_MESSAGE_LENGTH}
            value={draft} disabled={!messages} readOnly={sending}
            onChange={(event) => { setDraft(event.target.value); setSendError(""); }} />
          {sendError ? <ErrorNotice message={sendError} /> : null}
          <button type="submit" className={styles.primaryButton} disabled={!messages || sending || !draft.trim()}>
            {sending ? "Enviando…" : "Enviar resposta"}
          </button>
        </form>
      </div>
    </section>
  );
}

export function Atendimento({ handoffs, visits, endpoint, requestSignIn, refresh }: {
  handoffs: SellerHandoff[];
  visits: Visit[];
  endpoint: string;
  requestSignIn: () => void;
  refresh: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const list = useRef<HTMLElement>(null);
  const selected = handoffs.find(({ conversationId }) => conversationId === selectedId);
  const sorted = [...handoffs].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority === "now" ? -1 : 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  const close = useCallback(() => {
    setSelectedId(null);
    list.current?.focus();
  }, []);

  const dismiss = useCallback((message: string) => {
    setNotice(message);
    close();
    refresh();
  }, [close, refresh]);

  useEffect(() => {
    if (selectedId && !selected) {
      setNotice("Esta conversa não está mais disponível nesta rodada.");
      close();
    }
  }, [close, selected, selectedId]);

  return (
    <div className={styles.contactLayout}>
      <section className={styles.surface} aria-labelledby="contacts-heading" ref={list} tabIndex={-1}>
        <div className={styles.surfaceHeading}>
          <h2 id="contacts-heading">Encaminhamentos</h2>
        </div>
        {notice ? <div className={styles.contactNotice}><ErrorNotice message={notice} /></div> : null}
        {sorted.length ? (
          <ul className={styles.contactList}>
            {sorted.map((handoff) => (
              <li key={handoff.conversationId}>
                <button type="button" className={styles.contactItem}
                  aria-pressed={selectedId === handoff.conversationId}
                  onClick={() => { setSelectedId(handoff.conversationId); setNotice(""); }}>
                  <span className={`${styles.stateTag} ${styles.contactPriority}`} data-priority={handoff.priority}>
                    {priorityLabel(handoff.priority)}
                  </span>
                  <Icon name="right" />
                  <strong>{handoff.carName || "Veículo a definir"}</strong>
                  <span>{handoff.sellerName} · <time dateTime={handoff.createdAt}>{dateLabel(dateKey(handoff.createdAt), true)}, {timeLabel(handoff.createdAt)}</time></span>
                </button>
              </li>
            ))}
          </ul>
        ) : <Empty icon="chat" title="Nenhum encaminhamento">Os pedidos de atendimento humano do chat aparecem aqui.</Empty>}
      </section>
      {selected ? <Conversation key={selected.conversationId} handoff={selected}
        visit={visits.find(({ id }) => id === selected.visitId)}
        messagesUrl={`${endpoint}/handoffs/${encodeURIComponent(selected.conversationId)}/messages`}
        requestSignIn={requestSignIn} dismiss={dismiss} close={close} /> : sorted.length ? (
        <section className={styles.surface} aria-label="Conversa">
          <Empty icon="chat" title="Selecione um encaminhamento">Abra uma conversa para consultar o contexto e responder pelo chat.</Empty>
        </section>
      ) : null}
    </div>
  );
}
