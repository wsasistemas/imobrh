import { X } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";
import { useAccess } from "../../configuracoes/access/useAccess";
import { ServiceError } from "../../configuracoes/services/types";
import { useEquipes, useEquipesDoUsuario, useSalvarEquipesDoUsuario } from "../hooks/useCadastros";
import "./Cadastros.css";

/**
 * Campo "Equipes" no painel Editar usuário. Grava na hora (é o mesmo vínculo da seção Usuários › Equipes),
 * sem esperar o "Salvar alterações" do usuário.
 */
export function EquipesDoUsuario({ usuarioId }: { usuarioId: string }) {
  const { hasPermission } = useAccess();
  const pode = hasPermission("manage_users") || hasPermission("manage_users_equipes");
  const ids = useId();
  const equipes = useEquipes(pode);
  const minhas = useEquipesDoUsuario(usuarioId);
  const salvar = useSalvarEquipesDoUsuario();
  if (!pode) return null;

  const atuais = minhas.data ?? [];
  const todas = equipes.data ?? [];
  const trocar = (novas: number[]) =>
    salvar.mutate({ usuarioId, equipes: novas }, { onSuccess: () => toast.success("Equipes do usuário atualizadas"), onError: (e) => toast.error(e instanceof ServiceError ? e.message : "Não foi possível alterar as equipes.") });

  return (
    <div className="field">
      <label className="field__label" htmlFor={`${ids}-eq`}>Equipes</label>
      {atuais.length > 0 ? (
        <div className="ca-chips">
          {atuais.map((id) => {
            const e = todas.find((x) => x.id === id);
            return (
              <span key={id} className="ca-chip">
                {e ? `${e.nome}${e.setorNome ? ` · ${e.setorNome}` : ""}` : `Equipe ${id}`}
                <button type="button" aria-label={`Tirar da equipe ${e?.nome ?? id}`} disabled={salvar.isPending} onClick={() => trocar(atuais.filter((x) => x !== id))}>
                  <X size={13} aria-hidden="true" />
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <span className="field__help">{minhas.isPending ? "Carregando…" : "Este usuário ainda não está em nenhuma equipe."}</span>
      )}
      <select id={`${ids}-eq`} className="input" value="" disabled={salvar.isPending || equipes.isPending} onChange={(e) => e.target.value && trocar([...atuais, Number(e.target.value)])}>
        <option value="">Adicionar equipe…</option>
        {todas
          .filter((e) => e.ativa && !atuais.includes(e.id))
          .map((e) => (
            <option key={e.id} value={e.id}>{e.nome}{e.setorNome ? ` · ${e.setorNome}` : ""}</option>
          ))}
      </select>
      <span className="field__help">A mudança nas equipes é gravada na hora.</span>
    </div>
  );
}
