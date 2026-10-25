// Setores do modo simulado / demonstração = os mesmos da produção (at_setores, lidos em 17/10/2026): mesmos ids,
// nomes, "recebe chamado", setor de obra e setor financeiro. Fonte única para todas as telas simuladas (Setores e
// números, Pessoas, Equipes, Gestão de Chamados, Empreendimentos e Solicitações Financeiras).

export interface SetorProducao {
  id: number;
  nome: string;
  recebeChamados: boolean;
  obra: boolean;
  financeiro: boolean;
}

const s = (id: number, nome: string, extra: Partial<SetorProducao> = {}): SetorProducao => ({ id, nome, recebeChamados: false, obra: false, financeiro: false, ...extra });

/** Ids dos setores que recebem chamado. */
export const SETOR_ID = { ti: 20, cftv: 21, administrativo: 22, financeiro: 23 } as const;

export const SETORES_PRODUCAO: SetorProducao[] = [
  s(20, "TI -  Suporte", { recebeChamados: true }),
  s(21, "CFTV", { recebeChamados: true }),
  s(22, "Administrativo", { recebeChamados: true }),
  s(23, "Financeiro", { recebeChamados: true, financeiro: true }),
  s(24, "Cobrança"), s(25, "Assistência Técnica"), s(26, "Comercial"), s(27, "Compliance"), s(28, "Contabilidade /  Fiscal"), s(29, "Contratos"),
  s(30, "RI - Relacionamento Com Investidor"), s(31, "DP - Depto Pessoal"), s(32, "Engenharia"), s(33, "Arquitetura"), s(34, "Infraestrutura"),
  s(35, "Serralheria"), s(52, "Suprimentos"), s(53, "Orçamento e Planejamento"), s(54, "RH"), s(55, "Projetos Executivos"), s(56, "CRC"),
  s(57, "Obra - Arte Design", { obra: true }), s(58, "Jurídico"), s(59, "Obra - Arte Wave", { obra: true }), s(60, "Alumínio"), s(61, "COP"),
  s(62, "Esquadria"), s(63, "Instalações"), s(64, "Obra", { obra: true }), s(65, "Presidência"), s(66, "Incorporação"),
  s(67, "Obra - Arte Jardim", { obra: true }),
];

export const nomeDoSetor = (id: number | null | undefined) => SETORES_PRODUCAO.find((x) => x.id === id)?.nome ?? null;

// ---------- Pessoas da demonstração (fictícias) nos setores que atendem ----------

/** Setor de cada usuário do modo simulado (Pessoas, Solicitações Financeiras). */
export const SETOR_DO_USUARIO: Record<string, number> = {
  "u-wagner": 20, "u-marcos": 20, "u-paula": 20,
  "u-renato": 21, "u-helena": 21,
  "u-carla": 22, "u-gustavo": 22,
  "u-fernanda": 23, "u-ana": 23, "u-bruno": 23,
};

/** Gestor (aprovador financeiro) e substituto de cada setor que atende. */
export const GESTOR_DO_SETOR: Record<number, { id: string; nome: string; substitutoId: string; substituto: string }> = {
  20: { id: "u-paula", nome: "Paula Nunes", substitutoId: "u-marcos", substituto: "Marcos Prado" },
  21: { id: "u-renato", nome: "Renato Lopes", substitutoId: "u-helena", substituto: "Helena Costa" },
  22: { id: "u-carla", nome: "Carla Mendes", substitutoId: "u-gustavo", substituto: "Gustavo Reis" },
  23: { id: "u-fernanda", nome: "Fernanda Dias", substitutoId: "u-ana", substituto: "Ana Lima" },
};

/** Diretor das alçadas do adiantamento (setor Presidência). */
export const DIRETOR = { id: "u-roberto", nome: "Roberto Alves" };
