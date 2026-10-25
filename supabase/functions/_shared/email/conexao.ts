// Conexão de texto por linhas sobre um socket (TLS no Deno; falso nos testes). Usada pelos clientes
// mínimos de IMAP e SMTP: sem biblioteca npm, só o que o teste e a leitura precisam.

export interface Socket {
  read(buf: Uint8Array): Promise<number | null>;
  write(dados: Uint8Array): Promise<number>;
  close(): void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Linhas {
  private resto = "";
  constructor(public socket: Socket, private timeoutMs = 15_000) {}

  /** Próxima linha (sem o CRLF). Lança erro em timeout ou conexão fechada. */
  async linha(): Promise<string> {
    const limite = Date.now() + this.timeoutMs;
    while (!this.resto.includes("\r\n")) {
      const buf = new Uint8Array(16_384);
      const falta = limite - Date.now();
      if (falta <= 0) throw new Error("Tempo esgotado esperando o servidor.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const n = await Promise.race([
        this.socket.read(buf),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("Tempo esgotado esperando o servidor.")), falta);
        }),
      ]).finally(() => clearTimeout(timer));
      if (n === null) throw new Error("O servidor fechou a conexão.");
      this.resto += dec.decode(buf.subarray(0, n), { stream: true });
    }
    const i = this.resto.indexOf("\r\n");
    const l = this.resto.slice(0, i);
    this.resto = this.resto.slice(i + 2);
    return l;
  }

  async escrever(texto: string): Promise<void> {
    const dados = enc.encode(texto);
    let enviado = 0;
    while (enviado < dados.length) enviado += await this.socket.write(dados.subarray(enviado));
  }

  /** Troca o socket (STARTTLS); descarta o que sobrou em texto puro. */
  trocar(socket: Socket) {
    this.socket = socket;
    this.resto = "";
  }

  fechar() {
    try {
      this.socket.close();
    } catch {
      /* já fechado */
    }
  }
}

export interface Passo {
  passo: string;
  ok: boolean;
  detalhe: string;
}
