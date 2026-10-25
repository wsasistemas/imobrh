import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { usePreferencias, useSalvarTema } from "./hooks";
import type { Tema } from "./service";
import { aplicarTema, temaGuardado } from "./tema";

const OPCOES: { tema: Tema; rotulo: string; Icone: typeof Sun }[] = [
  { tema: "claro", rotulo: "Claro", Icone: Sun },
  { tema: "escuro", rotulo: "Escuro", Icone: Moon },
  { tema: "auto", rotulo: "Automático (do computador)", Icone: Monitor },
];

/** Botão Aparência do topo: claro, escuro ou automático. A escolha fica salva no login (vale em qualquer navegador). */
export function MenuAparencia({ ativo }: { ativo: boolean }) {
  const preferencias = usePreferencias(ativo);
  const salvar = useSalvarTema();
  const [tema, setTema] = useState<Tema>(temaGuardado);

  // O que está salvo no login vence o cache deste navegador.
  const salvo = preferencias.data?.tema;
  useEffect(() => {
    if (salvo && salvo !== temaGuardado()) {
      aplicarTema(salvo);
      setTema(salvo);
    }
  }, [salvo]);

  const escolher = (novo: Tema) => {
    aplicarTema(novo);
    setTema(novo);
    salvar.mutate(novo, { onError: () => toast.error("A aparência mudou só neste navegador: não foi possível salvar no seu login.") });
  };

  const Atual = OPCOES.find((o) => o.tema === tema)?.Icone ?? Sun;
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="topbar__icon-button" aria-label="Aparência" title="Aparência">
          <Atual size={18} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="menu">
          <DropdownMenu.Label className="menu__titulo">Aparência</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={tema} onValueChange={(v) => escolher(v as Tema)}>
            {OPCOES.map(({ tema: valor, rotulo, Icone }) => (
              <DropdownMenu.RadioItem key={valor} value={valor} className="menu__item menu__item--alto">
                <Icone size={16} aria-hidden="true" />
                <span className="menu__texto">{rotulo}</span>
                <DropdownMenu.ItemIndicator>
                  <Check size={16} aria-hidden="true" className="menu__check" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="menu__separator" />
          <p className="menu__nota">A escolha fica salva no seu login.</p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
