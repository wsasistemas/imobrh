// App (Fase 6): rascunho no aparelho e sincronização retomável (cria uma vez, grava linhas, anexa fotos, apaga o local).
import { describe, expect, it } from "vitest";
import { faltaNaLinha, novoRascunhoLocal, rascunhosLocais, sincronizar, totalLocal, type Destino, type LinhaLocal, type RascunhoLocal } from "../src/features/solicitante/financeiro/offline";

const linha = (o: Partial<LinhaLocal>): LinhaLocal => ({
  chave: o.chave ?? "a", data: "2026-10-14", valor: 210, descricao: "AUTO POSTO SHELL", motivo: "Combustível", categoriaId: 4,
  foto: new Blob(["x"], { type: "image/jpeg" }), fotoNome: "cupom.jpg", ...o,
});

function destinoFalso(falharAnexoNa?: number) {
  const chamadas = { criar: 0, salvar: 0, anexos: [] as number[] };
  let proximo = 100;
  const d: Destino = {
    async criar() {
      chamadas.criar++;
      return 7;
    },
    async periodo() {
      return { competencia: "2026-10-01", periodoDe: "2026-10-01", periodoAte: "2026-10-31", centroCusto: null };
    },
    async salvar(p) {
      chamadas.salvar++;
      return { itens: p.itens.map((i) => ({ chave: i.chave, id: i.id ?? proximo++ })) };
    },
    async anexar(p) {
      if (falharAnexoNa != null && chamadas.anexos.length === falharAnexoNa) {
        falharAnexoNa = undefined;
        throw new TypeError("Failed to fetch");
      }
      chamadas.anexos.push(p.itemId);
    },
  };
  return { d, chamadas };
}

describe("rascunho no aparelho", () => {
  it("total e pendências por linha", () => {
    const r = { linhas: [linha({ valor: 210 }), linha({ chave: "b", valor: 35.5 })] };
    expect(totalLocal(r)).toBe(245.5);
    expect(faltaNaLinha(linha({ data: null, foto: null, motivo: "" }))).toEqual(["data", "motivo", "comprovante"]);
    expect(faltaNaLinha(linha({}))).toEqual([]);
  });

  it("guarda, lista e apaga (sem IndexedDB, na memória)", async () => {
    const r = novoRascunhoLocal("reembolso");
    await rascunhosLocais.gravar(r);
    expect((await rascunhosLocais.listar()).map((x) => x.id)).toContain(r.id);
    await rascunhosLocais.apagar(r.id);
    expect(await rascunhosLocais.obter(r.id)).toBeUndefined();
  });
});

describe("sincronização", () => {
  it("cria, grava as linhas, anexa cada foto e apaga o local", async () => {
    const { d, chamadas } = destinoFalso();
    const r: RascunhoLocal = { ...novoRascunhoLocal("fundo_fixo"), linhas: [linha({ chave: "a" }), linha({ chave: "b", foto: null })] };
    const apagados: string[] = [];
    const id = await sincronizar(r, d, async () => undefined, async (x) => void apagados.push(x));
    expect(id).toBe(7);
    expect(chamadas).toEqual({ criar: 1, salvar: 1, anexos: [100] });
    expect(apagados).toEqual([r.id]);
  });

  it("retoma depois de cair no meio, sem criar de novo nem repetir a foto", async () => {
    const { d, chamadas } = destinoFalso(1);
    let salvo: RascunhoLocal | null = null;
    const r: RascunhoLocal = { ...novoRascunhoLocal("reembolso"), linhas: [linha({ chave: "a" }), linha({ chave: "b" })] };
    await expect(sincronizar(r, d, async (x) => void (salvo = x), async () => undefined)).rejects.toThrow(/fetch/);
    expect(salvo!.servidorId).toBe(7);
    expect(salvo!.linhas.map((l) => l.fotoEnviada ?? false)).toEqual([true, false]);
    await sincronizar(salvo!, d, async (x) => void (salvo = x), async () => undefined);
    expect(chamadas.criar).toBe(1);
    expect(chamadas.anexos).toEqual([100, 101]);
  });
});
