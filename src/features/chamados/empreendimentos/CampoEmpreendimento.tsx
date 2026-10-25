import { useId, useMemo } from "react";
import { toast } from "sonner";
import { mensagem } from "../cadastros/comum";
import { ServicoBusca } from "../ticket/ServicoBusca";
import { useDefinirEmpreendimento, useEmpreendimentoDoTicket } from "./hooks";

const ORIGEM = { ia: "IA", manual: "Agente", solicitante: "Solicitante" } as const;

/**
 * Empreendimento na tela do ticket (setores que usam, ex.: CFTV). Salva na hora (fica no histórico), sem esperar a
 * ação. Sem empreendimento e com avaliação da IA: "Revisar empreendimento" e as sugestões em um clique.
 */
export function CampoEmpreendimento({ ticketId, bloqueado }: { ticketId: number; bloqueado: boolean }) {
  const rotuloId = useId();
  const q = useEmpreendimentoDoTicket(ticketId);
  const definir = useDefinirEmpreendimento();
  const opcoes = useMemo(() => (q.data?.opcoes ?? []).map((o) => ({ id: o.id, rotulo: o.nome })), [q.data]);
  if (!q.data?.usa) return null;
  const d = q.data;
  const atual = d.empreendimento;

  const trocar = (id: number | null) => {
    if (id === (atual?.id ?? null)) return;
    definir.mutate(
      { ticketId, empreendimentoId: id },
      { onSuccess: () => toast.success(id ? "Empreendimento definido" : "Empreendimento removido"), onError: (e) => toast.error(mensagem(e, "Não foi possível alterar o empreendimento.")) },
    );
  };

  return (
    <div className="field">
      <span className="field__label" id={rotuloId}>
        Empreendimento
        {atual && d.origem && (
          <span className={`ch-badge${d.origem === "ia" ? " ch-badge--info" : ""}`} style={{ marginLeft: 6 }}>
            {d.origem === "ia" && d.ia ? `IA ${d.ia.confianca}%` : ORIGEM[d.origem]}
          </span>
        )}
        {!atual && d.ia && (
          <span className="ch-badge ch-badge--warning" style={{ marginLeft: 6 }}>
            Revisar empreendimento
          </span>
        )}
      </span>
      <ServicoBusca rotuloId={rotuloId} item="empreendimento" opcoes={opcoes} valor={atual?.id ?? null} onChange={(id) => !bloqueado && trocar(id)} />
      {!atual && d.ia && d.ia.sugestoes.length > 0 && !bloqueado && (
        <span className="field__help">
          Sugestões da IA:{" "}
          {d.ia.sugestoes.map((s, i) => (
            <span key={s.id}>
              {i > 0 && " · "}
              <button type="button" className="tk-link" disabled={definir.isPending} onClick={() => trocar(s.id)}>
                {s.nome}
              </button>
            </span>
          ))}
        </span>
      )}
      {atual && (atual.cidade || atual.endereco || atual.observacao) && (
        <span className="field__help">{[atual.cidade, atual.endereco, atual.observacao].filter(Boolean).join(" · ")}</span>
      )}
      {d.ia?.motivo && (d.origem === "ia" || !atual) && <span className="field__help">IA: {d.ia.motivo}</span>}
    </div>
  );
}
