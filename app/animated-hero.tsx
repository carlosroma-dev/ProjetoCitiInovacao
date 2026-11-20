"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Icon } from "./demo/[roundId]/painel/painel-ui";
import styles from "./page.module.css";

const phrases = [
  "consulta o estoque.",
  "agenda visitas.",
  "encaminha o chat.",
];

const rotationInterval = 2_000;

export default function AnimatedHero({ chatHref, panelHref }: { chatHref: string; panelHref: string }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer: number | undefined;

    function syncRotation() {
      window.clearInterval(timer);
      if (motionPreference.matches) return;

      timer = window.setInterval(() => {
        setActiveIndex((index) => (index + 1) % phrases.length);
      }, rotationInterval);
    }

    syncRotation();
    motionPreference.addEventListener("change", syncRotation);
    return () => {
      window.clearInterval(timer);
      motionPreference.removeEventListener("change", syncRotation);
    };
  }, [paused]);

  const previousIndex = (activeIndex + phrases.length - 1) % phrases.length;
  const motionLabel = paused ? "Retomar animação do título" : "Pausar animação do título";

  return (
    <div className={styles.heroCopy}>
      <p className={styles.audience}>Atendimento com IA para revendas</p>
      <h1 id="hero-title">
        Uma assistente que
        <span className="sr-only"> consulta o estoque, agenda visitas e encaminha conversas.</span>
        <span className={styles.rotatingTitle} aria-hidden="true">
          {phrases.map((phrase, index) => (
            <span
              className={styles.rotatingPhrase}
              data-state={index === activeIndex ? "active" : index === previousIndex ? "outgoing" : undefined}
              key={phrase}
            >
              {phrase}
            </span>
          ))}
        </span>
      </h1>

      <p className={styles.summary}>
        Atenda clientes por texto e áudio e acompanhe as visitas e conversas no painel da revenda.
      </p>
      <div className={styles.actions}>
        <Link className={`${styles.action} ${styles.primaryAction}`} href={chatHref}>
          <Icon name="chat" /> Experimentar chat
        </Link>
        <Link className={`${styles.action} ${styles.secondaryAction}`} href={panelHref}>
          <Icon name="overview" /> Explorar painel
        </Link>
      </div>
      <div className={styles.access}>
        <p>Chat sem cadastro. Painel com login.</p>
        <button
          type="button"
          className={styles.motionToggle}
          aria-label={motionLabel}
          title={motionLabel}
          onClick={() => setPaused((value) => !value)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {paused ? <path d="m5 3 8 5-8 5Z" /> : <path d="M6 4v8m4-8v8" />}
          </svg>
        </button>
      </div>
    </div>
  );
}
