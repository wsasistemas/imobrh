import type { ReactNode } from "react";
import { APP_NAME, COMPANY_NAME } from "../../config/app";
import "./authShell.css";

const DESTAQUES = [
  { valor: "8 serviços", rotulo: "Da admissão ao desligamento" },
  { valor: "CLT", rotulo: "Prazos legais em destaque" },
  { valor: "TOTVS RM", rotulo: "Dados lidos do RM" },
];

/**
 * Moldura das telas fora do layout (login, redefinir e trocar senha), no layout aprovado no mockup v2
 * (docs/mockups/apple-hig-imobdesk.html, tela 1): foto do setor de RH (Unsplash, Cytonn Photography,
 * licença livre) com véu azul WSA à esquerda e o acesso à direita. No celular, a foto vira uma faixa acima do formulário.
 */
export function AuthShell({ children, kicker = "Acesso ao sistema" }: { children: ReactNode; kicker?: string }) {
  const year = new Date().getFullYear();
  return (
    <div className="mpl-root">
      <aside className="mpl-visual" aria-label={`${APP_NAME} · ${COMPANY_NAME}`}>
        <img
          className="mpl-foto"
          src="/login-rh.jpg"
          alt="Analista de RH cumprimentando um candidato numa entrevista"
          width={1600}
          height={1068}
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
          <span className="mpl-tag">Console do RH</span>
          <h2 className="mpl-titulo">Cada pedido de RH tratado no prazo.</h2>
          <p className="mpl-texto">
            Férias, atestados, admissões e desligamentos numa caixa só, com etapas, prazos da CLT e histórico
            completo de cada caso.
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
            Use o mesmo login do imobdesk. O acesso ao Console é liberado pelo administrador do RH da sua empresa.
          </p>
        </div>
        <p className="mpl-legal">
          © {year} {COMPANY_NAME}. Todos os direitos reservados.
        </p>
      </main>
    </div>
  );
}
