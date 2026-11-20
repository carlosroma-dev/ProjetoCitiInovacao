import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import AnimatedHero from "./animated-hero";
import { Wordmark } from "./demo/[roundId]/painel/painel-ui";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "PátioVoz | Chat com IA e painel para revendas",
  description:
    "Atenda por texto e áudio, consulte o estoque e agende visitas pelo chat. Acompanhe as conversas e a agenda no painel da revenda.",
};

const chatHref = "/demo/loja";
const panelHref = "/vendedor";

export default function LandingPage() {
  return (
    <div className={styles.landing}>
      <a className={styles.skipLink} href="#conteudo">Ir para o conteúdo</a>
      <header className={styles.header}>
        <div className={`${styles.shell} ${styles.masthead}`}>
          <Wordmark />
          <nav className={styles.navigation} aria-label="Navegação principal">
            <a className={styles.navLink} href="#como-funciona">Como funciona</a>
            <Link className={styles.navAction} href={panelHref}>Área do vendedor</Link>
          </nav>
        </div>
      </header>

      <main id="conteudo" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={`${styles.shell} ${styles.heroLayout}`}>
            <AnimatedHero chatHref={chatHref} panelHref={panelHref} />

            <figure className={styles.preview}>
              <Image
                className={styles.panelImage}
                src="/images/landing/painel.webp"
                alt="Agenda no painel da revenda, com calendário de visitas e filtro por vendedor."
                width={1740}
                height={822}
                priority
                unoptimized
              />
              <Image
                className={styles.chatImage}
                src="/images/landing/chat.webp"
                alt="Chat do PátioVoz informando a disponibilidade e o preço de um Renault Kwid e enviando a foto do carro."
                title="Foto do Kwid por Charles / usf1fan2 (CC BY 2.0)"
                width={680}
                height={901}
                loading="eager"
                unoptimized
              />
            </figure>
          </div>
        </section>

        <section className={`${styles.shell} ${styles.workflow}`} id="como-funciona" aria-labelledby="workflow-title">
          <h2 id="workflow-title">Como funciona</h2>
          <article className={styles.feature}>
            <h3>Chat com IA</h3>
            <p>
              O cliente pergunta pelo carro. A assistente consulta o estoque, envia fotos e combina um horário
              para a visita pelo próprio chat.
            </p>
          </article>
          <article className={styles.feature}>
            <h3>Painel da revenda</h3>
            <p>
              Sua equipe gerencia o estoque, vê as visitas confirmadas na agenda e pode continuar
              as conversas encaminhadas pela assistente.
            </p>
          </article>
        </section>
      </main>

      <footer className={`${styles.shell} ${styles.footer}`}>
        <span className={styles.footerBrand}>PátioVoz</span>
      </footer>
    </div>
  );
}
