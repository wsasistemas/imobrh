import { Check, Circle, X } from "lucide-react";
import { PASSWORD_RULES } from "../configuracoes/access/passwordRules";
import "./authCard.css";

export type RuleState = "ok" | "fail" | "pending";

export interface ExtraRule {
  id: string;
  label: string;
  state: RuleState;
}

interface PasswordChecklistProps {
  id: string;
  password: string;
  /** Regras que só o serviço confere (ex.: diferente da temporária). */
  extraRules?: ExtraRule[];
}

/** Checklist ao vivo das regras de senha: vazio fica pendente; digitado, verde ou vermelho. */
export function PasswordChecklist({ id, password, extraRules = [] }: PasswordChecklistProps) {
  const items: ExtraRule[] = [
    ...PASSWORD_RULES.map((rule) => ({
      id: rule.id,
      label: rule.label,
      state: (rule.test(password) ? "ok" : password ? "fail" : "pending") as RuleState,
    })),
    ...extraRules,
  ];

  return (
    <ul id={id} className="password-rules" aria-live="polite" aria-label="Requisitos da senha">
      {items.map((rule) => (
        <li key={rule.id} className={`password-rules__item password-rules__item--${rule.state}`}>
          {rule.state === "ok" && <Check size={14} aria-hidden="true" />}
          {rule.state === "fail" && <X size={14} aria-hidden="true" />}
          {rule.state === "pending" && <Circle size={14} aria-hidden="true" />}
          <span>{rule.label}</span>
          <span className="visually-hidden">
            {rule.state === "ok" ? "(atendido)" : rule.state === "fail" ? "(não atendido)" : "(pendente)"}
          </span>
        </li>
      ))}
    </ul>
  );
}
