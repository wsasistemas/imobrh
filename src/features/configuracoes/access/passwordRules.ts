// Regras da senha pessoal, usadas pelo checklist ao vivo e pela validação do serviço.
// "Diferente da temporária" só o serviço verifica: a senha temporária nunca chega ao navegador.

export interface PasswordRule {
  id: "length" | "uppercase" | "number";
  label: string;
  test: (value: string) => boolean;
}

export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_RULES: readonly PasswordRule[] = [
  { id: "length", label: `Pelo menos ${MIN_PASSWORD_LENGTH} caracteres`, test: (value) => value.length >= MIN_PASSWORD_LENGTH },
  { id: "uppercase", label: "Uma letra maiúscula", test: (value) => /\p{Lu}/u.test(value) },
  { id: "number", label: "Um número", test: (value) => /\d/.test(value) },
];

export function meetsPasswordRules(value: string): boolean {
  return PASSWORD_RULES.every((rule) => rule.test(value));
}
