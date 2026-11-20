"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CHAT_MESSAGE_LENGTH, VIRTUAL_CONSULTANT_NAME, type Car, type TurnReply } from "../../../lib/contracts";
import { carImageCredit } from "../../../lib/car-images";
import { chatError, useChatHistory } from "./use-chat-history";
import styles from "./voice-chat.module.css";

type Phase = "ready" | "permission" | "recording" | "review" | "uploading" | "error";
type ReplyAudio =
  | { status: "loading" }
  | { status: "ready"; url: string; autoplay: boolean }
  | { status: "error"; message: string };

const messageTime = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

function stamp(value: string) {
  const formatted = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  return formatted.charAt(0).toLocaleUpperCase("pt-BR") + formatted.slice(1);
}
function photoUrls(car: Car) { return (car.imageUrls?.length ? car.imageUrls : car.imageUrl ? [car.imageUrl] : []).slice(0, 3); }
function carDescription(car: Car) { return [car.name, car.color, car.year].filter(Boolean).join(", "); }

function ReplyPhotos({ car }: { car: Car }) {
  const photos = photoUrls(car);
  if (!photos.length) return null;
  const credits = photos.map((url) => carImageCredit(car, url)).filter((credit) => credit !== null);
  return <div className={styles.replyPhoto} role="group" aria-label={`Fotos de ${car.name}`}>
    <div className={styles.gallery} data-count={photos.length}>
      {photos.map((url, index) => <a href={url} key={url} target="_blank" rel="noreferrer">
        <Image src={url} alt={`${carDescription(car)}${photos.length > 1 ? ` · foto ${index + 1}` : ""}`} width={420} height={260} unoptimized />
      </a>)}
    </div>
    {credits.length > 0 ? <details className={styles.photoCredits}>
      <summary>{credits.length === 1 ? "Créditos da foto" : "Créditos das fotos"}</summary>
      {credits.map((credit) => <small key={credit.href}>
        <a href={credit.href} target="_blank" rel="noreferrer">{credit.source}</a> · <a href={credit.licenseHref} target="_blank" rel="noreferrer">{credit.license}</a>
      </small>)}
    </details> : null}
  </div>;
}

export default function VoiceChat({ roundId }: { roundId: string }) {
  const chat = useChatHistory(roundId);
  const { conversationId, messages, pending, replying, loading, canListen, humanHandoff } = chat;
  const sellerMessage = messages.findLast((message) => message.role === "assistant" && message.reply.sellerName);
  const sellerName = sellerMessage?.role === "assistant" ? sellerMessage.reply.sellerName : undefined;
  const [phase, setPhase] = useState<Phase>("ready");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [recordings, setRecordings] = useState<Record<string, string>>({});
  const [replyAudio, setReplyAudio] = useState<Record<string, ReplyAudio>>({});
  const [clip, setClip] = useState<Blob | null>(null);
  const [clipUrl, setClipUrl] = useState("");
  const [clipType, setClipType] = useState("audio/webm");
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const partsRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);
  const pendingTurnId = useRef("");
  const sending = useRef(false);
  const audioRequests = useRef(new Map<string, AbortController>()).current;
  const seenReplies = useRef({ conversationId: "", ids: new Set<string>() });
  const latestClipUrl = useRef("");
  const audioUrlsRef = useRef(new Set<string>());
  const audioUrls = audioUrlsRef.current;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const permissionPending = useRef(false);
  const captureRequest = useRef(0);
  const activeRef = useRef(true);
  const requestsRef = useRef(new Set<AbortController>());
  const requests = requestsRef.current;
  const turnsUrl = `${chat.conversationUrl}/turns`;
  const panelUrl = `/demo/${encodeURIComponent(roundId)}/painel`;

  useEffect(() => { activeRef.current = true; return () => {
    activeRef.current = false;
    captureRequest.current += 1;
    permissionPending.current = false;
    queueMicrotask(() => {
      if (activeRef.current) return;
      requests.forEach((request) => request.abort());
      requests.clear();
      audioRequests.clear();
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (latestClipUrl.current) { URL.revokeObjectURL(latestClipUrl.current); latestClipUrl.current = ""; }
      audioUrls.forEach((url) => URL.revokeObjectURL(url));
      audioUrls.clear();
    });
  }; }, [requests, audioRequests, audioUrls]);
  useEffect(() => {
    setDraft("");
    setError("");
    setPhase("ready");
    setRecordings({});
    setReplyAudio({});
    return () => {
      requests.forEach((request) => request.abort());
      requests.clear();
      audioRequests.clear();
      audioUrls.forEach((url) => URL.revokeObjectURL(url));
      audioUrls.clear();
    };
  }, [conversationId, requests, audioRequests, audioUrls]);
  const status = phase === "uploading" ? "Enviando áudio…" : replying && !humanHandoff ? "A atendente está respondendo…"
    : pending && !chat.saveError && !chat.replyError && !chat.unsavedIds.size ? "Aguardando uma pausa na digitação…" : "";
  useEffect(() => {
    const body = bodyRef.current;
    if (body && (messages.length || status)) body.scrollTop = body.scrollHeight;
  }, [messages.length, status]);
  const endStream = () => { streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null; recorderRef.current = null; if (timerRef.current) clearInterval(timerRef.current); timerRef.current = null; };
  const beginRecording = async () => {
    if (humanHandoff || pending || loading || sending.current || permissionPending.current || recorderRef.current?.state === "recording" || !activeRef.current) return;
    permissionPending.current = true;
    const requestId = ++captureRequest.current;
    setPhase("permission");
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { permissionPending.current = false; setError("Este navegador não oferece gravação de áudio. Abra a demonstração no Safari ou Chrome atual."); setPhase("error"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!activeRef.current || requestId !== captureRequest.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((mime) => MediaRecorder.isTypeSupported(mime));
      if (!options) { endStream(); setError("O formato de gravação deste navegador não é compatível."); setPhase("error"); return; }
      setClipType(options); partsRef.current = []; elapsedRef.current = 0; setSeconds(0);
      const recorder = new MediaRecorder(stream, { mimeType: options }); recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) partsRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(partsRef.current, { type: options });
        endStream();
        if (!activeRef.current || requestId !== captureRequest.current) return;
        if (blob.size > 3 * 1024 * 1024) { setClip(null); setError("O áudio passou de 3 MB. Grave um trecho mais curto e tente novamente."); setPhase("error"); return; }
        if (blob.size < 1000) { setClip(null); setError("O áudio ficou muito curto. Grave novamente por alguns segundos."); setPhase("error"); return; }
        const url = URL.createObjectURL(blob); latestClipUrl.current = url; setClip(blob); setClipUrl(url); pendingTurnId.current = crypto.randomUUID(); setPhase("review");
      };
      recorder.start(250); setPhase("recording");
      timerRef.current = setInterval(() => { elapsedRef.current += 1; setSeconds(elapsedRef.current); if (elapsedRef.current >= 30) recorderRef.current?.stop(); }, 1000);
    } catch (cause) {
      endStream();
      if (!activeRef.current || requestId !== captureRequest.current) return;
      const denied = cause instanceof DOMException && (cause.name === "NotAllowedError" || cause.name === "PermissionDeniedError");
      setError(denied ? "O microfone está bloqueado. Permita o acesso nas configurações do navegador e tente novamente." : "Não foi possível acessar o microfone. Confira as permissões e tente novamente."); setPhase("error");
    } finally {
      if (requestId === captureRequest.current) permissionPending.current = false;
    }
  };
  const stopRecording = () => { if (recorderRef.current?.state === "recording") { setPhase("review"); recorderRef.current.stop(); } };
  const discardClip = () => { if (clipUrl) URL.revokeObjectURL(clipUrl); latestClipUrl.current = ""; setClip(null); setClipUrl(""); pendingTurnId.current = ""; setError(""); setPhase("ready"); };

  const getReplyAudio = useCallback(async (id: string, playAudio = false) => {
    if (audioRequests.has(id)) return;
    const controller = new AbortController();
    audioRequests.set(id, controller);
    requests.add(controller);
    setReplyAudio((current) => ({ ...current, [id]: { status: "loading" } }));
    try {
      const response = await fetch(`${turnsUrl}/${encodeURIComponent(id)}/audio`, { method: "POST", signal: controller.signal });
      if (!response.ok) throw new Error("Falha ao solicitar o áudio.");
      const blob = await response.blob();
      if (!blob.size) throw new Error("O áudio chegou vazio.");
      if (!activeRef.current || controller.signal.aborted) return;
      const audioUrl = URL.createObjectURL(blob);
      audioUrls.add(audioUrl);
      setReplyAudio((current) => ({ ...current, [id]: { status: "ready", url: audioUrl, autoplay: playAudio } }));
    } catch {
      if (!activeRef.current || controller.signal.aborted) return;
      setReplyAudio((current) => ({ ...current, [id]: { status: "error", message: "Não foi possível preparar o áudio agora." } }));
    } finally {
      requests.delete(controller);
      if (audioRequests.get(id) === controller) audioRequests.delete(id);
    }
  }, [audioRequests, audioUrls, requests, turnsUrl]);

  useEffect(() => {
    if (!conversationId || loading) return;
    const restoringHistory = seenReplies.current.conversationId !== conversationId;
    if (restoringHistory) seenReplies.current = { conversationId, ids: new Set() };
    const { ids } = seenReplies.current;
    const latest = messages.findLast((message) => message.role === "assistant");
    if (!restoringHistory && canListen && latest?.reply.wantsAudio && latest.reply.speechText && !latest.reply.sellerName && !ids.has(latest.id)) {
      void getReplyAudio(latest.reply.turnId);
    }
    for (const message of messages) if (message.role === "assistant") ids.add(message.id);
  }, [canListen, conversationId, getReplyAudio, loading, messages]);

  const onReplyAudioError = (id: string, url: string) => {
    if (!audioUrls.delete(url)) return;
    URL.revokeObjectURL(url);
    setReplyAudio((current) => ({ ...current, [id]: { status: "error", message: "Não foi possível reproduzir o áudio." } }));
  };

  const sendClip = async () => {
    const id = pendingTurnId.current;
    if (!clip || !id || !conversationId || humanHandoff || sending.current) return;
    sending.current = true;
    setError("");
    setPhase("uploading");
    const controller = new AbortController();
    requests.add(controller);
    try {
      const body = new FormData();
      body.append("audio", clip, clipType.includes("mp4") ? "voice-note.mp4" : "voice-note.webm");
      body.append("turnId", id);
      const response = await fetch(turnsUrl, { method: "POST", body, signal: controller.signal });
      const payload = await response.json();
      if (response.status === 409) {
        const latest = await chat.refreshHistory(controller.signal).catch(() => null);
        if (!activeRef.current || controller.signal.aborted) return;
        if (latest?.humanHandoff) {
          discardClip();
          setError(chatError(payload, "Continue o atendimento por mensagem de texto."));
          return;
        }
      }
      if (!response.ok) throw new Error(chatError(payload, "Não foi possível enviar o áudio."));
      const reply = payload as TurnReply;
      if (!activeRef.current || controller.signal.aborted) return;
      audioUrls.add(clipUrl);
      setRecordings((current) => ({ ...current, [`user:${reply.turnId}`]: clipUrl }));
      chat.appendAudioTurn(reply);
      setPhase("ready");
      setClip(null);
      setClipUrl("");
      latestClipUrl.current = "";
      pendingTurnId.current = "";
    } catch (cause) {
      if (activeRef.current && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Não foi possível enviar o áudio.");
        setPhase("review");
      }
    } finally {
      sending.current = false;
      requests.delete(controller);
    }
  };

  const sendDraft = () => {
    const text = draft.trim();
    if (!text || (phase !== "ready" && phase !== "error")) return;
    if (chat.sendText(text)) {
      setDraft("");
      setError("");
    }
  };

  const showTextComposer = phase === "ready" || phase === "error";
  const inlineError = error || chat.loadError || chat.saveError || chat.replyError;
  const retry = chat.saveError ? chat.retrySave : chat.replyError ? chat.retryReply : null;
  const recordingHint = humanHandoff ? "Atendimento com vendedor por texto" : pending ? "Aguarde a resposta para gravar áudio" : "Gravar áudio";
  const shownPhotos = new Set<string>();
  const shownVisits = new Set<string>();

  return <main className={styles.chatPage}>
    <header className={styles.header}><Link className={styles.brand} href="/" aria-label="Pátio Voz, apresentação">Pátio<span>Voz</span></Link><span className={styles.headerTag}>DEMO · SEM CADASTRO</span></header>
    {loading && !conversationId ? <section className={styles.loadState} role="status"><span className={styles.spinner} />Abrindo sua conversa…</section> : null}
    {chat.loadError && !conversationId ? <section className={styles.errorPanel} role="alert"><p className={styles.eyebrow}>Pátio Voz · demonstração</p><h1>Não foi possível abrir a conversa.</h1><p>{chat.loadError}</p><button className={styles.primaryButton} onClick={() => void chat.openConversation()}>Tentar novamente</button><Link href="/">Voltar à apresentação</Link></section> : null}
    {conversationId ? <div className={styles.layout}>
      <section className={styles.chatCard} aria-label="Conversa de atendimento">
        <div className={styles.chatHeader}>
          <span className={styles.avatar} aria-hidden="true">PV</span>
          <div><strong>Atendimento Pátio Voz</strong><span aria-live="polite">
            {humanHandoff ? sellerName ? `${sellerName} · equipe de vendas` : "Atendimento com vendedor · por texto" : `${VIRTUAL_CONSULTANT_NAME} · consultora virtual`}
          </span></div>
          <Link className={styles.panelLink} href={panelUrl} aria-label="Abrir painel da revenda">Painel <span aria-hidden="true">↗</span></Link>
        </div>
        <div className={styles.chatBody} role="log" aria-label="Mensagens da conversa" ref={bodyRef}>
          <div className={styles.messages}>{messages.map((message) => {
            if (message.role === "user") {
              const recording = recordings[message.id];
              const unsaved = chat.unsavedIds.has(message.id);
              return <article className={styles.userBubble} key={message.id} aria-label="Você">
                {recording ? <audio controls preload="none" src={recording} aria-label="Seu áudio enviado" /> : null}
                {message.source === "audio" ? <p className={styles.transcript}><span>TRANSCRIÇÃO</span>{message.text}</p> : <p>{message.text}</p>}
                {unsaved ? <span className={styles.bubbleMeta}>{chat.saveError ? "Aguardando envio" : "Enviando…"}</span>
                  : <time className={styles.bubbleMeta} dateTime={message.createdAt}>{messageTime.format(new Date(message.createdAt))}</time>}
              </article>;
            }
            const { reply } = message;
            const photo = reply.photo && !shownPhotos.has(reply.photo.id) ? reply.photo : null;
            if (photo) shownPhotos.add(photo.id);
            const visit = reply.visit && !shownVisits.has(reply.visit.id) ? reply.visit : null;
            if (visit) shownVisits.add(visit.id);
            const audio = replyAudio[reply.turnId];
            const bubbles = reply.bubbles?.length ? reply.bubbles : [reply.message];
            return <article className={styles.replyGroup} key={message.id} aria-label={reply.sellerName || `${VIRTUAL_CONSULTANT_NAME} · consultora virtual`}>
              {reply.sellerName ? <span className={styles.sellerName}>{reply.sellerName} · Equipe de vendas</span> : null}
              {bubbles.map((bubble, index) => <p className={styles.replyBubble} key={index}>{bubble}</p>)}
              {photo ? <ReplyPhotos car={photo} /> : null}
              {visit ? <div className={styles.visitConfirmation}><span className={styles.confirmLabel}>VISITA CONFIRMADA</span><strong>{stamp(visit.startsAt)}</strong><span>{visit.carName}</span>{visit.sellerName ? <span>Vendedor responsável · {visit.sellerName}</span> : null}<Link href={`${panelUrl}?visita=${encodeURIComponent(visit.id)}`}>Ver no painel <span aria-hidden="true">↗</span></Link></div> : null}
              {!reply.sellerName && reply.speechText && reply.wantsAudio && canListen ? <div className={styles.audioResponse}>
                {audio?.status === "ready" ? <>
                  <audio controls preload="metadata" autoPlay={audio.autoplay} src={audio.url} aria-label="Resposta em áudio" onError={() => onReplyAudioError(reply.turnId, audio.url)} />
                  <span>Voz sintetizada com <a href="https://elevenlabs.io" target="_blank" rel="noreferrer">elevenlabs.io</a> (plano gratuito)</span>
                </> : audio?.status === "loading" ? <span role="status">Preparando o áudio…</span> : <>
                  {audio?.status === "error" ? <span role="status">{audio.message}</span> : null}
                  <button type="button" disabled={loading} onClick={() => void getReplyAudio(reply.turnId, true)}>{audio?.status === "error" ? "Tentar ouvir novamente" : "Ouvir"}</button>
                </>}
              </div> : !reply.sellerName && reply.speechText && reply.wantsAudio ? <div className={styles.audioResponse}><span role="status">O áudio está indisponível no momento.</span></div> : null}
              <time className={styles.bubbleMeta} dateTime={message.createdAt}>{messageTime.format(new Date(message.createdAt))}</time>
            </article>;
          })}</div>
          {status ? <div className={styles.typing} role="status">{replying || phase === "uploading" ? <><span /><span /><span /></> : null} {status}</div> : null}
        </div>
        <div className={styles.composer}>
          {inlineError ? <div className={styles.errorRow}><p className={styles.inlineError} role="alert">{inlineError}</p>{retry ? <button type="button" className={styles.retryButton} onClick={retry}>Tentar novamente</button> : null}</div> : null}
          {phase === "recording" ? <div className={styles.recordingRow}><span className={styles.recordingDot} /><strong>Gravando</strong><time>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</time><span className={styles.maxTime}>máx. 00:30</span><button type="button" onClick={stopRecording} aria-label="Parar gravação">Parar</button></div> : null}
          {phase === "review" && clipUrl ? <div className={styles.reviewRow}><audio controls preload="metadata" src={clipUrl} aria-label="Ouça seu áudio antes de enviar" /><button type="button" className={styles.retryButton} onClick={discardClip}>{draft.trim() ? "Voltar ao texto" : "Descartar áudio"}</button><button type="button" className={styles.primaryButton} disabled={humanHandoff} onClick={() => void sendClip()}>Enviar áudio <span aria-hidden="true">↑</span></button></div> : null}
          {phase === "permission" ? <div className={styles.waitRow} role="status"><span className={styles.spinner} /><span>Solicitando acesso ao microfone…</span></div> : null}
          {showTextComposer ? <form className={styles.messageForm} onSubmit={(event) => { event.preventDefault(); sendDraft(); }}>
            <textarea aria-label="Mensagem" placeholder="Digite uma mensagem" enterKeyHint="send" rows={1} maxLength={MAX_CHAT_MESSAGE_LENGTH} value={draft} readOnly={loading}
              onChange={(event) => {
                setDraft(event.target.value);
                chat.noteActivity();
                if (error) setError("");
              }}
              onCompositionUpdate={chat.noteActivity}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  sendDraft();
                }
              }} />
            <button type="button" className={styles.micButton} onClick={() => void beginRecording()} disabled={loading || pending || humanHandoff} aria-label="Gravar áudio" title={recordingHint}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21m-4 0h8" /></svg>
            </button>
            <button type="submit" className={styles.sendButton} disabled={!draft.trim() || loading} aria-label="Enviar mensagem" title="Enviar mensagem">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 21 4l-6.5 16-3.2-7.2L3 11.5Zm8.3 1.3L21 4" /></svg>
            </button>
          </form> : null}
          {phase === "uploading" ? <div className={styles.waitRow}><span className={styles.spinner} /><span>Enviando seu áudio…</span></div> : null}
          {phase === "recording" ? <span className={styles.srOnly} role="status">Gravando áudio de até 30 segundos.</span> : null}
        </div>
        <div className={styles.chatFooter}>
          <p>Sem cadastro · histórico disponível neste navegador.</p>
          <button type="button" disabled={loading || pending || !showTextComposer} onClick={() => void chat.openConversation(true)}>{loading ? "Abrindo conversa…" : "Nova conversa"}</button>
        </div>
      </section>
      <aside className={styles.sidePanel}>
        <h1>Uma conversa que chega até a visita.</h1><p>Pergunte sobre um carro, conte seu orçamento ou combine um horário por mensagem ou áudio.</p>
      </aside>
    </div> : null}
    <footer className={styles.footer}>Pátio Voz <span>·</span> Atendimento para revendas de seminovos</footer>
  </main>;
}
