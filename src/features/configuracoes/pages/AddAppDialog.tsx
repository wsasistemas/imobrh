import * as Dialog from "@radix-ui/react-dialog";
import { AppWindow, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAddApp } from "../hooks/useAppAccess";
import { ServiceError } from "../services/types";
import "../../auth/authCard.css";
import "../../auth/ChangeOwnPasswordDialog.css";
import "../users/TempPasswordDialog.css";

/**
 * "Adicionar aplicativo": sistema com chave própria sobre um schema compartilhado (ex.: o Financeiro,
 * que usa o public). Os aplicativos de schema próprio aparecem sozinhos, sem passar por aqui.
 */
export function AddAppDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (key: string) => void }) {
  const add = useAddApp();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [dataSchema, setDataSchema] = useState("public");
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    add.mutate(
      { key, name, url, dataSchema },
      {
        onSuccess: () => {
          toast.success(`Aplicativo ${name} adicionado · controle desligado até você ligar`);
          onAdded(key.trim().toLowerCase());
          setKey("");
          setName("");
          setUrl("");
          onClose();
        },
        onError: (failure) =>
          setError(
            failure instanceof ServiceError
              ? { field: failure.field, message: failure.message }
              : { message: "Não foi possível adicionar o aplicativo." },
          ),
      },
    );
  };

  const fieldError = (field: string) =>
    error && error.field === field ? (
      <span className="field__error" role="alert">
        {error.message}
      </span>
    ) : null;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && !add.isPending && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="card change-password">
          <div className="change-password__head">
            <span className="change-password__icon" aria-hidden="true">
              <AppWindow size={18} />
            </span>
            <div>
              <Dialog.Title>Adicionar aplicativo</Dialog.Title>
              <Dialog.Description>
                Para sistemas que dividem um schema com outros (ex.: o Financeiro usa o <code>public</code>). Schemas
                próprios aparecem sozinhos na lista.
              </Dialog.Description>
            </div>
            <Dialog.Close className="icon-btn" aria-label="Fechar">
              <X size={16} />
            </Dialog.Close>
          </div>
          <form className="change-password__body" onSubmit={submit} noValidate>
            <div className="field">
              <label className="field__label" htmlFor="new-app-key">
                Chave
              </label>
              <input
                id="new-app-key"
                className="input app-access__mono"
                value={key}
                placeholder="ex.: financeiro"
                onChange={(event) => setKey(event.target.value)}
              />
              {fieldError("key") ?? <span className="field__help">É o valor que o site usa em pode_acessar_app("chave").</span>}
            </div>
            <div className="field">
              <label className="field__label" htmlFor="new-app-name">
                Nome
              </label>
              <input id="new-app-name" className="input" value={name} onChange={(event) => setName(event.target.value)} />
              {fieldError("name")}
            </div>
            <div className="field">
              <label className="field__label" htmlFor="new-app-url">
                Endereço (URL)
              </label>
              <input
                id="new-app-url"
                className="input app-access__mono"
                value={url}
                placeholder="ex.: financeiro.suaempresa.com.br"
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="new-app-schema">
                Schema de dados
              </label>
              <input
                id="new-app-schema"
                className="input app-access__mono"
                value={dataSchema}
                onChange={(event) => setDataSchema(event.target.value)}
              />
              {fieldError("dataSchema")}
            </div>
            {error && !error.field && (
              <p className="field__error" role="alert">
                {error.message}
              </p>
            )}
            <div className="temp-password__actions">
              <Dialog.Close asChild>
                <button type="button" className="btn btn--outline" disabled={add.isPending}>
                  Cancelar
                </button>
              </Dialog.Close>
              <button type="submit" className="btn btn--primary" disabled={add.isPending}>
                {add.isPending ? "Adicionando…" : "Adicionar"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
