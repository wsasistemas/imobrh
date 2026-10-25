import { Pencil, Play, Plus, Users } from "lucide-react";
import { Fragment, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { getMenuItem } from "../../config/menuRegistry";
import { EmptyState } from "../configuracoes/components/EmptyState";
import { EditorModulo } from "./EditorModulo";
import { usePainelTreinamento, useProgressoPessoas, useProgressoPorSetor, useSalvarSetoresDaTrilha } from "./hooks";
import { PAPEIS, percentual, type ProgressoSetor, type TrilhaAdmin } from "./types";

// Gerenciar tutoriais (só Admin): módulos de cada trilha, editor de balão, setores de cada trilha e progresso por setor.

const meus = getMenuItem("centro_treinamento_meus");

const erroMsg = (e: unknown, padrao: string) => (e instanceof Error && e.message ? e.message : padrao);

export function GerenciarTutoriais() {
  const painel = usePainelTreinamento();
  // null = nenhum aberto; 0 = novo módulo.
  const [editando, setEditando] = useState<number | null>(null);

  if (painel.isLoading) return <div className="card" style={{ padding: 24 }}>Carregando…</div>;
  if (painel.isError || !painel.data) {
    return (
      <div className="card">
        <EmptyState icon={Pencil} title="Não foi possível carregar os tutoriais" description={erroMsg(painel.error, "Tente de novo em instantes.")} />
      </div>
    );
  }
  const { trilhas, modulos } = painel.data;
  const trilhasDo = (id: number) => trilhas.filter((t) => t.modulos.includes(id));

  return (
    <>
      <h2 className="tr-secao">
        Módulos
        <button type="button" className="btn btn--primary tr-btn-sm" onClick={() => setEditando(0)}>
          <Plus size={16} aria-hidden /> Novo módulo
        </button>
      </h2>
      <div className="card tr-tabela-wrap">
        <table className="tr-tabela">
          <thead>
            <tr>
              <th>Módulo</th>
              <th>Trilhas</th>
              <th>Para quem</th>
              <th>Balões</th>
              <th>Duração</th>
              <th>Concluíram</th>
              <th>Status</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {modulos.map((m) => (
              <tr key={m.id}>
                <td>
                  <b>{m.titulo}</b>
                  {m.restricao && <div style={{ color: "var(--muted)", fontSize: 12 }}>{m.restricao === "aprovador" ? "Só aprovadores" : "Só gestores do setor"}</div>}
                </td>
                <td>
                  <div className="tr-mod__meta" style={{ padding: 0 }}>
                    {trilhasDo(m.id).map((t) => (
                      <span key={t.id} className="tr-chip">
                        {t.nome}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <span className="tr-chip tr-chip--info">{PAPEIS[m.papel]}</span>
                </td>
                <td>{m.passos}</td>
                <td>{m.minutos} min</td>
                <td>
                  {m.concluiram} de {m.publico}
                </td>
                <td>
                  <span className={`tr-chip ${m.status === "publicado" ? "tr-chip--ok" : "tr-chip--warn"}`}>{m.status === "publicado" ? "Publicado" : "Rascunho"}</span>
                </td>
                <td>
                  <div className="tr-tabela__acoes">
                    <button type="button" className="btn btn--outline tr-btn-sm" onClick={() => setEditando(m.id)}>
                      <Pencil size={14} aria-hidden /> Editar
                    </button>
                    <Link to={`${meus.path}/${m.id}`} className="btn btn--outline tr-btn-sm" aria-label={`Ver o tour de ${m.titulo}`} title="Ver no tour">
                      <Play size={14} aria-hidden />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editando != null && <EditorModulo key={editando} moduloId={editando || null} trilhas={trilhas} onFechar={() => setEditando(null)} onCriado={(id) => setEditando(id)} />}

      <SetoresDasTrilhas trilhas={trilhas} setores={painel.data.setores} />
      <ProgressoPorSetor />
    </>
  );
}

/** Cada setor segue uma trilha; setor sem trilha vê a trilha padrão (Colaborador). */
function SetoresDasTrilhas({ trilhas, setores }: { trilhas: TrilhaAdmin[]; setores: { id: number; nome: string }[] }) {
  const salvar = useSalvarSetoresDaTrilha();
  const trilhaDoSetor = (setorId: number) => trilhas.find((t) => t.setores.some((s) => s.id === setorId))?.id ?? null;
  const padrao = trilhas.find((t) => t.padrao);

  const mudar = (setorId: number, trilhaId: number | null) => {
    const atual = trilhaDoSetor(setorId);
    // Voltar para a padrão = tirar o setor da trilha em que estava.
    const alvo = trilhaId ?? atual;
    if (alvo == null) return;
    const t = trilhas.find((x) => x.id === alvo)!;
    const ids = t.setores.map((s) => s.id).filter((id) => id !== setorId);
    if (trilhaId != null) ids.push(setorId);
    salvar.mutate(
      { trilhaId: alvo, setores: ids },
      { onSuccess: () => toast.success("Trilha do setor salva"), onError: (e) => toast.error(erroMsg(e, "Não foi possível salvar.")) },
    );
  };

  return (
    <>
      <h2 className="tr-secao">Trilha de cada setor</h2>
      <div className="card tr-tabela-wrap">
        <table className="tr-tabela">
          <thead>
            <tr>
              <th>Setor</th>
              <th>Trilha</th>
            </tr>
          </thead>
          <tbody>
            {setores.map((s) => (
              <tr key={s.id}>
                <td>{s.nome}</td>
                <td>
                  <select
                    className="input input--sm"
                    aria-label={`Trilha do setor ${s.nome}`}
                    value={trilhaDoSetor(s.id) ?? ""}
                    disabled={salvar.isPending}
                    onChange={(e) => mudar(s.id, e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">{padrao ? `${padrao.nome} (padrão)` : "Padrão"}</option>
                    {trilhas
                      .filter((t) => !t.padrao)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.nome}
                        </option>
                      ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ProgressoPorSetor() {
  const q = useProgressoPorSetor();
  const [aberto, setAberto] = useState<string | null>(null);

  return (
    <>
      <h2 className="tr-secao">Progresso por setor</h2>
      <div className="card tr-tabela-wrap">
        {q.isLoading ? (
          <p style={{ padding: 16, margin: 0 }}>Carregando…</p>
        ) : q.isError ? (
          <p style={{ padding: 16, margin: 0 }} className="field__error">
            {erroMsg(q.error, "Não foi possível carregar o progresso.")}
          </p>
        ) : (
          <table className="tr-tabela">
            <thead>
              <tr>
                <th>Setor</th>
                <th>Pessoas</th>
                <th>Trilha</th>
                <th>Concluíram tudo</th>
                <th>Em andamento</th>
                <th>Não começaram</th>
                <th aria-label="Ações" />
              </tr>
            </thead>
            <tbody>
              {(q.data ?? []).map((s) => {
                const chave = String(s.setorId);
                return (
                  <Fragment key={chave}>
                    <tr>
                      <td>{s.setor}</td>
                      <td>{s.pessoas}</td>
                      <td>{s.trilha}</td>
                      <td>{s.concluiram}</td>
                      <td>{s.andamento}</td>
                      <td>{s.naoComecaram}</td>
                      <td>
                        <button type="button" className="btn btn--outline tr-btn-sm" aria-expanded={aberto === chave} onClick={() => setAberto(aberto === chave ? null : chave)}>
                          <Users size={14} aria-hidden /> {aberto === chave ? "Ocultar" : "Ver pessoas"}
                        </button>
                      </td>
                    </tr>
                    {aberto === chave && (
                      <tr className="tr-tabela__sub">
                        <td colSpan={7}>
                          <Pessoas setor={s} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Pessoas({ setor }: { setor: ProgressoSetor }) {
  const q = useProgressoPessoas(setor.setorId, true);
  if (q.isLoading) return <span>Carregando…</span>;
  if (q.isError) return <span className="field__error">{erroMsg(q.error, "Não foi possível carregar as pessoas.")}</span>;
  if (!q.data?.length) return <span>Ninguém neste setor.</span>;
  return (
    <div className="tr-pessoas">
      {q.data.map((p) => (
        <div key={p.usuarioId} className="tr-pessoa">
          <b>{p.nome}</b>
          <div className="tr-pessoa__mods">
            {p.modulos.map((m) => {
              const pct = percentual(m);
              return (
                <span key={m.id} className={`tr-chip ${m.concluidoEm ? "tr-chip--ok" : pct > 0 ? "tr-chip--warn" : ""}`} title={m.titulo}>
                  {m.concluidoEm ? "✓ " : ""}
                  {m.titulo.length > 28 ? `${m.titulo.slice(0, 27)}…` : m.titulo}
                  {!m.concluidoEm && pct > 0 ? ` · ${pct}%` : ""}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
