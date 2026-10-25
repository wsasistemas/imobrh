import { Building2 } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { ServiceError } from "../configuracoes/services/types";
import { useMinhasEmpresas, useTrocarEmpresa } from "./hooks";
import "./empresas.css";

/** Empresa aberta no topo. Com mais de uma empresa (ou para o Super admin da WSA), vira seletor. */
export function SeletorEmpresa({ ativo }: { ativo: boolean }) {
  const id = useId();
  const empresas = useMinhasEmpresas(ativo);
  const trocar = useTrocarEmpresa();
  const lista = empresas.data ?? [];
  const atual = lista.find((e) => e.atual) ?? lista[0];
  if (!atual) return null;

  if (lista.length === 1) {
    return (
      <span className="empresa-atual" title="Empresa aberta">
        <span className="empresa-atual__ponto" aria-hidden="true" />
        <span className="empresa-atual__nome">{atual.nome}</span>
      </span>
    );
  }

  return (
    <label className="empresa-atual empresa-atual--seletor" htmlFor={id} title="Trocar de empresa">
      <Building2 size={15} aria-hidden="true" />
      <span className="visually-hidden">Empresa aberta</span>
      <select
        id={id}
        value={atual.id}
        disabled={trocar.isPending}
        onChange={(event) =>
          trocar.mutate(event.target.value, {
            onError: (error) => toast.error(error instanceof ServiceError ? error.message : "Não foi possível trocar de empresa."),
          })
        }
      >
        {lista.map((e) => (
          <option key={e.id} value={e.id}>
            {e.nome}
          </option>
        ))}
      </select>
    </label>
  );
}
