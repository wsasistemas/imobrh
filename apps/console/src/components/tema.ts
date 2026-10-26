/** Aparência: claro (padrão), escuro ou automático (segue o computador). */
export type Tema = "claro" | "escuro" | "auto";

// Aparência do ImobRH: claro (padrão), escuro ou automático (segue o computador).
// O <html data-tema> é o que o CSS lê; public/tema.js aplica o cache antes da primeira pintura.
const CHAVE = "imobrh:tema";
const consultaEscuro = () => window.matchMedia?.("(prefers-color-scheme: dark)");

export function temaGuardado(): Tema {
  try {
    const t = localStorage.getItem(CHAVE);
    return t === "escuro" || t === "auto" ? t : "claro";
  } catch {
    return "claro";
  }
}

let soltarAuto: (() => void) | null = null;

/** Aplica e guarda neste navegador. No automático, acompanha a troca de tema do computador. */
export function aplicarTema(tema: Tema) {
  try {
    localStorage.setItem(CHAVE, tema);
  } catch {
    // navegador sem armazenamento: vale só nesta visita
  }
  soltarAuto?.();
  soltarAuto = null;
  const pintar = () => {
    const escuro = tema === "escuro" || (tema === "auto" && Boolean(consultaEscuro()?.matches));
    document.documentElement.dataset.tema = escuro ? "escuro" : "claro";
  };
  pintar();
  const consulta = tema === "auto" ? consultaEscuro() : undefined;
  if (consulta) {
    consulta.addEventListener("change", pintar);
    soltarAuto = () => consulta.removeEventListener("change", pintar);
  }
}
