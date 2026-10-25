-- "Receber chamado" marcado = o setor aparece no App do solicitante como opção para abrir chamado (pedido do Wagner, 16/10/2026).
-- Ao marcar, o setor fica visível no app; ao desmarcar, sai. A Administração do App do solicitante ainda pode esconder um setor
-- que recebe, mas não pode mostrar um que não recebe. Só aditiva: redefine o gatilho da 20261016100000.

create or replace function imobdesk.at_setores_recebe_regra()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.recebe_chamados then
    -- Passou a receber (ou nasceu recebendo): entra no app.
    if tg_op = 'INSERT' or not old.recebe_chamados then
      new.cd_visivel := true;
    end if;
  elsif new.cd_visivel then
    if tg_op = 'INSERT' or old.recebe_chamados then
      new.cd_visivel := false;  -- setor novo ou que deixou de receber: sai do app
    else
      perform imobdesk.erro('INVALID_INPUT', format('O setor %s não recebe chamados. Marque "Receber chamado" em Setores e números para mostrá-lo no App do solicitante.', new.nome));
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function imobdesk.at_setores_recebe_regra() from public, anon, authenticated;

-- Setores que já recebem e ainda não estão no app (ex.: Financeiro).
update imobdesk.at_setores set cd_visivel = true where recebe_chamados and ativo and not cd_visivel;

notify pgrst, 'reload schema';
