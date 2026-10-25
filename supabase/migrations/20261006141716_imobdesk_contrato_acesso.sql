-- Contrato de acesso da Central (schema acessos do ikvj).
-- A Central (schema acessos) reconhece o aplicativo e cadastra quem for liberado na tela
-- Permissões por aplicativo quando o schema tem:
--   <schema>.usuarios (id, email, nome, perfil, ativo)  e  <schema>.perfis (chave, nome, ordem).
-- As telas deste modelo usam perfil_key/status e key/label; as colunas do contrato ficam em
-- sincronia pelos gatilhos abaixo, nos dois sentidos. Aditiva: só cria colunas e funções.

-- Datas de atualização das tabelas-base (a função nasce na 03).
drop trigger if exists api_queries_atualizado_em on imobdesk.api_queries;
create trigger api_queries_atualizado_em before update on imobdesk.api_queries
  for each row execute function imobdesk.definir_atualizado_em();
drop trigger if exists integration_settings_atualizado_em on imobdesk.integration_settings;
create trigger integration_settings_atualizado_em before update on imobdesk.integration_settings
  for each row execute function imobdesk.definir_atualizado_em();

-- perfis: chave/nome espelham key/label (só leitura).
alter table imobdesk.perfis add column if not exists chave text generated always as (key) stored;
alter table imobdesk.perfis add column if not exists nome text generated always as (label) stored;

-- usuarios: perfil/ativo de verdade, sincronizados com perfil_key/status.
alter table imobdesk.usuarios add column if not exists perfil text;
alter table imobdesk.usuarios add column if not exists ativo boolean;
update imobdesk.usuarios set perfil = perfil_key, ativo = (status = 'active')
where perfil is distinct from perfil_key or ativo is distinct from (status = 'active');

create or replace function imobdesk.contrato_sincronizar_usuario()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Cadastro pela Central chega com perfil/ativo; pelas telas, com perfil_key/status.
    new.perfil_key := coalesce(new.perfil_key, new.perfil);
    if new.ativo is not null and new.status is not distinct from 'pending' then
      new.status := case when new.ativo then 'active' else 'inactive' end;
    end if;
  else
    if new.perfil is distinct from old.perfil and new.perfil_key is not distinct from old.perfil_key then
      new.perfil_key := new.perfil;
    end if;
    if new.ativo is distinct from old.ativo and new.status is not distinct from old.status then
      new.status := case when new.ativo then 'active' else 'inactive' end;
    end if;
  end if;
  new.perfil := new.perfil_key;
  new.ativo := new.status = 'active';
  return new;
end;
$$;

revoke execute on function imobdesk.contrato_sincronizar_usuario() from public, anon, authenticated;

drop trigger if exists usuarios_contrato_acesso on imobdesk.usuarios;
-- "a_" para rodar antes da proteção do proprietário (ordem alfabética dos gatilhos BEFORE).
create trigger a_usuarios_contrato_acesso
  before insert or update on imobdesk.usuarios
  for each row execute function imobdesk.contrato_sincronizar_usuario();

notify pgrst, 'reload schema';
