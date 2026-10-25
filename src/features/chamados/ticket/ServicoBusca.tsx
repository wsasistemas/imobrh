import { X } from "lucide-react";
import { useId, useMemo, useState } from "react";

// Serviço com busca rápida: ao digitar, a lista filtra (todas as palavras, sem acento) e o primeiro resultado fica
// destacado; Enter, Tab ou sair do campo seleciona. Setas mudam o destaque; Esc desfaz a digitação.

export interface OpcaoServico {
  id: number;
  rotulo: string; // caminho completo: "T.I. - Infraestrutura › Incidente › Impressora"
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Filtra por todas as palavras; quem tem o último nível começando pela busca vem primeiro. */
export function filtrarServicos(opcoes: readonly OpcaoServico[], busca: string, limite = 60): OpcaoServico[] {
  const termos = norm(busca).split(/\s+/).filter(Boolean);
  if (termos.length === 0) return opcoes.slice(0, limite);
  const folha = (o: OpcaoServico) => norm(o.rotulo.split("›").pop() ?? o.rotulo).trim();
  return opcoes
    .filter((o) => termos.every((t) => norm(o.rotulo).includes(t)))
    .sort((a, b) => Number(folha(b).startsWith(termos[0])) - Number(folha(a).startsWith(termos[0])))
    .slice(0, limite);
}

/** `item`: o que se busca ("serviço", "empreendimento"), nos textos do campo. */
export function ServicoBusca({ opcoes, valor, onChange, rotuloId, item = "serviço" }: { opcoes: OpcaoServico[]; valor: number | null; onChange: (id: number | null) => void; rotuloId: string; item?: string }) {
  const listaId = useId();
  const atual = opcoes.find((o) => o.id === valor);
  const [busca, setBusca] = useState<string | null>(null); // null = mostrando o selecionado
  const [aberto, setAberto] = useState(false);
  const [ativo, setAtivo] = useState(0);
  const lista = useMemo(() => filtrarServicos(opcoes, busca ?? ""), [opcoes, busca]);

  const escolher = (o: OpcaoServico | undefined) => {
    if (o) onChange(o.id);
    setBusca(null);
    setAberto(false);
  };

  return (
    <div className="tk-busca">
      <input
        className="input"
        role="combobox"
        aria-labelledby={rotuloId}
        aria-expanded={aberto}
        aria-controls={listaId}
        aria-autocomplete="list"
        aria-activedescendant={aberto && lista[ativo] ? `${listaId}-${lista[ativo].id}` : undefined}
        placeholder={`Digite para buscar o ${item}…`}
        value={busca ?? atual?.rotulo ?? ""}
        onFocus={(e) => {
          e.currentTarget.select();
          setAberto(true);
        }}
        onChange={(e) => {
          setBusca(e.target.value);
          setAtivo(0);
          setAberto(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setAberto(true);
            setAtivo((a) => (lista.length ? (a + (e.key === "ArrowDown" ? 1 : -1) + lista.length) % lista.length : 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (aberto) escolher(lista[ativo]);
          } else if (e.key === "Tab" && busca) {
            escolher(lista[ativo]);
          } else if (e.key === "Escape") {
            setBusca(null);
            setAberto(false);
          }
        }}
        onBlur={() => (busca ? escolher(lista[ativo]) : setAberto(false))}
      />
      {valor !== null && (
        <button type="button" className="tk-busca__limpar" aria-label={`Limpar ${item}`} onMouseDown={(e) => e.preventDefault()} onClick={() => onChange(null)}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
      {aberto && (
        <ul className="tk-busca__lista" id={listaId} role="listbox">
          {lista.length === 0 && <li className="tk-busca__vazio">Nenhum {item} com “{busca}”.</li>}
          {lista.map((o, i) => (
            <li
              key={o.id}
              id={`${listaId}-${o.id}`}
              role="option"
              aria-selected={i === ativo}
              className={o.id === valor ? "is-atual" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setAtivo(i)}
              onClick={() => escolher(o)}
            >
              {o.rotulo}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
