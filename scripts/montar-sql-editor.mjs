// Junta supabase/migrations em partes para colar no SQL Editor do ikvj (o projeto é compartilhado: nada de db push).
// Cada parte roda numa transação: se der erro, nada daquela parte fica gravado. Rode as partes na ordem.
// Uso: node scripts/montar-sql-editor.mjs                 → 1_estrutura_parte*.sql (banco novo, do zero)
//      node scripts/montar-sql-editor.mjs --desde <prefixo> → atualizacao_<prefixo>.sql (só as migrations novas,
//                                                             para um banco que já rodou as partes anteriores)
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIGEM = "supabase/migrations";
const DESTINO = "supabase/sql-editor";
const LIMITE = 350_000; // caracteres por parte (o SQL Editor fica lento com scripts muito grandes)

const i = process.argv.indexOf("--desde");
const desde = i > 0 ? process.argv[i + 1] : "";
const arquivos = readdirSync(ORIGEM).filter((n) => n.endsWith(".sql") && n >= desde).sort();

const partes = [];
let atual = [];
let tamanho = 0;
for (const nome of arquivos) {
  const sql = readFileSync(join(ORIGEM, nome), "utf8");
  if (tamanho + sql.length > LIMITE && atual.length) {
    partes.push(atual);
    atual = [];
    tamanho = 0;
  }
  atual.push({ nome, sql });
  tamanho += sql.length;
}
if (atual.length) partes.push(atual);

mkdirSync(DESTINO, { recursive: true });
if (!desde) for (const velho of readdirSync(DESTINO)) if (/^1_estrutura_parte\d+\.sql$/.test(velho)) rmSync(join(DESTINO, velho));
partes.forEach((parte, n) => {
  const corpo = parte.map((m) => `-- ======================================== ${m.nome}\n${m.sql.trim()}\n`).join("\n");
  const cabecalho = `-- Imobdesk · parte ${n + 1} de ${partes.length} (${parte[0].nome} … ${parte.at(-1).nome}).\n-- Cole no SQL Editor do ikvj e rode. Tudo numa transação.\n`;
  const nome = desde ? `atualizacao_${desde}${partes.length > 1 ? `_parte${n + 1}` : ""}.sql` : `1_estrutura_parte${n + 1}.sql`;
  writeFileSync(join(DESTINO, nome), `${cabecalho}begin;\n\n${corpo}\ncommit;\n`);
});
console.log(`${arquivos.length} migrations em ${partes.length} parte(s) em ${DESTINO}.`);
