import { ESTADOS_CASO, ESTADOS_ETAPA, type EstadoCaso, type EstadoEtapa } from "@imobrh/shared";
import type { PillTone } from "./Pill";

// Mapa único de cor e rótulo dos estados de caso e de etapa (PRD v2, Design system): toda tela usa estes dois
// mapas, nunca uma cor própria. Os rótulos vêm do contrato da API (packages/shared).

export const TOM_ESTADO_CASO: Record<EstadoCaso, PillTone> = {
  aberto: "blue",
  em_andamento: "blue",
  aguardando_colaborador: "amber",
  aguardando_terceiro: "amber",
  concluido: "green",
  cancelado: "neutral",
};

export const TOM_ESTADO_ETAPA: Record<EstadoEtapa, PillTone> = {
  bloqueada: "neutral",
  aberta: "blue",
  em_andamento: "blue",
  concluida: "green",
  atrasada: "red",
  erro_rm: "red",
};

export function estadoCaso(estado: EstadoCaso): { rotulo: string; tom: PillTone } {
  return { rotulo: ESTADOS_CASO[estado], tom: TOM_ESTADO_CASO[estado] };
}

export function estadoEtapa(estado: EstadoEtapa): { rotulo: string; tom: PillTone } {
  return { rotulo: ESTADOS_ETAPA[estado], tom: TOM_ESTADO_ETAPA[estado] };
}

/** Prazo legal em texto + tom: vencido (vermelho), até 3 dias (âmbar), depois (azul). Nunca só a cor. */
export function prazoRelativo(venceEm: string, hoje = new Date()): { texto: string; tom: PillTone; dias: number } {
  const umDia = 86_400_000;
  const inicio = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const dias = Math.round((inicio(new Date(venceEm)) - inicio(hoje)) / umDia);
  if (dias < 0) return { texto: `Vencido há ${-dias} ${dias === -1 ? "dia" : "dias"}`, tom: "red", dias };
  if (dias === 0) return { texto: "Vence hoje", tom: "red", dias };
  if (dias <= 3) return { texto: `Vence em ${dias} ${dias === 1 ? "dia" : "dias"}`, tom: "amber", dias };
  return { texto: `Vence em ${dias} dias`, tom: "blue", dias };
}
