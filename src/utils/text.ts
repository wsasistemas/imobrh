/** Minúsculas, sem acentos e sem espaços nas pontas, para buscas e comparações. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}
