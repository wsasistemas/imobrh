import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Lock } from "lucide-react";
import { useState } from "react";
import { COLUNAS_LISTA, ehCampoAdicional, rotuloColuna } from "./campos";
import type { CampoColuna, ColunaLista, ColunaPadrao } from "./types";

// Escolha e ordem das colunas da Lista (docs/PLANO-visoes-colunas.md, Fase 3; mockup aba 4). Usado no botão "Colunas"
// da Lista e na aba Agrupamento de Configurar visões. "Nº e assunto" é sempre a primeira coluna.

interface Props {
  valor: ColunaLista[];
  onChange: (colunas: ColunaLista[]) => void;
  campos: CampoColuna[];
  /** Campos adicionais ainda carregando (mostra o aviso no grupo). */
  carregandoCampos?: boolean;
}

export function SeletorColunas({ valor, onChange, campos, carregandoCampos = false }: Props) {
  const [busca, setBusca] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const termo = busca.trim().toLowerCase();
  const casa = (c: ColunaLista) => !termo || rotuloColuna(c, campos).toLowerCase().includes(termo);
  const marcar = (c: ColunaLista) => onChange([...valor, c]);
  const desmarcar = (c: ColunaLista) => onChange(valor.filter((x) => x !== c));
  const fim = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    onChange(arrayMove(valor, valor.indexOf(e.active.id as ColunaLista), valor.indexOf(e.over.id as ColunaLista)));
  };
  const padraoLivres = (Object.keys(COLUNAS_LISTA) as ColunaPadrao[]).filter((c) => !valor.includes(c) && casa(c));
  const camposLivres = campos.map((c) => `campo:${c.chave}` as ColunaLista).filter((c) => !valor.includes(c) && casa(c));
  const tipoDe = (c: ColunaLista) => (ehCampoAdicional(c) ? campos.find((x) => `campo:${x.chave}` === c) : undefined);

  return (
    <div className="ch-selcol">
      <input className="input" type="search" placeholder="Buscar campo…" aria-label="Buscar campo" value={busca} onChange={(e) => setBusca(e.target.value)} />
      <div className="ch-selcol__grp">Na lista (arraste para ordenar)</div>
      <div className="ch-selcol__it ch-selcol__it--fixo">
        <Lock size={14} aria-hidden="true" />
        Nº e assunto
        <small>fixa</small>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={fim}>
        <SortableContext items={valor} strategy={verticalListSortingStrategy}>
          {valor.filter(casa).map((c) => (
            <ItemOrdenavel key={c} id={c} rotulo={rotuloColuna(c, campos)} campo={tipoDe(c)} adicional={ehCampoAdicional(c)} onDesmarcar={() => desmarcar(c)} />
          ))}
        </SortableContext>
      </DndContext>
      {padraoLivres.length > 0 && <div className="ch-selcol__grp">Campos do ticket</div>}
      {padraoLivres.map((c) => (
        <label key={c} className="ch-selcol__it">
          <input type="checkbox" checked={false} onChange={() => marcar(c)} />
          {COLUNAS_LISTA[c]}
        </label>
      ))}
      <div className="ch-selcol__grp">Campos adicionais</div>
      {carregandoCampos ? (
        <p className="ch-hint">Carregando…</p>
      ) : camposLivres.length === 0 ? (
        <p className="ch-hint">{campos.length === 0 ? 'Nenhum campo adicional com "Usar em visões" no cadastro.' : "Todos já estão na lista."}</p>
      ) : (
        camposLivres.map((c) => {
          const def = tipoDe(c);
          return (
            <label key={c} className="ch-selcol__it">
              <input type="checkbox" checked={false} onChange={() => marcar(c)} />
              {rotuloColuna(c, campos)}
              <small className="ch-badge">{def?.interno ? "interno" : "campo"}</small>
            </label>
          );
        })
      )}
    </div>
  );
}

function ItemOrdenavel({ id, rotulo, campo, adicional, onDesmarcar }: { id: ColunaLista; rotulo: string; campo?: CampoColuna; adicional: boolean; onDesmarcar: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`ch-selcol__it${isDragging ? " ch-selcol__it--arrastando" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button type="button" className="ch-selcol__alca" aria-label={`Mover ${rotulo}`} {...attributes} {...listeners}>
        <GripVertical size={14} aria-hidden="true" />
      </button>
      <label className="ch-selcol__marca">
        <input type="checkbox" checked onChange={onDesmarcar} />
        {rotulo}
      </label>
      {adicional && <small className="ch-badge">{campo?.interno ? "interno" : "campo"}</small>}
    </div>
  );
}
