# Guia rápido: Administração › Gatilhos

Gatilhos fazem coisas sozinhos no ticket: mudar o status, avisar alguém, responder com uma macro.
Só Admin e Super admin veem esta tela.

## Como um gatilho funciona

1. **Dispara quando** algo acontece:
   - ticket criado, alterado ou com status alterado;
   - o solicitante respondeu, ou o agente adicionou uma ação;
   - passou um tempo: tempo no status, SLA perto de vencer ou SLA vencido. Os de tempo são conferidos a cada 5 minutos.
2. **Condições** filtram os tickets:
   - **TODAS** precisam valer;
   - em **QUALQUER**, basta uma (deixe vazio para não filtrar).
3. **Ações** rodam na ordem da lista.

## Regras que valem sempre

- Os gatilhos rodam **na ordem da lista**. Use as setas para mudar a ordem.
- **O que um gatilho muda não dispara outro gatilho.** Isso evita repetição sem fim.
- **"Uma vez por evento"** roda a cada vez que o disparo acontece. **"Uma vez por ticket"** roda só a primeira vez em cada ticket (bom para avisos).
- **Resolver por gatilho segue as regras do agente:** precisa de serviço, dos campos obrigatórios e da "Solução aplicada". Se faltar algo, o gatilho **não muda nada**, e o erro aparece em **Execuções** e no histórico do ticket.
- A **resposta ao solicitante** sai de uma **macro**. Até o envio por e-mail e WhatsApp ser ligado, ela fica "pendente de envio".
- **"Avisar"** manda o aviso para o **sino** do topo do portal.

## Antes de ligar

1. Abra o gatilho e use **Simular em um ticket** com o número de um ticket real. A simulação mostra ✔/✘ em cada condição e não altera nada.
2. Marque **Ativo** e salve.
3. Depois de um tempo, confira **Execuções** (botão na lista ou o número da coluna "Últimos 7 dias").

## Exemplos que já vêm cadastrados (inativos)

| Gatilho | O que faz |
|---|---|
| Cliente respondeu → volta para Em atendimento | O solicitante respondeu num ticket "Aguardando": volta para Em atendimento e avisa o responsável. Funciona quando o e-mail e o WhatsApp virarem ticket |
| Sem retorno do cliente em 48 h úteis → Resolvido | Aguardando › Retorno do cliente por 48 h úteis: responde com a macro "Encerramento por falta de retorno", preenche a solução e resolve |
| Urgência urgente → avisar a equipe | Ticket urgente: tag "urgente", nota interna e aviso para a equipe (uma vez por ticket) |
| SLA vence em 2 h sem responsável | Avisa o líder da equipe e o coloca como seguidor |
