// Cliente IMAP mínimo (RFC 9051) para o "Testar configurações": conecta, faz login, conta as mensagens da
// pasta e sai. A leitura dos e-mails (F4) usa o mesmo comando-resposta. Sem biblioteca: o socket entra por
// parâmetro (Deno.connectTls na Edge Function, falso nos testes).

import { Linhas, type Passo, type Socket } from "./conexao.ts";

export interface ConfigImap {
  host: string;
  porta: number;
  seguranca: "ssl" | "starttls";
  usuario: string;
  senha: string | null;
  pasta: string;
}

export interface Rede {
  /** Abre a conexão: com TLS direto (porta 993/465) ou em texto puro (para STARTTLS). */
  abrir(host: string, porta: number, tls: boolean): Promise<Socket>;
  /** Sobe o TLS numa conexão aberta em texto puro. */
  iniciarTls(socket: Socket, host: string): Promise<Socket>;
}

/** Texto entre aspas do IMAP (escapa \ e "). */
export function aspas(valor: string): string {
  return `"${valor.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** "* STATUS INBOX (MESSAGES 12 UNSEEN 3)" → { mensagens: 12, naoLidas: 3 }. */
export function lerStatus(linha: string): { mensagens: number; naoLidas: number } | null {
  if (!/^\* STATUS /i.test(linha)) return null;
  const m = linha.match(/MESSAGES (\d+)/i);
  const u = linha.match(/UNSEEN (\d+)/i);
  return { mensagens: m ? Number(m[1]) : 0, naoLidas: u ? Number(u[1]) : 0 };
}

export class Imap {
  private seq = 0;
  constructor(private c: Linhas) {}

  /** Envia um comando e junta as linhas até a resposta marcada. Lança o texto do NO/BAD. */
  async comando(cmd: string, ocultar = false): Promise<string[]> {
    const tag = `a${++this.seq}`;
    await this.c.escrever(`${tag} ${cmd}\r\n`);
    const linhas: string[] = [];
    for (;;) {
      const l = await this.c.linha();
      if (l.startsWith(`${tag} `)) {
        const resto = l.slice(tag.length + 1);
        if (/^OK/i.test(resto)) return linhas;
        throw new Error(resto.replace(/^(NO|BAD)\s*/i, "").replace(/^\[[^\]]*\]\s*/, "") || (ocultar ? "Recusado." : `Recusado: ${cmd}`));
      }
      linhas.push(l);
    }
  }
}

/** Teste de recebimento: conexão, login e contagem da pasta. Cada etapa vira um passo da tela. */
export async function testarImap(cfg: ConfigImap, rede: Rede): Promise<Passo[]> {
  const passos: Passo[] = [];
  let c: Linhas | null = null;
  let imap: Imap;
  try {
    const socket = await rede.abrir(cfg.host, cfg.porta, cfg.seguranca === "ssl");
    c = new Linhas(socket);
    const saudacao = await c.linha();
    if (!/^\* (OK|PREAUTH)/i.test(saudacao)) throw new Error(`Saudação inesperada: ${saudacao.slice(0, 120)}`);
    imap = new Imap(c);
    if (cfg.seguranca === "starttls") {
      await imap.comando("STARTTLS");
      c.trocar(await rede.iniciarTls(c.socket, cfg.host));
    }
    passos.push({ passo: `Conexão com ${cfg.host}:${cfg.porta}`, ok: true, detalhe: saudacao.slice(0, 80) });
  } catch (e) {
    passos.push({ passo: `Conexão com ${cfg.host}:${cfg.porta}`, ok: false, detalhe: String(e instanceof Error ? e.message : e) });
    c?.fechar();
    return passos;
  }
  try {
    if (!cfg.senha) throw new Error("Senha não informada.");
    await imap.comando(`LOGIN ${aspas(cfg.usuario)} ${aspas(cfg.senha)}`, true);
    passos.push({ passo: `Login de ${cfg.usuario}`, ok: true, detalhe: "aceito" });
  } catch (e) {
    passos.push({ passo: `Login de ${cfg.usuario}`, ok: false, detalhe: String(e instanceof Error ? e.message : e) });
    c.fechar();
    return passos;
  }
  try {
    const linhas = await imap.comando(`STATUS ${aspas(cfg.pasta)} (MESSAGES UNSEEN)`);
    const st = linhas.map(lerStatus).find(Boolean);
    passos.push({ passo: `Leitura da pasta ${cfg.pasta}`, ok: true, detalhe: st ? `${st.mensagens} e-mails, ${st.naoLidas} não lidos` : "pasta encontrada" });
    await imap.comando("LOGOUT").catch(() => undefined);
  } catch (e) {
    passos.push({ passo: `Leitura da pasta ${cfg.pasta}`, ok: false, detalhe: String(e instanceof Error ? e.message : e) });
  } finally {
    c.fechar();
  }
  return passos;
}
