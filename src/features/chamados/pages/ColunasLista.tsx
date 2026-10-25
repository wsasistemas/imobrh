import * as Popover from "@radix-ui/react-popover";
import { Columns3 } from "lucide-react";
import { useState } from "react";
import { useListaExtras } from "../hooks";
import { SeletorColunas } from "../visoes/SeletorColunas";
import { AGRUPAMENTO_PADRAO } from "../visoes/seed";
import type { ColunaLista, Visao } from "../visoes/types";

// Botão "Colunas" da Lista (docs/PLANO-visoes-colunas.md, Fase 3; mockup aba 4): Admin e Super admin escolhem e
// ordenam as colunas; salva na visão, para todos que a usam.

export function ColunasLista({ visao, salvando, onSalvar }: { visao: Visao; salvando: boolean; onSalvar: (colunas: ColunaLista[], aoSalvar: () => void) => void }) {
  const [aberto, setAberto] = useState(false);
  const [rascunho, setRascunho] = useState<ColunaLista[]>(visao.agrupamento.colunas);
  const extras = useListaExtras(aberto);

  return (
    <Popover.Root
      open={aberto}
      onOpenChange={(o) => {
        setAberto(o);
        if (o) setRascunho(visao.agrupamento.colunas);
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className={`btn btn--outline${aberto ? " ch-btn--ativo" : ""}`}>
          <Columns3 size={16} aria-hidden="true" />
          Colunas
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="ch-colpop" align="end" sideOffset={6} collisionPadding={12} aria-label="Colunas da lista">
          <h3>Colunas da lista</h3>
          <p className="ch-hint">Marque e arraste para ordenar. Vale para todos que usam esta visão.</p>
          <SeletorColunas valor={rascunho} onChange={setRascunho} campos={extras.data?.campos ?? []} carregandoCampos={extras.isPending} />
          <div className="ch-colpop__rod">
            <button type="button" className="btn btn--outline" onClick={() => setRascunho(AGRUPAMENTO_PADRAO.colunas)}>
              Restaurar padrão
            </button>
            <button type="button" className="btn btn--primary" disabled={salvando} onClick={() => onSalvar(rascunho, () => setAberto(false))}>
              {salvando ? "Salvando…" : "Salvar"}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
