"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Car, CarStatus, SellerSnapshot } from "../../../../lib/contracts";
import { Agenda, Overview } from "./painel-agenda";
import { Atendimento } from "./painel-atendimento";
import { dateKey, dateLabel, groupSchedule, responseError, sellerLoginHref, sortChronologically } from "./painel-data";
import { Stock } from "./painel-estoque";
import { ErrorNotice, Icon, Loading, Wordmark } from "./painel-ui";
import styles from "./painel.module.css";

const sections = [
  { id: "overview", title: "Visão geral", icon: "overview" },
  { id: "agenda", title: "Agenda", icon: "calendar" },
  { id: "contact", title: "Atendimento", icon: "chat" },
  { id: "stock", title: "Estoque", icon: "car" },
] as const;
type Section = (typeof sections)[number]["id"];
type CarChange = { status?: CarStatus; move?: "up" | "down" };
const refreshInterval = 15_000;
const contactRefreshInterval = 4_000;

export default function PainelClient({ roundId, highlightId }: { roundId: string; highlightId: string | null }) {
  const router = useRouter();
  const [section, setSection] = useState<Section>("overview");
  const [snapshot, setSnapshot] = useState<SellerSnapshot | null>(null);
  const [today, setToday] = useState(() => dateKey(new Date()));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const activeFetch = useRef<AbortController | null>(null);
  const mutating = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  const endpoint = `/api/seller/rounds/${encodeURIComponent(roundId)}`;
  const chatPath = `/demo/${encodeURIComponent(roundId)}`;

  const requestSignIn = useCallback(() => {
    router.replace(sellerLoginHref(roundId, highlightId));
  }, [router, roundId, highlightId]);

  const load = useCallback(async (foreground = false) => {
    if (mutating.current || (activeFetch.current && !foreground)) return;
    activeFetch.current?.abort();
    const controller = new AbortController();
    activeFetch.current = controller;
    if (foreground) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        requestSignIn();
        return;
      }
      if (!response.ok) throw new Error(await responseError(response, "Não foi possível carregar o painel."));
      const data: SellerSnapshot = await response.json();
      if (!controller.signal.aborted) {
        setSnapshot(data);
        setToday(dateKey(new Date()));
        setLoadError(null);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setLoadError(error instanceof TypeError ? "Não foi possível conectar. Confira sua conexão." :
          error instanceof Error ? error.message : "Não foi possível carregar o painel.");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (activeFetch.current === controller) activeFetch.current = null;
    }
  }, [endpoint, requestSignIn]);

  const refreshSnapshot = useCallback(() => { void load(); }, [load]);

  useEffect(() => {
    void load(true);
    return () => activeFetch.current?.abort();
  }, [load]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible" && !mutating.current) void load();
    };
    if (section === "contact") refresh();
    const timer = window.setInterval(refresh, section === "contact" ? contactRefreshInterval : refreshInterval);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, section]);

  useEffect(() => {
    if (focusHeading.current) {
      heading.current?.focus();
      focusHeading.current = false;
    }
  }, [section]);

  const schedule = useMemo(() => groupSchedule(snapshot?.visits ?? [], snapshot?.slots ?? []), [snapshot]);
  const visits = useMemo(() => [...(snapshot?.visits ?? [])].sort(sortChronologically), [snapshot]);

  function goToSection(next: Section) {
    if (next === section) return;
    focusHeading.current = true;
    setSection(next);
  }

  function viewDate(date: string) {
    setSelectedDate(date);
    goToSection("agenda");
  }

  async function signOut() {
    setSigningOut(true);
    setLogoutError(null);
    try {
      const response = await fetch("/api/seller/session", { method: "DELETE" });
      if (!response.ok && response.status !== 401) {
        throw new Error(await responseError(response, "Não foi possível encerrar a sessão."));
      }
      router.replace("/vendedor");
    } catch (error) {
      setLogoutError(error instanceof TypeError ? "Confira sua conexão e tente sair novamente." :
        error instanceof Error ? error.message : "Não foi possível encerrar a sessão.");
      setSigningOut(false);
    }
  }

  async function saveCar(car: Car | null, change: CarChange | FormData) {
    if (mutating.current) throw new Error("Aguarde a alteração em andamento.");
    mutating.current = true;
    activeFetch.current?.abort();
    activeFetch.current = null;
    const multipart = change instanceof FormData;
    try {
      const destination = car ? `${endpoint}/cars/${encodeURIComponent(car.id)}` : `${endpoint}/cars`;
      const response = await fetch(destination, {
        method: car ? "PATCH" : "POST",
        headers: multipart ? undefined : { "Content-Type": "application/json" },
        body: multipart ? change : JSON.stringify(change),
      });
      if (response.status === 401 || response.status === 403) {
        requestSignIn();
        throw new Error("Entre novamente para continuar.");
      }
      if (!response.ok) throw new Error(await responseError(response, "Não foi possível salvar o veículo. Tente novamente."));
      const { car: saved }: { car: Car } = await response.json();
      if (!saved?.id) throw new Error("Não foi possível confirmar a alteração. Atualize o painel.");
      setSnapshot((current) => {
        if (!current) return current;
        if (!car) return { ...current, cars: [...current.cars, saved] };
        const cars = current.cars.map((item) => item.id === saved.id ? saved : item);
        if (!multipart && change.move) {
          const index = cars.findIndex((item) => item.id === saved.id);
          const to = index + (change.move === "up" ? -1 : 1);
          if (index >= 0 && to >= 0 && to < cars.length) {
            [cars[index], cars[to]] = [cars[to], cars[index]];
          }
        }
        return { ...current, cars };
      });
    } catch (error) {
      throw error instanceof TypeError ? new Error("Confira sua conexão e tente salvar novamente.") : error;
    } finally {
      mutating.current = false;
      void load();
    }
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar} aria-label="Painel da revenda">
        <div className={styles.brand}><Wordmark /></div>
        <nav className={styles.nav} aria-label="Seções do painel">
          {sections.map(({ id, title, icon }) => (
            <button key={id} type="button" aria-current={section === id ? "page" : undefined}
              onClick={() => goToSection(id)}>
              <Icon name={icon} /><span>{title}</span>
            </button>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <button type="button" onClick={() => void signOut()} disabled={signingOut}
            aria-label={signingOut ? "Saindo" : "Sair"} title="Sair">
            <Icon name="logout" /><span>{signingOut ? "Saindo…" : "Sair"}</span>
          </button>
        </div>
      </aside>
      <div className={styles.workspace}>
        <header className={styles.topbar}>
          <span>Painel da revenda</span>
          <Link className={styles.secondaryButton} href={chatPath}>
            <Icon name="chat" /> <span>Abrir chat</span><Icon name="out" />
          </Link>
        </header>
        <main className={styles.content}>
          <div className={styles.pageHeading}>
            <h1 ref={heading} tabIndex={-1}>{sections.find(({ id }) => id === section)?.title}</h1>
            {section === "overview" && snapshot ? <time dateTime={today}>{dateLabel(today)}</time> : null}
          </div>
          {logoutError ? <ErrorNotice message={logoutError} retry={() => void signOut()} /> : null}
          {loadError ? (
            <ErrorNotice message={snapshot ? `Falha ao atualizar os dados. ${loadError}` : loadError} retry={() => void load(true)} />
          ) : null}
          {!snapshot && loading ? <Loading label="Carregando painel…" /> : null}
          {snapshot ? (
            section === "overview" ? <Overview schedule={schedule} visits={visits} today={today} highlightId={highlightId} selectDate={viewDate} /> :
            section === "agenda" ? <Agenda visits={visits} slots={snapshot.slots} today={today} selectedDay={selectedDate ?? today}
              onSelectedDay={setSelectedDate} highlightId={highlightId} /> :
            section === "contact" ? <Atendimento handoffs={snapshot.handoffs ?? []} visits={visits}
              endpoint={endpoint} requestSignIn={requestSignIn} refresh={refreshSnapshot} /> :
            <Stock cars={snapshot.cars} saveCar={saveCar} />
          ) : null}
        </main>
      </div>
    </div>
  );
}
