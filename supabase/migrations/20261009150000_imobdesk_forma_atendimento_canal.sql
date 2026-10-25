-- Forma de atendimento pelo canal (09/10/2026, pedido do Wagner): ticket que entra por e-mail ou WhatsApp já nasce
-- com o campo adicional "forma_atendimento" preenchido (E-mail / WhatsApp). É o canal de entrada, então não depende
-- do modelo nem de confiança: a regra é determinística. Telefone, Presencial e Acesso remoto não têm canal automático
-- (o agente abre o ticket e escolhe). Só preenche se estiver vazio — escolha manual nunca é sobrescrita. Só aditiva.

create or replace function imobdesk.ch_forma_atendimento_do_canal(p_origem text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_origem when 'email' then 'E-mail' when 'whatsapp' then 'WhatsApp' end;
$$;

create or replace function imobdesk.ch_tickets_forma_atendimento()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_forma text := imobdesk.ch_forma_atendimento_do_canal(new.origem);
begin
  if v_forma is not null and coalesce(btrim(new.campos ->> 'forma_atendimento'), '') = '' then
    new.campos := coalesce(new.campos, '{}') || jsonb_build_object('forma_atendimento', v_forma);
  end if;
  return new;
end;
$$;

drop trigger if exists ch_tickets_forma_atendimento on imobdesk.ch_tickets;
create trigger ch_tickets_forma_atendimento before insert on imobdesk.ch_tickets
for each row execute function imobdesk.ch_tickets_forma_atendimento();

-- Linha do tempo: registra a classificação. Prefixo "z_" para disparar depois de ch_tickets_historico ("Ticket criado").
create or replace function imobdesk.ch_tickets_forma_atendimento_evento()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if imobdesk.ch_forma_atendimento_do_canal(new.origem) = new.campos ->> 'forma_atendimento' then
    insert into imobdesk.ch_ticket_eventos (ticket_id, tipo, descricao, autor_nome)
    values (new.id, 'ia', format('Forma de atendimento: %s (canal de entrada)', new.campos ->> 'forma_atendimento'), 'IA');
  end if;
  return null;
end;
$$;

drop trigger if exists ch_tickets_z_forma_atendimento_evento on imobdesk.ch_tickets;
create trigger ch_tickets_z_forma_atendimento_evento after insert on imobdesk.ch_tickets
for each row execute function imobdesk.ch_tickets_forma_atendimento_evento();

revoke execute on function imobdesk.ch_tickets_forma_atendimento() from public, anon, authenticated;
revoke execute on function imobdesk.ch_tickets_forma_atendimento_evento() from public, anon, authenticated;

-- Tickets já abertos por e-mail/WhatsApp com o campo vazio. Sem os gatilhos de histórico e automação, para não
-- gerar "Campos adicionais alterados" nem disparar regras por uma correção de dado; o evento é gravado aqui.
alter table imobdesk.ch_tickets disable trigger ch_tickets_historico;
alter table imobdesk.ch_tickets disable trigger ch_tickets_gatilho_anotar;

with corrigidos as (
  update imobdesk.ch_tickets t
     set campos = coalesce(t.campos, '{}') || jsonb_build_object('forma_atendimento', imobdesk.ch_forma_atendimento_do_canal(t.origem))
   where t.origem in ('email', 'whatsapp')
     and coalesce(btrim(t.campos ->> 'forma_atendimento'), '') = ''
  returning t.id, t.campos ->> 'forma_atendimento' as forma
)
insert into imobdesk.ch_ticket_eventos (ticket_id, tipo, descricao, autor_nome)
select c.id, 'ia', format('Forma de atendimento: %s (canal de entrada)', c.forma), 'IA' from corrigidos c;

alter table imobdesk.ch_tickets enable trigger ch_tickets_historico;
alter table imobdesk.ch_tickets enable trigger ch_tickets_gatilho_anotar;
