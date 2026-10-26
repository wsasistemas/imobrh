// Núcleo puro do acesso ao TOTVS RM (supabase/functions/_shared/rm/nucleo.ts) e o contrato da API.
import { describe, expect, it } from "vitest";
import { CODIGOS_ERRO, isCodigoErro, PAPEIS, PAPEIS_CONSOLE, STATUS_DO_ERRO } from "../packages/shared/src/index.ts";
import {
  chaveCache,
  consultaMock,
  cpfValido,
  descreverErroRm,
  FUNCIONARIOS_MOCK,
  funcionarioMockPara,
  lerParametros,
  origemRm,
  urlConsulta,
  urlToken,
} from "../supabase/functions/_shared/rm/nucleo.ts";

describe("URLs do RM", () => {
  it("token em /api/connect/token na origem da URL salva", () => {
    expect(urlToken("http://rm.empresa.com.br:8051/qualquer/caminho")).toBe("http://rm.empresa.com.br:8051/api/connect/token/");
  });

  it("consulta com sufixo padrão /0/P e parâmetros no formato do RM", () => {
    expect(urlConsulta("http://rm:8051", "API.RH.FUNCIONARIO", { CODCOLIGADA: "1", CPF: "" })).toBe(
      "http://rm:8051/api/framework/v1/consultaSQLServer/RealizaConsulta/API.RH.FUNCIONARIO/0/P?parameters=CODCOLIGADA=1;CPF=",
    );
  });

  it("código com caminho próprio e URL que já traz …/RealizaConsulta", () => {
    expect(urlConsulta("https://rm/api/framework/v1/consultaSQLServer/RealizaConsulta/", "API.RH.HIERARQUIA/1/X")).toBe(
      "https://rm/api/framework/v1/consultaSQLServer/RealizaConsulta/API.RH.HIERARQUIA/1/X",
    );
  });

  it("recusa URL que não é http(s)", () => {
    expect(() => origemRm("ftp://rm")).toThrow(/http/);
    expect(() => origemRm("não é url")).toThrow(/inválida/);
  });
});

describe("parâmetros e cache", () => {
  it("lê NOME=valor separados por ponto e vírgula", () => {
    expect(lerParametros(" codcoligada=1 ; CPF=123 ")).toEqual({ CODCOLIGADA: "1", CPF: "123" });
    expect(lerParametros("")).toEqual({});
    expect(() => lerParametros("sem-igual")).toThrow(/inválido/);
  });

  it("a ordem dos parâmetros não muda a chave do cache", () => {
    expect(chaveCache("api.rh.funcionario", { B: "2", A: "1" })).toBe(chaveCache("API.RH.FUNCIONARIO", { A: "1", B: "2" }));
  });
});

describe("CPF e erros do RM", () => {
  it("valida os dígitos verificadores", () => {
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("52998224724")).toBe(false);
    expect(cpfValido("11111111111")).toBe(false);
  });

  it("nunca repassa o SQL da mensagem do RM", () => {
    const corpo = JSON.stringify({ code: "XX1", message: "Coluna inválida.\nSQL: SELECT * FROM PFUNC" });
    const mensagem = descreverErroRm(500, corpo, "API.RH.FUNCIONARIO");
    expect(mensagem).toBe("XX1: Coluna inválida.");
    expect(mensagem).not.toMatch(/SELECT/);
  });

  it("401 vira mensagem de credencial recusada", () => {
    expect(descreverErroRm(401, "", "token")).toMatch(/recusados/);
  });
});

describe("modo mock", () => {
  it("todos os CPFs fictícios são válidos", () => {
    for (const f of FUNCIONARIOS_MOCK) expect(cpfValido(f.CPF), f.NOME).toBe(true);
  });

  it("API.RH.FUNCIONARIO filtra por CPF e por chapa como o SQL real", () => {
    expect(consultaMock("API.RH.FUNCIONARIO", { CODCOLIGADA: "1", CPF: "52998224725", CHAPA: "" })).toHaveLength(1);
    expect(consultaMock("API.RH.FUNCIONARIO", { CODCOLIGADA: "1", CPF: "", CHAPA: "000202" })[0]).toMatchObject({ NOME: "Diego Souza" });
    expect(consultaMock("API.RH.FUNCIONARIO", { CODCOLIGADA: "1", CPF: "", CHAPA: "" })).toHaveLength(FUNCIONARIOS_MOCK.length);
  });

  it("o funcionário fictício de um login é estável, tem CPF válido e aparece na consulta", () => {
    const a = funcionarioMockPara("6f1c2d3e-0000-4000-8000-000000000001", "x@y.com", "Fulano");
    expect(funcionarioMockPara("6f1c2d3e-0000-4000-8000-000000000001", "x@y.com", "Fulano")).toEqual(a);
    expect(cpfValido(a.CPF)).toBe(true);
    expect(consultaMock("API.RH.FUNCIONARIO", { CPF: a.CPF }, [a])).toEqual([a]);
  });

  it("API.RH.HIERARQUIA filtra pela seção", () => {
    expect(consultaMock("API.RH.HIERARQUIA", { CODCOLIGADA: "1", CODSECAO: "01.002" })[0]).toMatchObject({ CHAPA_CHEFE: "000101" });
  });
});

describe("contrato da API", () => {
  it("todo código de erro tem status HTTP", () => {
    for (const codigo of CODIGOS_ERRO) expect(STATUS_DO_ERRO[codigo]).toBeGreaterThanOrEqual(400);
    expect(isCodigoErro("RM_INDISPONIVEL")).toBe(true);
    expect(isCodigoErro("FORBIDDEN")).toBe(false);
  });

  it("os papéis do Console são papéis válidos", () => {
    for (const papel of PAPEIS_CONSOLE) expect(PAPEIS).toContain(papel);
  });
});
