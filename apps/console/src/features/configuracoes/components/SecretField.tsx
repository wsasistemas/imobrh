import { KeyRound } from "lucide-react";
import { useId, useState } from "react";
import { formatDate } from "../../../utils/dates";
import "./SecretField.css";

interface SecretFieldProps {
  label: string;
  /** Máscara vinda do serviço (ex.: "re_••••"); o valor real nunca chega ao navegador. */
  masked: string | null;
  setAt: string | null;
  setBy: string | null;
  isSaving: boolean;
  /** Resolve true quando a chave foi salva, para fechar o campo. */
  onReplace: (secret: string) => Promise<boolean>;
}

/** Regra 9: segredo só de escrita. "Substituir chave" abre um campo vazio e nunca mostra o valor antigo. */
export function SecretField({ label, masked, setAt, setBy, isSaving, onReplace }: SecretFieldProps) {
  const ids = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  const close = () => {
    setEditing(false);
    setValue("");
  };

  const save = async () => {
    if (await onReplace(value.trim())) close();
  };

  return (
    <div className="field">
      <span className="field__label">{label}</span>

      {!editing ? (
        <div className="secret-field">
          <KeyRound size={16} aria-hidden="true" />
          <div className="secret-field__info">
            <code>{masked ?? "Nenhuma chave salva"}</code>
            {setAt && (
              <span>
                Salva em {formatDate(setAt)}
                {setBy ? ` por ${setBy}` : ""}
              </span>
            )}
          </div>
          <button type="button" className="btn btn--outline" onClick={() => setEditing(true)}>
            Substituir chave
          </button>
        </div>
      ) : (
        <div className="secret-field secret-field--editing">
          <label htmlFor={`${ids}-new`} className="visually-hidden">
            Nova chave
          </label>
          <input
            id={`${ids}-new`}
            type="password"
            className="input input--sm"
            placeholder="Cole a nova chave"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button type="button" className="btn btn--outline" disabled={isSaving} onClick={close}>
            Cancelar
          </button>
          <button type="button" className="btn btn--primary" disabled={isSaving || !value.trim()} onClick={() => void save()}>
            {isSaving ? "Salvando…" : "Salvar chave"}
          </button>
        </div>
      )}
      <span className="field__help">A chave atual nunca é exibida. Ao substituir, a anterior deixa de valer.</span>
    </div>
  );
}
