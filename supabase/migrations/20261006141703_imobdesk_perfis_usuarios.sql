
-- Fase 2 (1/4): estrutura de acesso do Imobdesk no schema `imobdesk`.
--
-- Tudo aditivo: tabelas novas (`perfis`, `usuarios`, `integracoes`), colunas novas em `audit_logs`
-- e índice/FK em `profile_permissions` (vazia hoje). Nada é apagado.
-- Não há trigger em auth.users: essa tabela é compartilhada com os outros sistemas da WSA.

-- ---------- Funções utilitárias ----------

create or replace function imobdesk.definir_atualizado_em()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- Perfis (catálogo dinâmico com hierarquia) ----------

create table if not exists imobdesk.perfis (
  key text primary key check (key ~ '^[a-z0-9_]{2,60}$'),
  label text not null check (length(trim(label)) between 2 and 40),
  description text not null default '' check (length(description) <= 120),
  -- Posição na hierarquia: 0 é o mais alto. Quem tem um perfil só atribui perfis de ordem >= à sua.
  ordem integer not null,
  -- Perfil do sistema: a chave não muda e ele não pode ser excluído.
  is_system boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint perfis_ordem_unica unique (ordem) deferrable initially deferred
);

comment on table imobdesk.perfis is 'Perfis de acesso do Imobdesk, em ordem de hierarquia (0 = mais alto).';

create unique index if not exists perfis_label_unico on imobdesk.perfis (lower(label));

drop trigger if exists perfis_atualizado_em on imobdesk.perfis;
create trigger perfis_atualizado_em
  before update on imobdesk.perfis
  for each row execute function imobdesk.definir_atualizado_em();

create or replace function imobdesk.proteger_perfil_sistema()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'O perfil % é do sistema e não pode ser excluído.', old.label using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.key <> new.key then
    raise exception 'A chave de um perfil não muda.' using errcode = 'P0001';
  end if;
  if old.key = 'super_admin' and new.ordem <> 0 then
    raise exception 'O perfil Super admin é sempre o primeiro da hierarquia.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists perfis_protecao on imobdesk.perfis;
create trigger perfis_protecao
  before update or delete on imobdesk.perfis
  for each row execute function imobdesk.proteger_perfil_sistema();

insert into imobdesk.perfis (key, label, description, ordem, is_system) values
  ('super_admin', 'Super admin', 'Acesso total ao sistema.', 0, true),
  ('admin', 'Admin', 'Administra usuários, perfis e permissões.', 1, true),
  ('ti', 'TI', 'Suporte técnico, auditoria e sessões.', 2, false),
  ('financeiro', 'Financeiro', 'Equipe financeira.', 3, false),
  ('operador', 'Operador', 'Operação do dia a dia.', 4, false)
on conflict (key) do nothing;

-- ---------- Usuários do portal ----------

create table if not exists imobdesk.usuarios (
  -- Mesmo id do auth.users: a conta de login é a do projeto compartilhado.
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique check (email = lower(email)),
  nome text not null check (length(trim(nome)) >= 3),
  perfil_key text references imobdesk.perfis (key) on update cascade on delete restrict,
  status text not null default 'pending' check (status in ('active', 'inactive', 'pending')),
  -- Dono do portal: sempre Super admin, ativo e protegido (ver trigger abaixo).
  is_owner boolean not null default false,
  must_change_password boolean not null default false,
  last_access_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table imobdesk.usuarios is 'Quem pode entrar no Imobdesk e com qual perfil.';

create unique index if not exists usuarios_um_proprietario on imobdesk.usuarios (is_owner) where is_owner;
create index if not exists usuarios_perfil on imobdesk.usuarios (perfil_key);

drop trigger if exists usuarios_atualizado_em on imobdesk.usuarios;
create trigger usuarios_atualizado_em
  before update on imobdesk.usuarios
  for each row execute function imobdesk.definir_atualizado_em();

-- Defesa no banco, valendo até para o service_role: o proprietário não sai de Super admin ativo.
create or replace function imobdesk.proteger_proprietario()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_owner then
      raise exception 'A conta proprietária do portal não pode ser excluída.' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.is_owner and (
    not new.is_owner or new.perfil_key is distinct from 'super_admin' or new.status <> 'active' or new.email <> old.email
  ) then
    raise exception 'A conta proprietária do portal não pode ser rebaixada, inativada nem ter o e-mail trocado.' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.is_owner and not old.is_owner then
    raise exception 'O proprietário do portal só é definido por migration.' using errcode = 'P0001';
  end if;
  if new.is_owner and (new.perfil_key is distinct from 'super_admin' or new.status <> 'active') then
    raise exception 'O proprietário do portal precisa ser Super admin ativo.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists usuarios_protecao_proprietario on imobdesk.usuarios;
create trigger usuarios_protecao_proprietario
  before insert or update or delete on imobdesk.usuarios
  for each row execute function imobdesk.proteger_proprietario();

-- ---------- Permissões por perfil (tabela existente, vazia) ----------

create unique index if not exists profile_permissions_perfil_menu on imobdesk.profile_permissions (role, permission_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profile_permissions_role_perfis_fk') then
    alter table imobdesk.profile_permissions
      add constraint profile_permissions_role_perfis_fk
      foreign key (role) references imobdesk.perfis (key) on update cascade on delete cascade;
  end if;
end;
$$;

-- ---------- Auditoria (tabela existente): quem e de onde ----------

alter table imobdesk.audit_logs add column if not exists ator_nome text;
alter table imobdesk.audit_logs add column if not exists origem text not null default 'Portal web';
create index if not exists audit_logs_recentes on imobdesk.audit_logs (created_at desc);

-- ---------- Integrações do portal ----------

create table if not exists imobdesk.integracoes (
  key text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  nome text not null,
  descricao text not null default '',
  ativo boolean not null default false,
  remetente text not null default '',
  enviar_emails_auth boolean not null default true,
  -- A chave de API fica no Vault (vault.secrets); aqui só a referência e a máscara.
  segredo_id uuid,
  segredo_mascara text,
  segredo_definido_em timestamptz,
  segredo_definido_por text,
  ultimo_teste jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table imobdesk.integracoes is 'Integrações do Imobdesk. O segredo nunca fica aqui: só a referência ao Vault.';

drop trigger if exists integracoes_atualizado_em on imobdesk.integracoes;
create trigger integracoes_atualizado_em
  before update on imobdesk.integracoes
  for each row execute function imobdesk.definir_atualizado_em();

insert into imobdesk.integracoes (key, nome, descricao, ativo, remetente)
values ('resend', 'E-mail transacional', 'Resend · convites, redefinição de senha e avisos do sistema.', false,
        'Imobdesk <nao-responda@imobsystems.com.br>')
on conflict (key) do nothing;

-- ---------- Permissões de tabela (a RLS vem na migration 3/4) ----------

revoke all on imobdesk.perfis, imobdesk.usuarios, imobdesk.integracoes from anon, authenticated;
grant select on imobdesk.perfis, imobdesk.usuarios to authenticated;
-- Integrações: o segredo_id não é lido pelo front.
grant select (key, nome, descricao, ativo, remetente, enviar_emails_auth, segredo_mascara, segredo_definido_em,
              segredo_definido_por, ultimo_teste, created_at, updated_at)
  on imobdesk.integracoes to authenticated;
grant all on imobdesk.perfis, imobdesk.usuarios, imobdesk.integracoes to service_role;
