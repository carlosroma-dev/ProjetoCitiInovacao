"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./demo.module.css";

export default function DemoStart({ sharedStore = false }: { sharedStore?: boolean }) {
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<"loading" | "error">("loading");
  const [error, setError] = useState("");
  const createRound = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    setState("loading");
    setError("");
    try {
      const response = await fetch(sharedStore ? "/api/demo/loja" : "/api/demo", { method: "POST" });
      const payload = await response.json();
      if (!response.ok || typeof payload.roundId !== "string") throw new Error(payload.error || "Não foi possível iniciar a demonstração.");
      router.replace(`/demo/${encodeURIComponent(payload.roundId)}`);
    } catch (cause) {
      started.current = false;
      setError(cause instanceof Error ? cause.message : "Não foi possível iniciar a demonstração.");
      setState("error");
    }
  }, [router, sharedStore]);

  useEffect(() => { void createRound(); }, [createRound]);

  return <main className={styles.startPage}>
    <header className={styles.startHeader}><Link className={styles.brand} href="/">Pátio<span>Voz</span></Link><span>DEMO · REVENDA FICTÍCIA</span></header>
    <section className={styles.startCard} aria-live="polite">
      <div className={styles.brandMark} aria-hidden="true">PV</div>
      {state === "loading" ? <><p className={styles.eyebrow}>Preparando sua experiência</p><h1>Um instante.</h1><p>Estamos abrindo o chat para você conversar com a loja.</p><span className={styles.loadingLine} role="status">Abrindo a demonstração…</span></> : <><p className={styles.eyebrow}>Não foi possível continuar</p><h1>O chat não abriu.</h1><p role="alert">{error}</p><button className={styles.primaryButton} onClick={() => void createRound()}>Tentar novamente <span aria-hidden="true">↗</span></button><Link className={styles.backLink} href="/">Voltar à apresentação</Link></>}
    </section>
  </main>;
}
