import { useState, type FormEvent } from "react";
import { DetailDialog } from "./DetailDialog";

export interface TicketService {
  id: number;
  name: string;
  team: string;
  /** SLA de solução em horas úteis. */
  slaHours: number;
}

export interface NewTicketInput {
  subject: string;
  requester: string;
  serviceId: number;
  description: string;
}

interface NewTicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  services: readonly TicketService[];
  onSubmit: (input: NewTicketInput) => void;
  /** Aviso abaixo da caixa de direcionamento. */
  disclaimer?: string;
  submitLabel?: string;
}

export function NewTicketDialog({ open, onOpenChange, services, onSubmit, disclaimer, submitLabel = "Criar ticket" }: NewTicketDialogProps) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? 0);
  const service = services.find((s) => s.id === serviceId);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit({
      subject: String(form.get("subject") ?? "").trim(),
      requester: String(form.get("requester") ?? "").trim(),
      description: String(form.get("description") ?? "").trim(),
      serviceId,
    });
    event.currentTarget.reset();
    setServiceId(services[0]?.id ?? 0);
  }

  return (
    <DetailDialog
      open={open}
      onOpenChange={onOpenChange}
      eyebrow="ABERTURA DE SOLICITAÇÃO"
      title="Como podemos ajudar?"
      description="Selecione o serviço para direcionar o atendimento."
      closeLabel="Fechar formulário"
    >
      <form className="ds-form" onSubmit={handleSubmit}>
        <label>
          Assunto
          <input name="subject" required maxLength={140} placeholder="Resuma o que você precisa" />
        </label>
        <div className="ds-formrow">
          <label>
            Solicitante
            <input name="requester" required maxLength={80} placeholder="Nome completo" />
          </label>
          <label>
            Serviço
            <select name="service" value={serviceId} onChange={(event) => setServiceId(Number(event.target.value))}>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Descrição
          <textarea name="description" required placeholder="Descreva a solicitação, o impacto e eventuais mensagens de erro." />
        </label>
        {service && (
          <div className="ds-hint" aria-live="polite">
            Direcionamento: {service.team} · Prioridade normal · SLA de solução: {service.slaHours}h úteis (exemplo).
          </div>
        )}
        {disclaimer && <p className="ds-small ds-muted">{disclaimer}</p>}
        <div className="ds-row ds-form__actions">
          <button type="button" className="ds-btn" onClick={() => onOpenChange(false)}>
            Cancelar
          </button>
          <button type="submit" className="ds-btn ds-btn--primary">
            {submitLabel}
          </button>
        </div>
      </form>
    </DetailDialog>
  );
}
