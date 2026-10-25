// Solicitações Financeiras no app (Fase 6): rascunho guardado no aparelho quando não há rede. Fica no IndexedDB
// (as fotos são Blob) e sobe quando a rede volta: cria o rascunho no servidor, grava as linhas e anexa cada foto.
// A sincronização é retomável: o id do servidor e o id de cada linha ficam no registro local até terminar.

export type TipoApp = "reembolso" | "fundo_fixo";

export interface LinhaLocal {
  chave: string;
  data: string | null;
  valor: number | null;
  descricao: string | null;
  motivo: string | null;
  categoriaId: number | null;
  foto: Blob | null;
  fotoNome: string | null;
  /** Preenchidos durante a sincronização (retomada sem duplicar). */
  linhaId?: number | null;
  fotoEnviada?: boolean;
}

export interface RascunhoLocal {
  id: string;
  tipo: TipoApp;
  criadoEm: string;
  atualizadoEm: string;
  linhas: LinhaLocal[];
  servidorId?: number | null;
  erro?: string | null;
}

const BANCO = "solicitante-sf";
const LOJA = "rascunhos";

// ---------- Armazenamento (IndexedDB; sem ele, memória da aba) ----------
const memoria = new Map<string, RascunhoLocal>();

function abrir(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((ok) => {
    try {
      const req = indexedDB.open(BANCO, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(LOJA, { keyPath: "id" });
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ok(null);
    } catch {
      ok(null);
    }
  });
}

async function comLoja<T>(modo: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | null, semBanco: () => T): Promise<T> {
  const db = await abrir();
  if (!db) return semBanco();
  return new Promise((ok, falha) => {
    const tx = db.transaction(LOJA, modo);
    const req = fn(tx.objectStore(LOJA));
    tx.oncomplete = () => {
      ok(req ? req.result : (undefined as T));
      db.close();
    };
    tx.onerror = () => {
      falha(tx.error ?? new Error("Não foi possível gravar no aparelho."));
      db.close();
    };
  });
}

export const rascunhosLocais = {
  listar: () =>
    comLoja<RascunhoLocal[]>("readonly", (s) => s.getAll() as IDBRequest<RascunhoLocal[]>, () => [...memoria.values()]).then((l) =>
      [...l].sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm))),
  obter: (id: string) => comLoja<RascunhoLocal | undefined>("readonly", (s) => s.get(id) as IDBRequest<RascunhoLocal | undefined>, () => memoria.get(id)),
  gravar: (r: RascunhoLocal) =>
    comLoja<IDBValidKey>("readwrite", (s) => s.put({ ...r, atualizadoEm: new Date().toISOString() }), () => {
      memoria.set(r.id, { ...r, atualizadoEm: new Date().toISOString() });
      return r.id;
    }).then(() => undefined),
  apagar: (id: string) => comLoja<undefined>("readwrite", (s) => s.delete(id) as IDBRequest<undefined>, () => {
    memoria.delete(id);
    return undefined;
  }),
};

// ---------- Regras puras ----------
let seq = 0;
export const novaChave = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

export function novoRascunhoLocal(tipo: TipoApp): RascunhoLocal {
  const agora = new Date().toISOString();
  return { id: novaChave(), tipo, criadoEm: agora, atualizadoEm: agora, linhas: [] };
}

export function totalLocal(r: Pick<RascunhoLocal, "linhas">): number {
  return Math.round(r.linhas.reduce((s, l) => s + (l.valor ?? 0), 0) * 100) / 100;
}

/** O que falta numa linha para o envio (a sincronização sobe mesmo incompleta; o envio é feito depois, com rede). */
export function faltaNaLinha(l: LinhaLocal): string[] {
  const f: string[] = [];
  if (!l.data) f.push("data");
  if (l.valor == null || l.valor <= 0) f.push("valor");
  if (!l.descricao?.trim()) f.push("favorecido");
  if (!l.motivo?.trim()) f.push("motivo");
  if (!l.foto && !l.fotoEnviada) f.push("comprovante");
  return f;
}

/** Erro de rede (fetch falhou), para cair no rascunho do aparelho em vez de mostrar erro. */
export function ehFalhaDeRede(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return e instanceof TypeError && /fetch|network|load failed/i.test(e.message);
}

export interface Destino {
  criar(tipo: TipoApp): Promise<number>;
  periodo(id: number): Promise<{ competencia: string | null; periodoDe: string | null; periodoAte: string | null; centroCusto: string | null }>;
  salvar(p: {
    id: number; competencia: string | null; periodoDe: string | null; periodoAte: string | null; centroCusto: string | null;
    itens: { chave: string; id?: number; data: string | null; valor: number | null; descricao: string | null; motivo: string | null; categoriaId: number | null }[];
    conhecidos: number[];
  }): Promise<{ itens: { chave: string; id: number }[] }>;
  anexar(p: { solicitacaoId: number; itemId: number; arquivo: File }): Promise<unknown>;
}

/**
 * Sobe o rascunho do aparelho: cria no servidor (uma vez), grava as linhas e anexa as fotos. A cada passo, o progresso
 * fica no registro local (servidorId, linhaId, fotoEnviada); se cair no meio, a próxima tentativa continua de onde parou.
 * No fim, apaga o registro local e devolve o id do servidor.
 */
export async function sincronizar(r: RascunhoLocal, destino: Destino, guardar: (r: RascunhoLocal) => Promise<void>, apagar: (id: string) => Promise<void>): Promise<number> {
  const atual: RascunhoLocal = { ...r, linhas: r.linhas.map((l) => ({ ...l })), erro: null };
  if (!atual.servidorId) {
    atual.servidorId = await destino.criar(atual.tipo);
    await guardar(atual);
  }
  const id = atual.servidorId;
  const p = await destino.periodo(id);
  const resp = await destino.salvar({
    id, ...p,
    itens: atual.linhas.map((l) => ({ chave: l.chave, id: l.linhaId ?? undefined, data: l.data, valor: l.valor, descricao: l.descricao, motivo: l.motivo, categoriaId: l.categoriaId })),
    conhecidos: atual.linhas.flatMap((l) => (l.linhaId ? [l.linhaId] : [])),
  });
  const mapa = new Map(resp.itens.map((x) => [x.chave, x.id]));
  for (const l of atual.linhas) l.linhaId = mapa.get(l.chave) ?? l.linhaId ?? null;
  await guardar(atual);
  for (const l of atual.linhas) {
    if (!l.foto || l.fotoEnviada || !l.linhaId) continue;
    const tipo = l.foto.type || "image/jpeg";
    await destino.anexar({ solicitacaoId: id, itemId: l.linhaId, arquivo: new File([l.foto], l.fotoNome ?? `comprovante-${l.chave}.jpg`, { type: tipo }) });
    l.fotoEnviada = true;
    l.foto = null;
    await guardar(atual);
  }
  await apagar(atual.id);
  return id;
}
