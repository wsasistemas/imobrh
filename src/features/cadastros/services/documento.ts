// CPF/CNPJ: mesma regra de imobdesk.at_documento_valido (o banco confere de novo ao salvar).

export function documentoValido(doc: string): boolean {
  const d = doc.replace(/\D/g, "");
  if (d.length === 11) {
    if (/^(\d)\1{10}$/.test(d)) return false;
    const dv = (n: number) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
      const r = (s * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
  }
  if (d.length === 14) {
    if (/^(\d)\1{13}$/.test(d)) return false;
    const dv = (pesos: number[]) => {
      const s = pesos.reduce((acc, p, i) => acc + Number(d[i]) * p, 0) % 11;
      return s < 2 ? 0 : 11 - s;
    };
    return dv([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[12]) && dv([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[13]);
  }
  return false;
}
