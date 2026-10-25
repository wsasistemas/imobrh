import { useId } from "react";
import { toast } from "sonner";
import { mensagem } from "../cadastros/comum";
import { A_IDENTIFICAR, useDefinirSetorNoTicket, useSetoresOpcoes } from "../setorSolicitante";
import type { TicketDetalhe } from "./types";

/**
 * Setor do solicitante na tela do ticket. Salva na hora (fica no histórico) e vale também para o cadastro da pessoa.
 * Sem setor: "A identificar".
 */
export function CampoSetorSolicitante({ d, bloqueado }: { d: TicketDetalhe; bloqueado: boolean }) {
  const id = useId();
  const opcoes = useSetoresOpcoes();
  const definir = useDefinirSetorNoTicket();
  const atual = d.setorSolicitanteId;
  const lista = (opcoes.data ?? []).filter((s) => s.id !== atual);
  if (atual !== null) lista.push({ id: atual, nome: d.setorSolicitante ?? "Setor atual", recebeChamados: false });
  lista.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  const trocar = (v: string) => {
    const novo = v ? Number(v) : null;
    if (novo === atual) return;
    definir.mutate(
      { ticketId: d.id, setorId: novo },
      {
        onSuccess: () => toast.success(novo ? `Setor do solicitante: ${lista.find((s) => s.id === novo)?.nome}` : "Setor do solicitante removido"),
        onError: (e) => toast.error(mensagem(e, "Não foi possível alterar o setor.")),
      },
    );
  };

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        Setor
        {atual === null && (
          <span className="ch-badge ch-badge--warning" style={{ marginLeft: 6 }}>
            {A_IDENTIFICAR}
          </span>
        )}
      </label>
      <select id={id} className="input" value={atual ?? ""} disabled={bloqueado || definir.isPending || opcoes.isPending} onChange={(e) => trocar(e.target.value)}>
        <option value="">{A_IDENTIFICAR}</option>
        {lista.map((s) => (
          <option key={s.id} value={s.id}>
            {s.nome}
          </option>
        ))}
      </select>
      <span className="field__help">
        Setor de quem abriu o chamado{d.solicitante.pessoaId ? "; ao trocar, o cadastro da pessoa também muda" : ""}.
      </span>
    </div>
  );
}
