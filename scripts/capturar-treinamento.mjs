// Centro de Treinamento: captura as telas dos balões na demonstração (dados fictícios, sem Supabase) e grava em
// public/treinamento/<tela>.webp. Os nomes são os de tr_passos.tela. Mudou uma tela do sistema? Rode de novo:
//   npm run treinamento:capturar
// Sobe a demo na porta 5199 (ou usa a que já estiver no ar) e usa o Edge da máquina (playwright-core, sem baixar navegador).
// Desktop 1440×900; celular 390×844 com deviceScaleFactor 2 (780×1688), os tamanhos em que os alvos (%) foram marcados.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import sharp from "sharp";

const PORTA = 5199;
const BASE = `http://localhost:${PORTA}`;
const SAIDA = "public/treinamento";
const LOGIN = { email: "wagner.antunes@exemplo.com.br", senha: "demonstracao123" }; // usuário fictício do modo demo
// A faixa "DEV · Ver como · Modo simulado" não existe em produção. visibility (e não display) para não mexer no layout.
const ESCONDER = ".dev-switcher, .topbar__status { visibility: hidden !important; }";

const DESKTOP = [
  { tela: "t-visao", rota: "/gestao-chamados/visao-geral" },
  { tela: "t-tickets", rota: "/gestao-chamados/tickets" },
  { tela: "t-ticket", rota: "/gestao-chamados/tickets", clicar: "text=#48231" },
  { tela: "t-ticket2", rolar: 700 },
  { tela: "t-conversas", rota: "/gestao-chamados/conversas" },
  { tela: "t-monitor", rota: "/gestao-chamados/monitor" },
  { tela: "f-minhas", rota: "/financeiro/solicitacoes" },
  { tela: "f-nova", rota: "/financeiro/nova" },
  { tela: "f-reembolso", rota: "/financeiro/solicitacoes", clicar: "text=Novo reembolso" },
  { tela: "f-detalhe", rota: "/financeiro/solicitacoes", clicar: "text=SF-2026-0150" },
  { tela: "f-aprov", rota: "/financeiro/aprovacoes" },
  { tela: "f-aprov-det", rota: "/financeiro/aprovacoes", clicar: "a:has-text('Abrir')" },
  { tela: "f-conf", rota: "/financeiro/conferencia" },
  { tela: "f-conf-det", rota: "/financeiro/conferencia", clicar: "a:has-text('Conferir')" },
];
const CELULAR = [
  { tela: "app-home", rota: "/app" },
  { tela: "app-fin", rota: "/app/financeiro" },
];

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function noAr() {
  try {
    return (await fetch(BASE)).ok;
  } catch {
    return false;
  }
}

async function subirDemo() {
  if (await noAr()) return null;
  const vite = spawn(`npx vite --mode demo --port ${PORTA} --strictPort`, { stdio: "ignore", shell: true });
  for (let i = 0; i < 60; i++) {
    if (await noAr()) return vite;
    await espera(1000);
  }
  parar(vite);
  throw new Error(`A demonstração não subiu em ${BASE}.`);
}

/** Com shell, kill() mata só o shell; no Windows o Vite fica no ar. taskkill /T derruba a árvore. */
function parar(proc) {
  if (!proc) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc.kill();
}

/** Navegação SPA: page.goto recarrega e perde a sessão, que no modo demo fica em memória. */
async function ir(page, rota) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, rota);
  await espera(1800);
}

async function entrar(page, rota) {
  await page.goto(`${BASE}${rota}`);
  await page.fill('input[type="email"]', LOGIN.email);
  await page.fill('input[type="password"]', LOGIN.senha);
  await page.click('button[type="submit"]');
  await espera(3000);
  await page.addStyleTag({ content: ESCONDER });
}

const sessoes = new WeakMap();

/**
 * Screenshot pelo CDP: page.screenshot pode travar esperando fontes ou animações.
 * Uma sessão CDP por página (abrir outra desfaz a emulação do celular) e a escala explícita no clip.
 */
async function capturar(page, tela, escala) {
  await page.addStyleTag({ content: ESCONDER });
  await espera(300);
  if (!sessoes.has(page)) sessoes.set(page, await page.context().newCDPSession(page));
  const { width, height } = page.viewportSize();
  const { data } = await sessoes.get(page).send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: escala } });
  const info = await sharp(Buffer.from(data, "base64")).webp({ quality: 82 }).toFile(`${SAIDA}/${tela}.webp`);
  console.log(`ok  ${tela.padEnd(12)} ${info.width}×${info.height}  ${Math.round(info.size / 1024)} KB  ${await page.evaluate(() => location.pathname)}`);
}

async function roteiro(page, telas, escala) {
  for (const t of telas) {
    if (t.rota) await ir(page, t.rota);
    if (t.clicar) {
      await page.locator(t.clicar).first().click({ timeout: 8000 });
      await espera(1800);
    }
    if (t.rolar) {
      await page.mouse.wheel(0, t.rolar);
      await espera(800);
    }
    await capturar(page, t.tela, escala);
  }
}

mkdirSync(SAIDA, { recursive: true });
const vite = await subirDemo();
const navegador = await chromium.launch({ channel: "msedge" });
const erros = [];
try {
  const desktop = await navegador.newPage({ viewport: { width: 1440, height: 900 } });
  desktop.on("pageerror", (e) => erros.push(e.message));
  await entrar(desktop, "/login");
  await roteiro(desktop, DESKTOP, 1);

  const celular = await navegador.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  celular.on("pageerror", (e) => erros.push(e.message));
  await entrar(celular, "/app");
  await roteiro(celular, CELULAR, 2);
} finally {
  await navegador.close();
  parar(vite);
}
if (erros.length) {
  console.error("Erros na página:", erros);
  process.exitCode = 1;
}
