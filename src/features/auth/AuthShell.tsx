import type { ReactNode } from "react";
import { APP_NAME, COMPANY_NAME } from "../../config/app";
import "./authShell.css";

const DESTAQUES = [
  { valor: "SLA", rotulo: "Prazo por serviço" },
  { valor: "3 canais", rotulo: "WhatsApp · E-mail · App" },
  { valor: "1 fila", rotulo: "Por setor e equipe" },
];

/**
 * Moldura das telas fora do layout (login, redefinir e trocar senha), no layout aprovado no mockup v2
 * (docs/mockups/apple-hig-imobdesk.html, tela 1): foto de helpdesk com véu azul WSA à esquerda e o
 * acesso à direita. No celular, a foto vira uma faixa acima do formulário.
 */
export function AuthShell({ children, kicker = "Acesso ao sistema" }: { children: ReactNode; kicker?: string }) {
  const year = new Date().getFullYear();
  return (
    <div className="mpl-root">
      <aside className="mpl-visual" aria-label={`${APP_NAME} · ${COMPANY_NAME}`}>
        <img
          className="mpl-foto"
          src="/login-helpdesk.jpg"
          alt="Técnico de suporte com fone de ouvido atendendo chamados no computador"
          width={1800}
          height={1200}
        />
        <div className="mpl-scrim" aria-hidden="true" />

        <div className="mpl-brand">
          <span className="mpl-mark">
            <img src="/wsa-logo.png" alt="" width={44} height={44} />
          </span>
          <span className="mpl-brand__nome">
            {APP_NAME}
            <small>{COMPANY_NAME}</small>
          </span>
        </div>

        <div className="mpl-pitch">
          <span className="mpl-tag">Central de Atendimento Inteligente</span>
          <h2 className="mpl-titulo">Cada chamado resolvido no prazo.</h2>
          <p className="mpl-texto">
            Tickets de WhatsApp, e-mail e app do solicitante numa fila só, com SLA por serviço, equipes e histórico
            completo.
          </p>
        </div>

        <ul className="mpl-metrics">
          {DESTAQUES.map((d) => (
            <li key={d.valor}>
              <b>{d.valor}</b>
              <small>{d.rotulo}</small>
            </li>
          ))}
        </ul>
      </aside>

      <main className="mpl-panel">
        <div className="mpl-panel__conteudo">
          <p className="mpl-kicker">{kicker}</p>
          {children}
          <p className="mpl-note">
            O acesso é criado pelo administrador da sua empresa. O mesmo login vale nos outros sistemas da WSA que a
            sua empresa usa.
          </p>
        </div>
        <p className="mpl-legal">
          © {year} {COMPANY_NAME}. Todos os direitos reservados.
        </p>
      </main>
    </div>
  );
}
