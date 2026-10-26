// GET /rh/me — vínculo do login com o TOTVS RM, papéis e itens do menu RH que o app do imobdesk deve mostrar.
//
// Chamado pelo app ao abrir. A regra fica toda aqui e no banco (app_imobrh.menu_app); o app só desenha o menu.
//  * vínculo vinculado: atualiza os dados pela API.RH.FUNCIONARIO (cache de 1 h) e sincroniza os papéis que vêm do RM:
//    colaborador (ativo no RM) e gestor (chefe de alguma seção na API.RH.HIERARQUIA);
//  * sem vínculo e RM_MODO=mock: cria um funcionário fictício para o login (demonstração da Fase 0);
//  * sem vínculo e RM_MODO=real: devolve vinculo null; o DP resolve na tela Vínculos pendentes do Console;
//  * RM fora do ar: responde com o que está no banco (a abertura de pedido continua funcionando).
import type { ItemMenuApp, Papel, RhMe } from "../_shared/contrato.ts";
import { contextoDoUsuario } from "../_shared/contexto.ts";
import { deRpc, ErroRh, ok, servir } from "../_shared/http.ts";
import { modoRm } from "../_shared/rm/cliente.ts";
import { funcionarioMockPara } from "../_shared/rm/nucleo.ts";
import {
  dadosDoFuncionario,
  funcionariosPor,
  gravarVinculo,
  hierarquia,
  paraVinculoRm,
  SITUACAO_DESLIGADO,
} from "../_shared/rm/vinculo.ts";

servir(["GET"], async (req) => {
  const ctx = await contextoDoUsuario(req);
  const { db, usuario, empresaId } = ctx;
  const modo = modoRm();

  const nome = (typeof usuario.user_metadata?.name === "string" && usuario.user_metadata.name) ||
    (usuario.email ?? "").split("@")[0];
  const mock = funcionarioMockPara(usuario.id, usuario.email ?? "", nome);
  const extrasMock = modo === "mock" ? [mock] : [];

  const atual = await db.from("colaborador_vinculo").select("*").eq("user_id", usuario.id).maybeSingle();
  if (atual.error) throw deRpc(atual.error);
  let vinculo = atual.data as Record<string, unknown> | null;

  try {
    if (vinculo?.status === "vinculado" && typeof vinculo.chapa === "string") {
      const lido = await funcionariosPor(db, empresaId, { chapa: vinculo.chapa, coligada: vinculo.coligada as number }, extrasMock);
      const funcionario = lido.funcionarios[0];
      if (funcionario && !lido.desatualizado) {
        vinculo = await gravarVinculo(db, usuario.id, dadosDoFuncionario(funcionario, lido.mock ? "mock" : "rm"));
      }
      if (funcionario) {
        const chefias = await hierarquia(db, empresaId, funcionario.CODCOLIGADA);
        const ehGestor = chefias.some((h) => h.CHAPA_CHEFE === funcionario.CHAPA);
        const sincronizado = await db.rpc("sincronizar_papeis_rm", {
          p_usuario: usuario.id,
          p_colaborador: funcionario.CODSITUACAO !== SITUACAO_DESLIGADO,
          p_gestor: ehGestor,
        });
        if (sincronizado.error) throw deRpc(sincronizado.error);
      }
    } else if (!vinculo && modo === "mock") {
      vinculo = await gravarVinculo(db, usuario.id, dadosDoFuncionario(mock, "mock"));
    }
  } catch (error) {
    // RM indisponível sem cache: segue com o que está gravado.
    if (!(error instanceof ErroRh) || error.code !== "RM_INDISPONIVEL") throw error;
    console.warn(JSON.stringify({ evento: "rh_me_sem_rm", usuario: usuario.id, motivo: error.message }));
  }

  const papeis = await db.rpc("papeis_de", { p_usuario: usuario.id });
  if (papeis.error) throw deRpc(papeis.error);
  const substituto = await db.rpc("substituto_ativo", { p_usuario: usuario.id });
  if (substituto.error) throw deRpc(substituto.error);
  const menu = await db.rpc("menu_app", { p_papeis: papeis.data ?? [], p_substituto_ativo: substituto.data === true });
  if (menu.error) throw deRpc(menu.error);

  const resposta: RhMe = {
    usuario: { id: usuario.id, email: usuario.email ?? "", nome: (vinculo?.nome as string | undefined) ?? nome },
    vinculo: paraVinculoRm(vinculo),
    papeis: (papeis.data ?? []) as Papel[],
    menu: (menu.data ?? []) as ItemMenuApp[],
    modoRm: modo,
  };
  return ok(resposta);
});
