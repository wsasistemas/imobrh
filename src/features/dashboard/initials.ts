/** Iniciais do avatar: primeira letra do primeiro e do último nome ("Ana Lima" → "AL"; "Wagner" → "W"). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
