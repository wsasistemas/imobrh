import { CheckCircle2, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { getMenuItem } from "../../../config/menuRegistry";
import { useContexto, useConversas, useTempoReal } from "../hooks/useAtendimento";
import { Chat } from "./Central";
import { EncerrarConversa } from "./EncerrarConversa";
import { gerencia, situacao } from "./util";
import "./Atendimento.css";

/**
 * Tela do ticket de WhatsApp (mockup tela 4): a conversa ao vivo do atendimento deste ticket, para responder
 * sem sair do ticket. Só aparece para quem vê a conversa (atendente do setor ou gestão) e enquanto ela está aberta.
 */
export function ConversaAoVivo({ ticketId }: { ticketId: number }) {
  const ctx = useContexto();
  const conversas = useConversas();
  useTempoReal();
  const [encerrar, setEncerrar] = useState(false);
  const c = (conversas.data ?? []).find((x) => x.ticket === ticketId && (x.modo === "fila" || x.modo === "atendente"));
  if (!ctx.data || !c) return null;
  const setor = ctx.data.setores.find((s) => s.id === c.setorId);
  const s = situacao(c, ctx.data.eu);
  const podeEncerrar = s === "comigo" || (gerencia(setor) && s !== "fim");

  return (
    <section className="card at-ao-vivo" aria-label="Conversa ao vivo no WhatsApp">
      <Chat c={c} eu={ctx.data.eu} setor={setor} />
      <div className="at-ao-vivo__rodape">
        <Link className="btn btn--outline btn--sm" to={`${getMenuItem("gestao_atendimento_central").path}?conversa=${c.id}`}>
          <MessagesSquare size={14} aria-hidden="true" />
          Abrir em Conversas
        </Link>
        {podeEncerrar && (
          <button type="button" className="btn btn--danger-outline btn--sm" onClick={() => setEncerrar(true)}>
            <CheckCircle2 size={14} aria-hidden="true" />
            Encerrar conversa
          </button>
        )}
      </div>
      <EncerrarConversa c={c} setor={setor} open={encerrar} onOpenChange={setEncerrar} />
    </section>
  );
}
