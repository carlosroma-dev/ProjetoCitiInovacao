"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { responseError, sellerPanelHref } from "../demo/[roundId]/painel/painel-data";
import { ErrorNotice, Icon, Loading, Wordmark } from "../demo/[roundId]/painel/painel-ui";
import styles from "../demo/[roundId]/painel/painel.module.css";

const sessionEndpoint = "/api/seller/session";

export default function Login({ roundId, visitId }: { roundId: string | null; visitId: string | null }) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const verification = useRef<AbortController | null>(null);

  const checkSession = useCallback(async () => {
    verification.current?.abort();
    const controller = new AbortController();
    verification.current = controller;
    setChecking(true);
    setSessionError(null);
    let redirecting = false;
    try {
      const response = await fetch(sessionEndpoint, {
        method: roundId ? "GET" : "PATCH",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 401) return;
      if (!response.ok) throw new Error(await responseError(response, "Não foi possível verificar a sessão."));
      const session: { roundId?: string } = await response.json();
      if (controller.signal.aborted) return;
      if (!session.roundId) throw new Error("Não foi possível verificar a sessão.");
      if (!roundId || session.roundId === roundId) {
        redirecting = true;
        router.replace(sellerPanelHref(session.roundId, roundId ? visitId : null));
      }
    } catch {
      if (!controller.signal.aborted) setSessionError("Não foi possível verificar sua sessão.");
    } finally {
      if (!redirecting && !controller.signal.aborted) setChecking(false);
    }
  }, [roundId, router, visitId]);

  useEffect(() => {
    void checkSession();
    return () => verification.current?.abort();
  }, [checkSession]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const fields = new FormData(event.currentTarget);
    const email = String(fields.get("email") ?? "").trim();
    const password = String(fields.get("password") ?? "");
    setSaving(true);
    setFormError(null);
    try {
      const response = await fetch(sessionEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, ...(roundId ? { roundId } : {}) }),
      });
      if (!response.ok) {
        const fallback = response.status === 401 ? "Confira seu e-mail e sua senha." : "Não foi possível entrar. Tente novamente.";
        throw new Error(await responseError(response, fallback));
      }
      const session: { roundId: string } = await response.json();
      if (!session.roundId) throw new Error("Não foi possível confirmar a sessão.");
      router.replace(sellerPanelHref(session.roundId, roundId === session.roundId ? visitId : null));
    } catch (error) {
      setFormError(error instanceof TypeError ? "Confira sua conexão e tente entrar novamente." :
        error instanceof Error ? error.message : "Não foi possível entrar. Tente novamente.");
      setSaving(false);
    }
  }

  return (
    <div className={styles.loginPage}>
      <header className={styles.loginBar}>
        <Wordmark />
        {roundId ? (
          <Link href={`/demo/${encodeURIComponent(roundId)}`} className={styles.loginChatLink}>
            <Icon name="chat" /> Voltar ao chat
          </Link>
        ) : null}
      </header>
      <main className={styles.loginMain}>
        <section className={styles.loginCard} aria-labelledby="login-title">
          <span className={styles.loginIcon}><Icon name="lock" /></span>
          <h1 id="login-title">Área do vendedor</h1>
          <p>Entre para acessar a agenda e o estoque da revenda.</p>
          {checking ? <Loading label="Verificando sessão…" /> : (
            <>
              {sessionError ? <ErrorNotice message={sessionError} retry={() => void checkSession()} /> : null}
              <form onSubmit={signIn} aria-busy={saving}>
                <fieldset disabled={saving}>
                  <label htmlFor="seller-email">E-mail</label>
                  <input className={styles.control} id="seller-email" name="email" type="email" autoComplete="username" required />
                  <label htmlFor="seller-password">Senha</label>
                  <input className={styles.control} id="seller-password" name="password" type="password" autoComplete="current-password" required />
                </fieldset>
                {formError ? <ErrorNotice message={formError} /> : null}
                <button className={styles.primaryButton} type="submit" disabled={saving}>
                  {saving ? "Entrando…" : "Entrar"} <Icon name="right" />
                </button>
              </form>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
