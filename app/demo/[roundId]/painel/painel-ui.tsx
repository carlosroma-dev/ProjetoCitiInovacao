import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./painel.module.css";

const paths = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  calendar: "M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  car: "M5 17v3m14-3v3M3 12l2-5a2 2 0 0 1 2-1h10a2 2 0 0 1 2 1l2 5M3 12h18m-15 2h.01M18 14h.01M3 12v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4",
  chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.4-4.1A8.5 8.5 0 1 1 21 11.5ZM8 12h.01M12 12h.01M16 12h.01",
  logout: "M10 17l5-5-5-5m5 5H3m9-9h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6",
  out: "M7 17 17 7M7 7h10v10",
  left: "m15 18-6-6 6-6",
  right: "m9 18 6-6-6-6",
  up: "m6 15 6-6 6 6",
  down: "m6 9 6 6 6-6",
  clock: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 6v6l4 2",
  plus: "M12 5v14M5 12h14",
  edit: "m4 16-1 5 5-1L20 8a2 2 0 0 0-4-4L4 16Zm10-10 4 4",
  close: "m6 6 12 12M6 18 18 6",
  photo: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm0 13 5-5 4 4 3-3 5 5M8 8h.01",
  lock: "M7 11V7a5 5 0 0 1 10 0v4M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Zm6 4v2",
  refresh: "M20 7v5h-5M4 17v-5h5m-4 5a8 8 0 0 0 13 2m1-12A8 8 0 0 0 6 5",
} as const;

export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export function Wordmark() {
  return (
    <Link className={styles.wordmark} href="/" aria-label="Pátio Voz, início">
      <span className={styles.brandMark} aria-hidden="true">
        <i /><i /><i /><i /><i />
      </span>
      <span>Pátio<span className={styles.brandVoice}>Voz</span></span>
    </Link>
  );
}

export function Empty({ icon, title, children }: { icon: keyof typeof paths; title: string; children: ReactNode }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon}><Icon name={icon} /></span>
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className={styles.loading} role="status" aria-label={label}>
      <span className={styles.srOnly}>{label}</span>
      <i /><i /><i />
    </div>
  );
}

export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className={styles.errorNotice} role="alert">
      <span>{message}</span>
      {retry ? (
        <button type="button" className={styles.secondaryButton} onClick={retry}>
          <Icon name="refresh" /> Tentar novamente
        </button>
      ) : null}
    </div>
  );
}
