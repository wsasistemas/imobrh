// Cliente SMTP mínimo (RFC 5321) com TLS direto (porta 465: o Supabase bloqueia 25 e 587) e AUTH PLAIN.
// Usado no "Testar configurações" (login e e-mail de teste) e no envio (F5).

import { Linhas, type Passo } from "./conexao.ts";
import type { Rede } from "./imap.ts";
import { base64, pontoDuplo } from "./mime.ts";

export interface ConfigSmtp {
  host: string;
  porta: number;
  usuario: string;
  senha: string | null;
}

/** Lê uma resposta (multilinha "250-..." até "250 ...") e devolve código e texto. */
export async function resposta(c: Linhas): Promise<{ codigo: number; texto: string }> {
  const partes: string[] = [];
  for (;;) {
    const l = await c.linha();
    partes.push(l.slice(4));
    if (/^\d{3} /.test(l) || /^\d{3}$/.test(l)) return { codigo: Number(l.slice(0, 3)), texto: partes.join(" ") };
    if (!/^\d{3}-/.test(l)) throw new Error(`Resposta SMTP inválida: ${l.slice(0, 120)}`);
  }
}

async function esperar(c: Linhas, cmd: string | null, aceitos: number[], ocultar = false): Promise<string> {
  if (cmd !== null) await c.escrever(`${cmd}\r\n`);
  const r = await resposta(c);
  if (!aceitos.includes(r.codigo)) throw new Error(`${r.codigo} ${r.texto}`.slice(0, 300) || (ocultar ? "Recusado." : `Recusado: ${cmd}`));
  return r.texto;
}

export class Smtp {
  private constructor(private c: Linhas) {}

  static async conectar(cfg: ConfigSmtp, rede: Rede, nomeHelo = "imobdesk.imobsystems.com.br"): Promise<Smtp> {
    const c = new Linhas(await rede.abrir(cfg.host, cfg.porta, true));
    await esperar(c, null, [220]);
    await esperar(c, `EHLO ${nomeHelo}`, [250]);
    return new Smtp(c);
  }

  async login(usuario: string, senha: string) {
    await esperar(this.c, `AUTH PLAIN ${base64(`\u0000${usuario}\u0000${senha}`)}`, [235], true);
  }

  async enviar(de: string, para: string[], mensagem: string) {
    await esperar(this.c, `MAIL FROM:<${de}>`, [250]);
    for (const p of para) await esperar(this.c, `RCPT TO:<${p}>`, [250, 251]);
    await esperar(this.c, "DATA", [354]);
    await this.c.escrever(`${pontoDuplo(mensagem)}\r\n.\r\n`);
    await esperar(this.c, null, [250]);
  }

  async sair() {
    await esperar(this.c, "QUIT", [221]).catch(() => undefined);
    this.c.fechar();
  }

  fechar() {
    this.c.fechar();
  }
}

/** Teste de envio: conexão e login; com `mensagem`, envia o e-mail de teste. */
export async function testarSmtp(cfg: ConfigSmtp, rede: Rede, teste?: { de: string; para: string; mensagem: string }): Promise<Passo[]> {
  const passos: Passo[] = [];
  let s: Smtp;
  try {
    s = await Smtp.conectar(cfg, rede);
    passos.push({ passo: `Conexão com ${cfg.host}:${cfg.porta}`, ok: true, detalhe: "TLS ok" });
  } catch (e) {
    passos.push({ passo: `Conexão com ${cfg.host}:${cfg.porta}`, ok: false, detalhe: String(e instanceof Error ? e.message : e) });
    return passos;
  }
  try {
    if (!cfg.senha) throw new Error("Senha não informada.");
    await s.login(cfg.usuario, cfg.senha);
    passos.push({ passo: `Login de envio (${cfg.usuario})`, ok: true, detalhe: "aceito" });
    if (teste) {
      await s.enviar(teste.de, [teste.para], teste.mensagem);
      passos.push({ passo: `E-mail de teste para ${teste.para}`, ok: true, detalhe: "aceito pelo servidor" });
    }
    await s.sair();
  } catch (e) {
    passos.push({ passo: teste && passos.length > 1 ? `E-mail de teste para ${teste.para}` : `Login de envio (${cfg.usuario})`, ok: false, detalhe: String(e instanceof Error ? e.message : e) });
    s.fechar();
  }
  return passos;
}
