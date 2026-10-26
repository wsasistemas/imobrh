# Consultas SQL do TOTVS RM usadas pelo ImobRH

O ImobRH lê o RM só por Consulta SQL exposta via API (padrão `API.{módulo}.{id}`), pelas Edge Functions. A escrita
fica para a fase 4, só por DataServer, e nunca por INSERT direto nas tabelas do RM.

Os SQLs **ainda não existem**. Enquanto isso, as Edge Functions rodam com `RM_MODO=mock`, que devolve dados fictícios
**no mesmo formato** descrito abaixo (`supabase/functions/_shared/rm/nucleo.ts`, `FUNCIONARIOS_MOCK` e
`HIERARQUIA_MOCK`). Quando os SQLs forem publicados na base da Calper:
1. a consulta entra no RM com o código exato da tabela abaixo;
2. ela é conferida na tela **Integração TOTVS RM › Consultas SQL**, com o botão Testar;
3. a variável `RM_MODO` das Edge Functions muda para `real`.

## Como o ImobRH chama o RM

| Passo | Chamada | Onde |
|---|---|---|
| Token | `POST <servidor>/api/connect/token/` com `{ grant_type: "password", username, password }` do usuário de integração | `_shared/rm/cliente.ts` → `obterToken` (Edge Function `rm-token`) |
| Consulta | `GET <servidor>/api/framework/v1/consultaSQLServer/RealizaConsulta/<código>/0/P?parameters=NOME=valor;NOME2=valor` com `Authorization: Bearer <token>` | `_shared/rm/cliente.ts` → `chamarConsulta` |

- O código sem caminho ganha `/0/P`, que é a sentença global (coligada 0) do sistema P (Folha de Pagamento). Se a sentença for cadastrada em outra coligada ou sistema, cadastre o código com o caminho na tela, por exemplo `API.RH.FUNCIONARIO/1/P`.
- Todos os parâmetros vão em toda chamada. Valor vazio significa "sem filtro", então o SQL precisa tratar `''` (exemplos abaixo).
- A credencial é o usuário de integração, nunca uma pessoa:
  - a URL e o usuário ficam em `app_imobrh.integracao_rm`;
  - a senha fica no Vault, no segredo `app_imobrh_rm_senha_<empresa>`;
  - o token fica só na memória da Edge Function.
- Cache em `app_imobrh.rm_cache`, pelo tempo da tabela abaixo (`consulta_rm.cache_segundos`). Com o RM fora do ar, a função devolve o último valor lido com `desatualizado: true` e a data da leitura.

## API.RH.FUNCIONARIO

Vínculo CPF ↔ coligada + chapa, situação, seção, função e admissão. Usada por `rm-funcionario` (busca e vínculo pelo
CPF) e por `rh-me` (atualiza o vínculo e o papel colaborador). **Cache: 1 hora.**

**Parâmetros:** `CODCOLIGADA` (número), `CPF` (11 dígitos ou vazio), `CHAPA` (texto ou vazio).

| Campo | Tipo | Origem sugerida (confirmar na base da Calper) | Uso no ImobRH |
|---|---|---|---|
| `CODCOLIGADA` | inteiro | `PFUNC.CODCOLIGADA` | Vínculo (coligada) |
| `CHAPA` | texto | `PFUNC.CHAPA` | Vínculo (chapa) |
| `NOME` | texto | `PFUNC.NOME` / `PPESSOA.NOME` | Exibição |
| `CPF` | texto, 11 dígitos sem máscara | `PPESSOA.CPF` | Chave do vínculo com o login |
| `EMAIL` | texto ou nulo | `PPESSOA.EMAIL` | Conferência |
| `CODSITUACAO` | texto | `PFUNC.CODSITUACAO` | `D` = desligado: tira o papel colaborador e marca o vínculo como divergente |
| `SITUACAO` | texto | `PCODSITUACAO.DESCRICAO` | Exibição |
| `CODSECAO` | texto | `PFUNC.CODSECAO` | Hierarquia e alçada |
| `SECAO` | texto | `PSECAO.DESCRICAO` | Exibição |
| `CODFUNCAO` | texto | `PFUNC.CODFUNCAO` | Requisição de pessoal (fase 1) |
| `FUNCAO` | texto | `PFUNCAO.NOME` | Exibição |
| `DATAADMISSAO` | data (ISO) | `PFUNC.DATAADMISSAO` | Férias e marcos de experiência |
| `CHAPA_GESTOR` | texto ou nulo | chefe da seção, via cadastro de chefia da base | RLS do gestor (`colaborador_vinculo.gestor_chapa`) |

Esqueleto do SQL, a validar:
```sql
SELECT F.CODCOLIGADA, F.CHAPA, F.NOME, P.CPF, P.EMAIL, F.CODSITUACAO, S.DESCRICAO AS SITUACAO,
       F.CODSECAO, SE.DESCRICAO AS SECAO, F.CODFUNCAO, FU.NOME AS FUNCAO, F.DATAADMISSAO,
       /* chefe da seção: tabela de chefia da base da Calper */ NULL AS CHAPA_GESTOR
  FROM PFUNC F
  JOIN PPESSOA P ON P.CODIGO = F.CODPESSOA
  LEFT JOIN PCODSITUACAO S ON S.CODCLIENTE = F.CODSITUACAO
  LEFT JOIN PSECAO SE ON SE.CODCOLIGADA = F.CODCOLIGADA AND SE.CODIGO = F.CODSECAO
  LEFT JOIN PFUNCAO FU ON FU.CODCOLIGADA = F.CODCOLIGADA AND FU.CODIGO = F.CODFUNCAO
 WHERE F.CODCOLIGADA = :CODCOLIGADA
   AND (:CPF = '' OR P.CPF = :CPF)
   AND (:CHAPA = '' OR F.CHAPA = :CHAPA)
```

Regras do vínculo (`_shared/rm/vinculo.ts` → `decidirVinculo`):
- nenhuma linha → `pendente`, "CPF não encontrado";
- só linhas desligadas → `divergente`;
- mais de uma chapa ativa → `divergente`;
- uma chapa ativa → `vinculado`.

## API.RH.HIERARQUIA

Chefe de cada seção, para rotear aprovações. Usada por `rm-hierarquia` e por `rh-me`, que dá o papel gestor a quem é
chefe de alguma seção. **Cache: 1 hora.**

**Parâmetros:** `CODCOLIGADA` (número), `CODSECAO` (texto ou vazio = todas).

| Campo | Tipo | Origem sugerida | Uso |
|---|---|---|---|
| `CODCOLIGADA` | inteiro | `PSECAO.CODCOLIGADA` | — |
| `CODSECAO` | texto | `PSECAO.CODIGO` | Seção |
| `SECAO` | texto | `PSECAO.DESCRICAO` | Exibição |
| `CODSECAO_PAI` | texto ou nulo | seção superior | Escalonamento para o nível acima (fase 1) |
| `CHAPA_CHEFE` | texto ou nulo | cadastro de chefia da base da Calper | Papel gestor e aprovador de nível 1 |
| `NOME_CHEFE` | texto ou nulo | `PFUNC.NOME` do chefe | Exibição |

Seção sem chefe (`CHAPA_CHEFE` nulo) precisa ser corrigida no RM antes de ligar as aprovações. Esse risco está no PRD v1.

## Consultas das próximas fases (já cadastradas no catálogo)

| Código | Uso | Cache | Parâmetros previstos |
|---|---|---|---|
| `API.RH.FERIAS_SALDO` | Períodos aquisitivos, saldo, vencimento (`PFUFERIASPER`) | 15 min | `CODCOLIGADA`, `CHAPA` |
| `API.RH.FERIAS_PROGRAMADAS` | Férias já programadas na seção | 15 min | `CODCOLIGADA`, `CODSECAO` |
| `API.RH.HOLERITE` | Envelope de pagamento da competência | por competência | `CODCOLIGADA`, `CHAPA`, `COMPETENCIA` |
| `API.RH.FERIADOS` | Calendário da coligada | 1 dia | `CODCOLIGADA` |

As consultas entram no catálogo de cada empresa na primeira leitura (`app_imobrh.garantir_consultas_padrao`).
`API.RH.FUNCIONARIO` e `API.RH.HIERARQUIA` são usadas por Edge Functions, então não podem ser excluídas nem ter o
código trocado.
