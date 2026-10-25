import { STORAGE_PREFIX } from "../../../config/app";
import type { Conversa, Setor } from "../services/tipos";

/** "5521981234455" → "+55 21 98123-4455". */
export function telefone(t: string): string {
  if (!/^\d{12,13}$/.test(t)) return t;
  return `+${t.slice(0, 2)} ${t.slice(2, 4)} ${t.slice(4, -4)}-${t.slice(-4)}`;
}

export function iniciais(nome: string | null): string {
  if (!nome) return "?";
  return nome.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

export function hora(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const hoje = new Date();
  if (d.toDateString() === hoje.toDateString()) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

/** Duração em "19min 07s" ou "1h 05min". */
export function duracao(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}min` : `${m}min ${String(s % 60).padStart(2, "0")}s`;
}

/** Segundos em "8 min" (indicadores). */
export function minutos(seg: number | null): string {
  if (seg === null) return "—";
  if (seg < 60) return `${Math.round(seg)} s`;
  const m = Math.round(seg / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}` : `${m} min`;
}

export type Situacao = "fila" | "comigo" | "outro" | "fim";

/** Situação vista por quem está logado (a mesma conversa "com atendente" é "comigo" para um e "outro" para o resto). */
export function situacao(c: Conversa, eu: string | null): Situacao {
  if (c.modo === "encerrada") return "fim";
  if (c.modo === "atendente") return c.atendenteId === eu ? "comigo" : "outro";
  return "fila";
}

export const SITUACAO_SELO: Record<Situacao, string> = { fila: "s-fila", comigo: "s-comigo", outro: "s-outro", fim: "s-fim" };

export function rotuloSituacao(c: Conversa, eu: string | null): string {
  const s = situacao(c, eu);
  if (s === "outro") return c.atendenteNome ?? "Outro atendente";
  return { fila: "Na fila", comigo: "Comigo", fim: "Encerrada" }[s];
}

/** O usuário gerencia o setor (gestor ou supervisão geral). */
export const gerencia = (s: Setor | undefined) => s?.papel === "gestor" || s?.papel === "supervisor";

export function ler(chave: string): string {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}:${chave}`) ?? "";
  } catch {
    return "";
  }
}

export function gravar(chave: string, valor: string) {
  try {
    if (valor) localStorage.setItem(`${STORAGE_PREFIX}:${chave}`, valor);
    else localStorage.removeItem(`${STORAGE_PREFIX}:${chave}`);
  } catch {
    // sem storage: só não fica lembrado
  }
}

export const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
