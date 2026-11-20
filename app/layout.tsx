import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/geist";
import "./globals.css";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pátio Voz | Visitas que chegam com contexto",
  description:
    "O atendimento por voz transforma dúvidas sobre seminovos em visitas agendadas, com o contexto pronto para o vendedor.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
