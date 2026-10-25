import { Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ADMIN_ROLE } from "../../../config/app";
import { useAccess } from "../../configuracoes/access/useAccess";
import { ServiceError } from "../../configuracoes/services/types";
import type { Indicador } from "../calculos";
import { KpiGer, Secao, Semaforo, Tabela, Variacao, type Coluna } from "../componentes";
import { fmtNum, Medidor } from "../graficos";
import { useSalvarMetas, useVisao } from "../hooks";
import { METAS_ROTULOS, type Metas } from "../types";

const CHAVES_METAS = Object.keys(METAS_ROTULOS) as (keyof Metas)[];

const sufixo = (unidade: string) => (unidade === "%" ? "%" : unidade === "h" ? " h" : "");
const fmtValor = (valor: number | null, unidade: string) => (valor === null ? "—" : `${fmtNum(valor, unidade === "h" ? 1 : 0)}${sufixo(unidade)}`);
const comoTexto = (metas: Metas) => Object.fromEntries(CHAVES_METAS.map((k) => [k, String(metas[k])])) as Record<keyof Metas, string>;

/** Indicadores: KPIs com semáforo, meta, variação e atingimento; Admin edita as metas e limites aqui. */
export function Indicadores() {
  const v = useVisao();
  const { role, isSuperAdmin } = useAccess();
  const podeEditar = isSuperAdmin || role === ADMIN_ROLE;
  const [salvas, setSalvas] = useState(false);
  const resumo = { verde: 0, amarelo: 0, vermelho: 0, cinza: 0 };
  for (const i of v.indicadores) resumo[i.semaforo]++;

  const colunas: Coluna<Indicador>[] = [
    {
      chave: "label",
      label: "Indicador",
      valor: (i) => i.label,
      render: (i) => (
        <>
          <b>{i.label}</b>
          <br />
          <small className="ds-muted">{i.descricao}</small>
        </>
      ),
    },
    { chave: "valor", label: "Atual", num: true, valor: (i) => i.valor, render: (i) => fmtValor(i.valor, i.unidade) },
    { chave: "meta", label: "Meta", num: true, valor: (i) => i.meta, render: (i) => `${i.maiorMelhor ? "≥" : "≤"} ${fmtValor(i.meta, i.unidade)}` },
    { chave: "semaforo", label: "Situação", valor: (i) => i.semaforo, render: (i) => <Semaforo tom={i.semaforo} /> },
    { chave: "anterior", label: "Período anterior", num: true, valor: (i) => i.anterior, render: (i) => fmtValor(i.anterior, i.unidade) },
    { chave: "variacaoPct", label: "Variação", num: true, valor: (i) => i.variacaoPct, render: (i) => <Variacao pct={i.variacaoPct} maiorMelhor={i.maiorMelhor} sufixo="" /> },
    {
      chave: "atingimentoPct",
      label: "Atingimento",
      num: true,
      valor: (i) => i.atingimentoPct,
      render: (i) => (
        <div style={{ minWidth: 140 }}>
          <Medidor pct={i.atingimentoPct} tom={i.semaforo} />
          <small>{i.atingimentoPct === null ? "—" : `${i.atingimentoPct}%`}</small>
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="ds-kpis">
        {v.indicadores.map((i) => (
          <KpiGer key={i.chave} label={i.label} valor={fmtValor(i.valor, i.unidade)} tom={i.semaforo} variacao={i.variacaoPct} maiorMelhor={i.maiorMelhor} />
        ))}
      </div>

      <Secao titulo="Painel de indicadores" subtitulo={`${resumo.verde} na meta · ${resumo.amarelo} em atenção · ${resumo.vermelho} fora da meta${resumo.cinza ? ` · ${resumo.cinza} sem dados` : ""}. Comparação com o período anterior de mesma duração.`}>
        <Tabela colunas={colunas} linhas={v.indicadores} chave={(i) => i.chave} />
        <p className="ger-nota">
          Semáforo: <Semaforo tom="verde" /> dentro da meta; <Semaforo tom="amarelo" /> até 10% fora da meta; <Semaforo tom="vermelho" /> além disso; <Semaforo tom="cinza" /> sem dados no período. Atingimento é quanto da meta foi alcançado (limitado a 150%).
        </p>
      </Secao>

      <Secao titulo="Metas e limites" subtitulo={`Valem para todas as telas e para os avisos no sino. Só Admin e Super admin alteram${podeEditar ? "." : "; fale com o administrador para ajustar."}`}>
        <FormMetas key={JSON.stringify(v.metas)} metas={v.metas} podeEditar={podeEditar} onEditar={() => setSalvas(false)} onSalvo={() => setSalvas(true)} />
        {salvas && (
          <p className="ger-nota" role="status">
            Metas salvas. As telas já usam os novos valores.
          </p>
        )}
      </Secao>
    </>
  );
}

function FormMetas({ metas, podeEditar, onEditar, onSalvo }: { metas: Metas; podeEditar: boolean; onEditar: () => void; onSalvo: () => void }) {
  const salvar = useSalvarMetas();
  const [valores, setValores] = useState<Record<keyof Metas, string>>(() => comoTexto(metas));
  const [erro, setErro] = useState<string | null>(null);
  const alteradas = CHAVES_METAS.filter((k) => valores[k] !== String(metas[k]));

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    if (alteradas.length === 0) return;
    const parcial: Partial<Metas> = {};
    for (const k of alteradas) {
      const n = Number(valores[k].replace(",", "."));
      if (valores[k].trim() === "" || !Number.isFinite(n) || n < 0) {
        setErro(`Valor inválido em "${METAS_ROTULOS[k].label}".`);
        return;
      }
      parcial[k] = n;
    }
    salvar.mutate(parcial, {
      onSuccess: onSalvo,
      onError: (err) => setErro(err instanceof ServiceError ? err.message : "Não foi possível salvar as metas. Tente de novo."),
    });
  };

  return (
    <form onSubmit={enviar}>
      <div className="ger-metas">
        {CHAVES_METAS.map((k) => (
          <label key={k}>
            <span>
              {METAS_ROTULOS[k].label} ({METAS_ROTULOS[k].unidade})
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={valores[k]}
              disabled={!podeEditar || salvar.isPending}
              onChange={(e) => {
                onEditar();
                setValores((s) => ({ ...s, [k]: e.target.value }));
              }}
            />
            <small>{METAS_ROTULOS[k].descricao}</small>
          </label>
        ))}
      </div>
      {podeEditar && (
        <div className="ger-acoes" style={{ marginTop: 14 }}>
          <button type="submit" className="btn btn--primary" disabled={salvar.isPending || alteradas.length === 0}>
            <Save size={16} aria-hidden="true" /> {salvar.isPending ? "Salvando…" : alteradas.length ? `Salvar ${alteradas.length} ${alteradas.length === 1 ? "alteração" : "alterações"}` : "Salvar metas"}
          </button>
          {alteradas.length > 0 && !salvar.isPending && (
            <button
              type="button"
              className="btn btn--outline"
              onClick={() => {
                setValores(comoTexto(metas));
                setErro(null);
              }}
            >
              Desfazer
            </button>
          )}
        </div>
      )}
      {erro && (
        <p className="ger-nota" role="alert">
          {erro}
        </p>
      )}
    </form>
  );
}
