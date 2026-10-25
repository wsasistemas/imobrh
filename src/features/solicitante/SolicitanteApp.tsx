import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Eye, EyeOff, LogOut, User, Wrench } from "lucide-react";
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useSearchParams } from "react-router";
import { isAllowedLoginEmail } from "../../config/app";
import { AppAccessDeniedPopup } from "../auth/AppAccessDeniedPopup";
import { useAuthSession } from "../auth/useAuthSession";
import { AbrirChamado } from "./AbrirChamado";
import { AppFinanceiro } from "./financeiro/AppFinanceiro";
import { DetalheChamado, MeusChamados } from "./Chamados";
import { solicitanteApi, type Entrada } from "./service";
import { AppTecnico } from "./Tecnico";
import { Avisos, EscolherSetorPelaUrl, Inicio, Perfil, Solucoes } from "./Telas";
import "./solicitante.css";

// App do solicitante (docs/PLANO-app-solicitante.md): em /app, fora do layout do portal e pensado para celular.
// Quem é de uma empresa cliente entra (perfil Solicitante no 1º acesso). A Administração abre com ?simular=<usuário> para
// ver o app como a pessoa (só leitura).

const SIMULAR_KEY = "solicitante-simular";
/** Quem pediu "Primeiro acesso" pelo app volta para o app depois de criar a senha. */
export const VOLTAR_APP_KEY = "solicitante-voltar";
/** Aba do login (Colaborador ou Técnico), guardada no aparelho: o técnico já abre na aba dele. */
const MODO_KEY = "solicitante-modo";
export type Modo = "col" | "tec";

function lerModo(): Modo {
  try {
    return localStorage.getItem(MODO_KEY) === "tec" ? "tec" : "col";
  } catch {
    return "col";
  }
}

function lerSessao(chave: string): string | null {
  try {
    return sessionStorage.getItem(chave);
  } catch {
    return null;
  }
}
function gravarSessao(chave: string, valor: string | null) {
  try {
    if (valor) sessionStorage.setItem(chave, valor);
    else sessionStorage.removeItem(chave);
  } catch {
    // navegador sem armazenamento: a simulação vale só nesta tela
  }
}

interface Ctx {
  entrada: Entrada;
  /** Usuário simulado (Administração) ou null. */
  como: string | null;
  simulando: boolean;
}
const CdContext = createContext<Ctx | null>(null);

export function useCd(): Ctx {
  const ctx = useContext(CdContext);
  if (!ctx) throw new Error("useCd fora do App do solicitante");
  return ctx;
}

export function Carregando() {
  return (
    <div className="cd-carregando" aria-busy="true" aria-label="Carregando">
      <div />
      <div />
      <div />
    </div>
  );
}

/** Logo da WSA (a mesma do portal) ao lado do nome "Imobdesk". */
export function Logo({ para = "/app" }: { para?: string }) {
  return (
    <Link to={para} className="cd-logo" aria-label="Imobdesk, início">
      <img className="cd-logo__marca" src="/wsa-logo.png" alt="WSA Sistemas" width={30} height={30} />
      <span className="cd-logo__sep" aria-hidden="true" />
      <span className="cd-logo__nome">
        <span>Imob</span>
        <b>desk</b>
      </span>
    </Link>
  );
}

export function Cabecalho({ direita }: { direita?: ReactNode }) {
  const { signOut } = useAuthSession();
  const { simulando } = useCd();
  return (
    <header className="cd-hdr">
      <Logo />
      <div className="cd-hdr__acoes">
        {direita}
        {!simulando && (
          <button type="button" className="cd-pilula" onClick={() => void signOut()}>
            <LogOut size={15} aria-hidden="true" />
            Sair
          </button>
        )}
      </div>
    </header>
  );
}

export function SubCabecalho({ titulo, sub, voltar }: { titulo: string; sub?: ReactNode; voltar: string }) {
  return (
    <div className="cd-sub">
      <Link to={voltar} className="cd-voltar" aria-label="Voltar">
        <ArrowLeft size={18} aria-hidden="true" />
      </Link>
      <div>
        <h2>{titulo}</h2>
        {sub && <p>{sub}</p>}
      </div>
    </div>
  );
}

/** Service worker do app (public/sw-app.js, escopo /app): abre sem rede para o rascunho financeiro do aparelho. Só no build. */
function useAppOffline() {
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw-app.js", { scope: "/app" }).catch(() => undefined);
  }, []);
}

/** Rota /app/*. */
export function SolicitanteApp() {
  useAppOffline();
  const { status } = useAuthSession();
  const [params] = useSearchParams();
  const pedido = params.get("simular");
  if (pedido) gravarSessao(SIMULAR_KEY, /^[0-9a-f-]{36}$/i.test(pedido) ? pedido : null);
  const [modo, setModoEstado] = useState<Modo>(lerModo);
  const setModo = (m: Modo) => {
    setModoEstado(m);
    gravarLocal(MODO_KEY, m);
  };
  // A simulação da Administração é sempre do colaborador.
  const tecnico = modo === "tec" && !lerSessao(SIMULAR_KEY);

  if (status === "loading") {
    return (
      <div className={tecnico ? "cd cd--tec" : "cd"}>
        <div className="cd__col">
          <Carregando />
        </div>
      </div>
    );
  }
  if (status === "signedOut") return <AppLogin modo={modo} onModo={setModo} />;
  return tecnico ? <AppTecnico onColaborador={() => setModo("col")} /> : <AppAutenticado />;
}

function AppAutenticado() {
  const navigate = useNavigate();
  const { email, signOut } = useAuthSession();
  const [como] = useState(() => lerSessao(SIMULAR_KEY));
  // Sem rede (ex.: abriu o app no canteiro para o rascunho financeiro), vale a última entrada guardada no aparelho.
  const entrada = useQuery({
    queryKey: ["cd", "entrada", como],
    queryFn: () => solicitanteApi.entrar(como),
    retry: 1,
    staleTime: 60_000,
    networkMode: "offlineFirst",
    placeholderData: () => (!como && typeof navigator !== "undefined" && !navigator.onLine ? lerEntrada(email) : undefined),
  });
  useEffect(() => {
    if (entrada.data && !entrada.isPlaceholderData && !como) gravarEntrada(entrada.data);
  }, [entrada.data, entrada.isPlaceholderData, como]);
  // Permissões por aplicativo: o bloqueio manual do Super admin vale também no app (consulta depois do 1º acesso,
  // que cria o cadastro). Na simulação, quem vê é a Administração.
  const acesso = useQuery({ queryKey: ["cd", "acesso"], queryFn: solicitanteApi.podeAcessar, enabled: entrada.isSuccess && !como, staleTime: 300_000 });
  const [saindo, setSaindo] = useState(false);

  const sairSimulacao = () => {
    gravarSessao(SIMULAR_KEY, null);
    navigate("/gestao-atendimento/app-solicitante", { replace: true });
  };

  if (entrada.isPending) {
    return (
      <div className="cd">
        <div className="cd__col">
          <Carregando />
        </div>
      </div>
    );
  }
  if (entrada.isError) {
    return (
      <div className="cd">
        <div className="cd__col">
          <div className="cd__centro">
            <div>
              <p className="cd-alerta">{entrada.error.message}</p>
              <div className="cd-confirma__acoes" style={{ margin: "0 auto" }}>
                <button type="button" className="cd-btn-ouro" onClick={() => void entrada.refetch()}>
                  Tentar de novo
                </button>
                {como ? (
                  <button type="button" className="cd-btn-vidro" onClick={() => sairSimulacao()}>
                    Sair da simulação
                  </button>
                ) : (
                  <button type="button" className="cd-btn-vidro" onClick={() => void signOut()}>
                    Sair
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const ctx: Ctx = { entrada: entrada.data, como, simulando: Boolean(como) };
  return (
    <CdContext.Provider value={ctx}>
      <div className="cd">
        {ctx.simulando && (
          <div className="cd-simula" role="status">
            <span>
              <b>Modo simulação · só leitura</b>
              Vendo o app como {entrada.data.nome}
            </span>
            <button type="button" onClick={sairSimulacao}>
              Sair
            </button>
          </div>
        )}
        <div className="cd__col">
          <Routes>
            <Route index element={<Inicio />} />
            <Route path="d/:setorId" element={<EscolherSetorPelaUrl />} />
            <Route path="avisos" element={<Avisos />} />
            <Route path="d/:setorId/abrir" element={<AbrirChamado />} />
            <Route path="d/:setorId/avisos" element={<Avisos />} />
            <Route path="d/:setorId/solucoes" element={<Solucoes />} />
            <Route path="chamados" element={<MeusChamados />} />
            <Route path="chamados/:id" element={<DetalheChamado />} />
            <Route path="perfil" element={<Perfil />} />
            <Route path="financeiro/*" element={<AppFinanceiro />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </div>
      </div>
      {acesso.data === false && (
        <AppAccessDeniedPopup
          open
          onOpenChange={() => {}}
          email={email}
          signingOut={saindo}
          onSignOut={() => {
            setSaindo(true);
            void signOut();
          }}
        />
      )}
    </CdContext.Provider>
  );
}

/** Login do app: mesmo gateway seguro do portal, com o visual do App do solicitante. "Primeiro acesso" cria a conta. */
function AppLogin({ modo: aba, onModo }: { modo: Modo; onModo: (m: Modo) => void }) {
  const tec = aba === "tec";
  const { signIn, requestPasswordReset, notice, clearNotice } = useAuthSession();
  const [modo, setModo] = useState<"entrar" | "link">("entrar");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [verSenha, setVerSenha] = useState(false);

  const emailValido = isAllowedLoginEmail(email);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    setOk(null);
    clearNotice();
    if (!emailValido) {
      setErro("Informe um e-mail válido.");
      return;
    }
    setEnviando(true);
    try {
      if (modo === "entrar") {
        if (!senha) {
          setErro("Digite a sua senha.");
          return;
        }
        await signIn(email, senha);
      } else {
        await requestPasswordReset(email);
        gravarLocal(VOLTAR_APP_KEY, "1");
        setOk("Pronto! Se o e-mail estiver cadastrado, você vai receber um link para criar a sua senha. Confira também o lixo eletrônico.");
      }
    } catch (error) {
      setErro(error instanceof Error ? error.message : "Não foi possível concluir. Tente novamente.");
    } finally {
      setEnviando(false);
    }
  };

  const mensagem = erro ?? notice;
  return (
    <div className={tec ? "cd cd--tec" : "cd"}>
      <div className="cd__col">
        <div className="cd-login">
          <Logo para="/app" />
          <h1>{modo === "entrar" ? (tec ? "Entrar como técnico" : "Entrar") : "Primeiro acesso"}</h1>
          <p>
            {modo === "entrar"
              ? "Use seu e-mail e sua senha."
              : "Digite seu e-mail. Enviaremos um link para você criar (ou trocar) a sua senha."}
          </p>
          <div className="cd-seg" role="tablist" aria-label="Tipo de acesso">
            <button type="button" role="tab" aria-selected={!tec} onClick={() => onModo("col")}>
              <User size={16} aria-hidden="true" /> Colaborador
            </button>
            <button type="button" role="tab" aria-selected={tec} onClick={() => onModo("tec")}>
              <Wrench size={16} aria-hidden="true" /> Técnico
            </button>
          </div>
          {tec && <p className="cd-login__tec">Acesso dos técnicos do <b>CFTV</b>. Mesmo e-mail e senha do portal.</p>}
          {mensagem && (
            <p className="cd-alerta" role="alert">
              {mensagem}
            </p>
          )}
          {ok && (
            <p className="cd-login__ok" role="status">
              {ok}
            </p>
          )}
          <form onSubmit={(e) => void enviar(e)} noValidate>
            <label className="cd-rot" htmlFor="cd-email" style={{ margin: 0 }}>
              E-mail
            </label>
            <input
              id="cd-email"
              className="cd-campo"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="voce@suaempresa.com.br"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {modo === "entrar" && (
              <>
                <label className="cd-rot" htmlFor="cd-senha" style={{ margin: "4px 0 0" }}>
                  Senha
                </label>
                {/* Celular: o teclado e o gerenciador de senhas mudam o que vai; o olho deixa conferir antes de entrar. */}
                <div className="cd-senha">
                  <input
                    id="cd-senha"
                    className="cd-campo"
                    type={verSenha ? "text" : "password"}
                    autoComplete="current-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={senha}
                    onChange={(e) => setSenha(e.target.value)}
                  />
                  <button type="button" className="cd-senha__olho" aria-label={verSenha ? "Esconder a senha" : "Mostrar a senha"} aria-pressed={verSenha} onClick={() => setVerSenha((v) => !v)}>
                    {verSenha ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                  </button>
                </div>
                {/\s$|^\s/.test(senha) && <span className="cd-erro">A senha começa ou termina com espaço. Confira se o teclado não acrescentou.</span>}
              </>
            )}
            <button type="submit" className="cd-btn-ouro" disabled={enviando} style={{ marginTop: 8 }}>
              {enviando ? "Aguarde…" : modo === "entrar" ? (tec ? "Entrar como técnico" : "Entrar") : "Enviar link"}
            </button>
          </form>
          <small>
            {modo === "entrar" ? (
              <button type="button" className="cd-link" onClick={() => { setModo("link"); setErro(null); setOk(null); }}>
                Primeiro acesso ou esqueci a senha
              </button>
            ) : (
              <button type="button" className="cd-link" onClick={() => { setModo("entrar"); setErro(null); setOk(null); }}>
                Voltar para entrar
              </button>
            )}
          </small>
          <small>{tec ? "Só membros das equipes do CFTV." : "No 1º acesso você entra como Solicitante."}</small>
        </div>
      </div>
    </div>
  );
}

const ENTRADA_KEY = "solicitante-entrada";

function lerEntrada(email: string | null): Entrada | undefined {
  try {
    const e = JSON.parse(localStorage.getItem(ENTRADA_KEY) ?? "null") as Entrada | null;
    return e && email && e.email.toLowerCase() === email.toLowerCase() ? e : undefined;
  } catch {
    return undefined;
  }
}

function gravarEntrada(e: Entrada) {
  gravarLocal(ENTRADA_KEY, JSON.stringify(e));
}

function gravarLocal(chave: string, valor: string) {
  try {
    localStorage.setItem(chave, valor);
  } catch {
    // sem armazenamento: depois de criar a senha, cai no login do portal (que manda de volta ao app)
  }
}
