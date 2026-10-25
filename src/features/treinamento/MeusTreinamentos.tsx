import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, GraduationCap, Play } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { getMenuItem } from "../../config/menuRegistry";
import { useAccess } from "../configuracoes/access/useAccess";
import { EmptyState } from "../configuracoes/components/EmptyState";
import { useMeusTreinamentos, usePainelTreinamento } from "./hooks";
import { TourPlayer } from "./TourPlayer";
import { ehTelaCelular, PAPEIS, percentual, telaUrl, type ModuloResumo, type Papel } from "./types";

// Meus treinamentos: só a trilha do setor da pessoa (D3), módulos agrupados por papel. O tour abre por cima, na rota
// /centro-treinamento/meus/<módulo>, para o link poder ser compartilhado e o "voltar" do navegador fechar o tour.

const secao = getMenuItem("centro_treinamento_meus");

const PAPEL_CHIP: Record<Papel, string> = { solicitante: "tr-chip--info", atendente: "tr-chip--brand", gestor: "tr-chip--violet", financeiro: "tr-chip--ok" };

export function MeusTreinamentos() {
  const { user, hasPermission } = useAccess();
  const admin = hasPermission("centro_treinamento_gerenciar");
  const [verComo, setVerComo] = useState<number | null>(null);
  const q = useMeusTreinamentos(admin ? verComo : null);
  const painel = usePainelTreinamento(admin);
  const { moduloId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fechar = () => {
    navigate(secao.path);
    // O passo atual é gravado sem recarregar a lista; ao fechar, a barra de progresso dos cartões se atualiza.
    void qc.invalidateQueries({ queryKey: ["treinamento", "meus"] });
  };

  const tour = moduloId && Number(moduloId) > 0 ? <TourPlayer moduloId={Number(moduloId)} onFechar={fechar} /> : null;

  if (q.isLoading) return <div className="card" style={{ padding: 24 }}>Carregando seus treinamentos…</div>;
  if (q.isError || !q.data) {
    return (
      <div className="card">
        <EmptyState icon={GraduationCap} title="Não foi possível carregar os treinamentos" description={q.error instanceof Error ? q.error.message : undefined} />
      </div>
    );
  }

  const { trilha, setor, semCadastro, modulos } = q.data;
  const feitos = modulos.filter((m) => m.concluidoEm).length;
  const minutos = modulos.reduce((t, m) => t + m.minutos, 0);
  const primeiroNome = (user?.name ?? "").split(" ")[0];

  return (
    <>
      {admin && (
        <div className="tr-barra-admin">
          <label htmlFor="tr-ver-como">Ver como (Admin):</label>
          <select id="tr-ver-como" value={verComo ?? ""} onChange={(e) => setVerComo(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Eu ({setor && verComo == null ? setor.nome : "meu setor"})</option>
            {painel.data?.setores.map((s) => (
              <option key={s.id} value={s.id}>
                Setor {s.nome}
              </option>
            ))}
          </select>
          {verComo != null && <span>Mostra todos os módulos da trilha, inclusive os de gestor.</span>}
        </div>
      )}

      {semCadastro && verComo == null && (
        <div className="tr-aviso" role="note">
          <AlertTriangle size={18} aria-hidden="true" style={{ flex: "none", marginTop: 1 }} />
          <span>
            Seu e-mail ainda não está no cadastro de Pessoas, então não sabemos o seu setor. Por enquanto você vê a trilha <b>{trilha?.nome}</b>.
            Peça à supervisão para incluir você em Configurações › Pessoas.
          </span>
        </div>
      )}

      <section className="tr-hero" aria-labelledby="tr-hero-titulo">
        <GraduationCap className="tr-hero__icone" size={56} aria-hidden="true" />
        <div>
          <h2 id="tr-hero-titulo">
            {verComo == null && primeiroNome ? `Olá, ${primeiroNome}. ` : ""}
            {trilha ? `Sua trilha: ${trilha.nome}` : "Nenhuma trilha"}
          </h2>
          <p>
            {setor ? `Setor ${setor.nome}. ` : ""}
            {trilha?.descricao}
          </p>
        </div>
        <div className="tr-hero__stats">
          <div>
            <b>{feitos}</b>
            <span>concluídos</span>
          </div>
          <div>
            <b>{modulos.length}</b>
            <span>módulos</span>
          </div>
          <div>
            <b>{minutos}</b>
            <span>minutos</span>
          </div>
        </div>
      </section>

      {modulos.length === 0 ? (
        <div className="card">
          <EmptyState icon={GraduationCap} title="Nenhum treinamento publicado para você ainda" description="Os tutoriais do seu setor aparecem aqui assim que forem publicados." />
        </div>
      ) : (
        (Object.keys(PAPEIS) as Papel[]).map((papel) => {
          const lista = modulos.filter((m) => m.papel === papel);
          if (lista.length === 0) return null;
          return (
            <section key={papel} aria-label={PAPEIS[papel]}>
              <p className="tr-papel">{PAPEIS[papel]}</p>
              <div className="tr-grade">
                {lista.map((m) => (
                  <Cartao key={m.id} modulo={m} />
                ))}
              </div>
            </section>
          );
        })
      )}

      {tour}
    </>
  );
}

function Cartao({ modulo: m }: { modulo: ModuloResumo }) {
  const pct = percentual(m);
  const feito = m.concluidoEm != null;
  const acao = feito ? "Rever" : m.iniciado ? "Continuar" : "Começar";
  const destino = `${secao.path}/${m.id}`;
  const celular = m.capa != null && ehTelaCelular(m.capa);

  return (
    <article className="tr-mod">
      <Link to={destino} className={`tr-mod__capa${celular ? " tr-mod__capa--celular" : ""}`} aria-label={`${acao}: ${m.titulo}`}>
        {m.capa && <img src={telaUrl(m.capa)} alt="" loading="lazy" />}
        <span className="tr-mod__play" aria-hidden="true">
          <span>
            <Play size={22} fill="currentColor" />
          </span>
        </span>
        <span className="tr-mod__dur">
          {m.passos} passos · {m.minutos} min
        </span>
      </Link>
      <div className="tr-mod__corpo">
        <h4>{m.titulo}</h4>
        <p>{m.descricao}</p>
        <div className="tr-mod__meta">
          <span className={`tr-chip ${PAPEL_CHIP[m.papel]}`}>{PAPEIS[m.papel]}</span>
          {m.celular && <span className="tr-chip">Celular</span>}
        </div>
        <div className={`tr-barra${feito ? " tr-barra--ok" : ""}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Progresso de ${m.titulo}`}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="tr-mod__rodape">
          {feito ? <span className="tr-chip tr-chip--ok">✓ Concluído</span> : <span>{m.iniciado ? `${pct}% feito` : "Não iniciado"}</span>}
          <Link to={destino} className={`btn tr-btn-sm ${feito ? "btn--outline" : "btn--primary"}`}>
            {acao}
          </Link>
        </div>
      </div>
    </article>
  );
}
