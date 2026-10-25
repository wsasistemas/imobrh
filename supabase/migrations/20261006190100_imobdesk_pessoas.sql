-- Configurações › Pessoas (estrutura do cadastro de pessoas da Movidesk). Pessoas são os clientes que abrem
-- chamados; os agentes continuam sendo os Usuários. Decisões do Wagner (06/10/2026):
--   * autocadastro pelo e-mail E pelo WhatsApp (at_pessoa_identificar, só service role);
--   * contato (tipo + valor normalizado) identifica uma pessoa só;
--   * remetente de domínio de empresa cadastrada nasce ligado a ela (domínios públicos nunca ligam);
--   * portal do cliente (usuário/senha) fica para depois.
-- Permissão: `manage_pessoas` (menu Configurações › Pessoas). Só aditiva; leitura e escrita por RPC.

-- ---------- CPF/CNPJ ----------
create or replace function imobdesk.at_documento_valido(p text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
  s int;
  r int;
  i int;
  pesos int[];
begin
  if length(d) = 11 then
    if d ~ '^(\d)\1{10}$' then return false; end if;
    s := 0; for i in 1..9 loop s := s + substr(d, i, 1)::int * (11 - i); end loop;
    r := (s * 10) % 11; if r = 10 then r := 0; end if;
    if r <> substr(d, 10, 1)::int then return false; end if;
    s := 0; for i in 1..10 loop s := s + substr(d, i, 1)::int * (12 - i); end loop;
    r := (s * 10) % 11; if r = 10 then r := 0; end if;
    return r = substr(d, 11, 1)::int;
  elsif length(d) = 14 then
    if d ~ '^(\d)\1{13}$' then return false; end if;
    pesos := array[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    s := 0; for i in 1..12 loop s := s + substr(d, i, 1)::int * pesos[i]; end loop;
    r := s % 11; r := case when r < 2 then 0 else 11 - r end;
    if r <> substr(d, 13, 1)::int then return false; end if;
    pesos := array[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    s := 0; for i in 1..13 loop s := s + substr(d, i, 1)::int * pesos[i]; end loop;
    r := s % 11; r := case when r < 2 then 0 else 11 - r end;
    return r = substr(d, 14, 1)::int;
  end if;
  return false;
end;
$$;

-- E-mail minúsculo; telefone só dígitos com DDI 55 quando vier com 10/11 dígitos.
create or replace function imobdesk.at_contato_normalizar(p_tipo text, p_valor text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_tipo = 'email' then lower(btrim(coalesce(p_valor, '')))
    else (select case when length(d) in (10, 11) then '55' || d else d end from (select regexp_replace(coalesce(p_valor, ''), '\D', '', 'g') d) x)
  end;
$$;

create or replace function imobdesk.at_dominio_publico(p_dominio text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(coalesce(p_dominio, '')) = any (array[
    'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.com.br', 'outlook.com', 'outlook.com.br', 'live.com', 'msn.com',
    'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br',
    'globo.com', 'globomail.com', 'r7.com', 'zipmail.com.br', 'protonmail.com', 'proton.me', 'aol.com'
  ]);
$$;

-- ---------- Tabelas ----------
create table if not exists imobdesk.at_pessoas (
  id                 bigint      generated always as identity primary key,
  tipo               text        not null default 'pessoa' check (tipo in ('pessoa', 'empresa', 'departamento')),
  nome               text        not null check (length(btrim(nome)) between 1 and 160),
  razao_social       text        check (length(razao_social) <= 160),
  ramo               text        check (length(ramo) <= 120),
  documento          text        check (documento ~ '^\d{11}$|^\d{14}$'),
  cod_ref            text        check (length(cod_ref) <= 80),
  cod_ref_adicional  text        check (length(cod_ref_adicional) <= 80),
  classificacao      text        not null default 'Cliente' check (length(classificacao) between 1 and 60),
  dominios           text[]      not null default '{}',
  sinalizadores      text[]      not null default '{}',
  observacoes        text        check (length(observacoes) <= 8000),
  avatar_path        text,
  habilitada         boolean     not null default true,
  origem             text        not null default 'manual' check (origem in ('manual', 'email', 'whatsapp', 'importacao')),
  origem_detalhe     text,
  ultimo_contato_em  timestamptz,
  criado_em          timestamptz not null default now(),
  criado_por         uuid,
  atualizado_em      timestamptz not null default now(),
  atualizado_por     uuid
);
create unique index if not exists at_pessoas_documento_uidx on imobdesk.at_pessoas (documento) where documento is not null;
create index if not exists at_pessoas_nome_idx on imobdesk.at_pessoas (lower(nome));
create index if not exists at_pessoas_dominios_idx on imobdesk.at_pessoas using gin (dominios);
create index if not exists at_pessoas_cod_ref_idx on imobdesk.at_pessoas (cod_ref) where cod_ref is not null;

create table if not exists imobdesk.at_pessoa_contatos (
  id         bigint      generated always as identity primary key,
  pessoa_id  bigint      not null references imobdesk.at_pessoas (id) on delete cascade,
  tipo       text        not null check (tipo in ('email', 'telefone', 'whatsapp')),
  valor      text        not null check (length(valor) between 3 and 160),
  principal  boolean     not null default false,
  criado_em  timestamptz not null default now(),
  unique (tipo, valor)
);
create index if not exists at_pessoa_contatos_pessoa_idx on imobdesk.at_pessoa_contatos (pessoa_id);

-- Pessoa ↔ empresa/departamento (pessoa_id é o membro; empresa_id é a empresa ou o departamento).
create table if not exists imobdesk.at_pessoa_relacoes (
  pessoa_id   bigint not null references imobdesk.at_pessoas (id) on delete cascade,
  empresa_id  bigint not null references imobdesk.at_pessoas (id) on delete cascade,
  cargo       text   check (length(cargo) <= 80),
  primary key (pessoa_id, empresa_id),
  check (pessoa_id <> empresa_id)
);
create index if not exists at_pessoa_relacoes_empresa_idx on imobdesk.at_pessoa_relacoes (empresa_id);

create table if not exists imobdesk.at_pessoa_anexos (
  id           bigint      generated always as identity primary key,
  pessoa_id    bigint      not null references imobdesk.at_pessoas (id) on delete cascade,
  nome         text        not null,
  path         text        not null unique,
  mime         text,
  tamanho      bigint,
  enviado_por  uuid,
  enviado_em   timestamptz not null default now()
);

-- Histórico: conversas do WhatsApp e e-mails recebidos apontam para a pessoa.
alter table imobdesk.at_conversas add column if not exists pessoa_id bigint references imobdesk.at_pessoas (id) on delete set null;
alter table imobdesk.at_email_recebidos add column if not exists pessoa_id bigint references imobdesk.at_pessoas (id) on delete set null;
create index if not exists at_conversas_pessoa_idx on imobdesk.at_conversas (pessoa_id) where pessoa_id is not null;
create index if not exists at_email_recebidos_pessoa_idx on imobdesk.at_email_recebidos (pessoa_id) where pessoa_id is not null;

do $$
declare
  t text;
begin
  foreach t in array array['at_pessoas', 'at_pessoa_contatos', 'at_pessoa_relacoes', 'at_pessoa_anexos'] loop
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

-- ---------- Bucket de anexos e imagens (privado, 20 MB) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('imobdesk-atendimento-pessoas', 'imobdesk-atendimento-pessoas', false, 20971520)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'atendimento-pessoas: leitura') then
    create policy "atendimento-pessoas: leitura" on storage.objects for select to authenticated
      using (bucket_id = 'imobdesk-atendimento-pessoas' and (select imobdesk.tem_permissao('manage_pessoas')));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'atendimento-pessoas: envio') then
    create policy "atendimento-pessoas: envio" on storage.objects for insert to authenticated
      with check (bucket_id = 'imobdesk-atendimento-pessoas' and (select imobdesk.tem_permissao('manage_pessoas')));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'atendimento-pessoas: exclusão') then
    create policy "atendimento-pessoas: exclusão" on storage.objects for delete to authenticated
      using (bucket_id = 'imobdesk-atendimento-pessoas' and (select imobdesk.tem_permissao('manage_pessoas')));
  end if;
end;
$$;

-- ---------- Acesso ----------
create or replace function imobdesk.at_exigir_pessoas()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not imobdesk.tem_permissao('manage_pessoas') then
    perform imobdesk.erro('FORBIDDEN', 'Você não tem permissão para o cadastro de Pessoas.');
  end if;
  return auth.uid();
end;
$$;

-- ---------- Lista ----------
-- p: {busca?, tipo?, origem?, pagina?, porPagina?}
create or replace function imobdesk.at_pessoas_lista(p jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_busca text := lower(btrim(coalesce(p ->> 'busca', '')));
  v_digitos text := regexp_replace(coalesce(p ->> 'busca', ''), '\D', '', 'g');
  v_tipo text := nullif(p ->> 'tipo', '');
  v_origem text := nullif(p ->> 'origem', '');
  v_por int := least(greatest(coalesce((p ->> 'porPagina')::int, 25), 5), 100);
  v_pag int := greatest(coalesce((p ->> 'pagina')::int, 1), 1);
  v_total int;
  v_linhas jsonb;
begin
  perform imobdesk.at_exigir_pessoas();
  with filtro as (
    select ps.* from imobdesk.at_pessoas ps
    where (v_tipo is null or ps.tipo = v_tipo)
      and (v_origem is null or ps.origem = v_origem)
      and (length(v_busca) < 3
           or lower(ps.nome) like '%' || v_busca || '%'
           or lower(coalesce(ps.razao_social, '')) like '%' || v_busca || '%'
           or lower(coalesce(ps.cod_ref, '')) like '%' || v_busca || '%'
           or lower(coalesce(ps.cod_ref_adicional, '')) like '%' || v_busca || '%'
           or (length(v_digitos) >= 3 and ps.documento like '%' || v_digitos || '%')
           or exists (select 1 from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id
                      and (c.valor like '%' || v_busca || '%' or (length(v_digitos) >= 4 and c.valor like '%' || v_digitos || '%'))))
  )
  select count(*) into v_total from filtro;
  with filtro as (
    select ps.* from imobdesk.at_pessoas ps
    where (v_tipo is null or ps.tipo = v_tipo)
      and (v_origem is null or ps.origem = v_origem)
      and (length(v_busca) < 3
           or lower(ps.nome) like '%' || v_busca || '%'
           or lower(coalesce(ps.razao_social, '')) like '%' || v_busca || '%'
           or lower(coalesce(ps.cod_ref, '')) like '%' || v_busca || '%'
           or lower(coalesce(ps.cod_ref_adicional, '')) like '%' || v_busca || '%'
           or (length(v_digitos) >= 3 and ps.documento like '%' || v_digitos || '%')
           or exists (select 1 from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id
                      and (c.valor like '%' || v_busca || '%' or (length(v_digitos) >= 4 and c.valor like '%' || v_digitos || '%'))))
    order by ps.habilitada desc, coalesce(ps.ultimo_contato_em, ps.criado_em) desc, ps.id desc
    limit v_por offset (v_pag - 1) * v_por
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id, 'tipo', f.tipo, 'nome', f.nome, 'documento', f.documento, 'codRef', f.cod_ref, 'origem', f.origem, 'habilitada', f.habilitada,
    'ultimoContatoEm', f.ultimo_contato_em, 'avatarPath', f.avatar_path,
    'email', (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = f.id and c.tipo = 'email' order by c.principal desc, c.id limit 1),
    'telefone', (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = f.id and c.tipo <> 'email' order by c.principal desc, c.id limit 1),
    'empresa', (select e.nome from imobdesk.at_pessoa_relacoes r join imobdesk.at_pessoas e on e.id = r.empresa_id where r.pessoa_id = f.id order by e.nome limit 1),
    'chamados', (select count(*) from imobdesk.at_atendimentos a join imobdesk.at_conversas cv on cv.id = a.conversa_id where cv.pessoa_id = f.id)
              + (select count(*) from imobdesk.at_email_recebidos er where er.pessoa_id = f.id)
  )), '[]') into v_linhas
  from filtro f;
  return jsonb_build_object('total', v_total, 'pagina', v_pag, 'porPagina', v_por, 'linhas', v_linhas);
end;
$$;

-- Busca rápida para o seletor de Relações.
create or replace function imobdesk.at_pessoas_busca(p_busca text, p_tipos text[] default null)
returns table (id bigint, nome text, tipo text, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform imobdesk.at_exigir_pessoas();
  return query
    select ps.id, ps.nome, ps.tipo,
           (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id and c.tipo = 'email' order by c.principal desc, c.id limit 1)
    from imobdesk.at_pessoas ps
    where (p_tipos is null or ps.tipo = any (p_tipos))
      and (lower(ps.nome) like '%' || lower(btrim(coalesce(p_busca, ''))) || '%'
           or exists (select 1 from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id and c.valor like '%' || lower(btrim(coalesce(p_busca, ''))) || '%'))
    order by ps.nome
    limit 20;
end;
$$;

-- ---------- Detalhe (com contatos, relações, anexos e histórico) ----------
create or replace function imobdesk.at_pessoa_detalhe(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ps imobdesk.at_pessoas;
  v_grupo bigint[];
begin
  perform imobdesk.at_exigir_pessoas();
  select * into ps from imobdesk.at_pessoas where id = p_id;
  if ps.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
  end if;
  -- Histórico da empresa inclui as pessoas relacionadas a ela.
  v_grupo := array[ps.id] || coalesce((select array_agg(r.pessoa_id) from imobdesk.at_pessoa_relacoes r where r.empresa_id = ps.id), '{}');
  return jsonb_build_object(
    'id', ps.id, 'tipo', ps.tipo, 'nome', ps.nome, 'razaoSocial', ps.razao_social, 'ramo', ps.ramo, 'documento', ps.documento,
    'codRef', ps.cod_ref, 'codRefAdicional', ps.cod_ref_adicional, 'classificacao', ps.classificacao, 'dominios', to_jsonb(ps.dominios),
    'sinalizadores', to_jsonb(ps.sinalizadores), 'observacoes', ps.observacoes, 'avatarPath', ps.avatar_path, 'habilitada', ps.habilitada,
    'origem', ps.origem, 'origemDetalhe', ps.origem_detalhe, 'ultimoContatoEm', ps.ultimo_contato_em, 'criadoEm', ps.criado_em,
    'criadoPor', (select u.nome from imobdesk.usuarios u where u.id = ps.criado_por),
    'contatos', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'tipo', c.tipo, 'valor', c.valor, 'principal', c.principal) order by c.tipo, c.principal desc, c.id)
                          from imobdesk.at_pessoa_contatos c where c.pessoa_id = ps.id), '[]'),
    'relacoes', coalesce((
      select jsonb_agg(jsonb_build_object('pessoaId', o.id, 'nome', o.nome, 'tipo', o.tipo, 'cargo', x.cargo,
                                          'email', (select c.valor from imobdesk.at_pessoa_contatos c where c.pessoa_id = o.id and c.tipo = 'email' order by c.principal desc, c.id limit 1)) order by o.nome)
      from (select r.empresa_id as outro, r.cargo from imobdesk.at_pessoa_relacoes r where r.pessoa_id = ps.id
            union all
            select r.pessoa_id, r.cargo from imobdesk.at_pessoa_relacoes r where r.empresa_id = ps.id) x
      join imobdesk.at_pessoas o on o.id = x.outro), '[]'),
    'anexos', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome, 'path', a.path, 'mime', a.mime, 'tamanho', a.tamanho,
                                                            'enviadoPor', (select u.nome from imobdesk.usuarios u where u.id = a.enviado_por), 'enviadoEm', a.enviado_em) order by a.enviado_em desc)
                        from imobdesk.at_pessoa_anexos a where a.pessoa_id = ps.id), '[]'),
    'historico', coalesce((
      select jsonb_agg(h order by h ->> 'em' desc) from (
        select jsonb_build_object('canal', 'whatsapp', 'ticket', a.id, 'titulo', coalesce(cv.ultima_previa, 'Conversa no WhatsApp'),
               'setor', s.nome, 'atendente', u.nome, 'pessoa', pp.nome, 'em', a.entrou_fila_em,
               'situacao', case when a.encerrado_em is null then 'andamento' else 'encerrado' end) h
        from imobdesk.at_atendimentos a
        join imobdesk.at_conversas cv on cv.id = a.conversa_id
        join imobdesk.at_setores s on s.id = a.setor_id
        join imobdesk.at_pessoas pp on pp.id = cv.pessoa_id
        left join imobdesk.usuarios u on u.id = a.atendente_id
        where cv.pessoa_id = any (v_grupo)
        union all
        select jsonb_build_object('canal', 'email', 'ticket', null, 'titulo', coalesce(er.assunto, '(sem assunto)'),
               'setor', s.nome, 'atendente', null, 'pessoa', pp.nome, 'em', er.recebido_em,
               'situacao', case er.estado when 'pendente' then 'andamento' when 'ignorado' then 'ignorado' else 'encerrado' end)
        from imobdesk.at_email_recebidos er
        join imobdesk.at_email_contas ec on ec.id = er.conta_id
        join imobdesk.at_setores s on s.id = ec.setor_id
        join imobdesk.at_pessoas pp on pp.id = er.pessoa_id
        where er.pessoa_id = any (v_grupo)
        order by 1 desc
        limit 200
      ) z), '[]')
  );
end;
$$;

-- ---------- Salvar ----------
-- p: {id?, tipo, nome, razaoSocial, ramo, documento, codRef, codRefAdicional, classificacao, dominios[], sinalizadores[],
--     observacoes, avatarPath, habilitada, contatos: [{tipo, valor, principal}], relacoes: [{pessoaId, cargo}]}
-- Relações: se esta ficha é pessoa, os outros são as empresas dela; se é empresa/departamento, os outros são os membros.
create or replace function imobdesk.at_pessoa_salvar(p jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_pessoas();
  v_id bigint := nullif(p ->> 'id', '')::bigint;
  v_tipo text := coalesce(nullif(p ->> 'tipo', ''), 'pessoa');
  v_nome text := btrim(coalesce(p ->> 'nome', ''));
  v_doc text := nullif(regexp_replace(coalesce(p ->> 'documento', ''), '\D', '', 'g'), '');
  v_dominios text[];
  v_antes jsonb;
  c jsonb;
  v_valor text;
  v_dono text;
  r jsonb;
  v_outro bigint;
  v_outro_tipo text;
begin
  if v_tipo not in ('pessoa', 'empresa', 'departamento') then
    perform imobdesk.erro('INVALID_INPUT', 'Tipo inválido.', 'tipo');
  end if;
  if length(v_nome) not between 1 and 160 then
    perform imobdesk.erro('INVALID_INPUT', 'Informe o nome.', 'nome');
  end if;
  if v_doc is not null then
    if v_tipo = 'pessoa' and length(v_doc) <> 11 or v_tipo <> 'pessoa' and length(v_doc) <> 14 then
      perform imobdesk.erro('INVALID_INPUT', case when v_tipo = 'pessoa' then 'CPF precisa ter 11 dígitos.' else 'CNPJ precisa ter 14 dígitos.' end, 'documento');
    end if;
    if not imobdesk.at_documento_valido(v_doc) then
      perform imobdesk.erro('INVALID_INPUT', case when v_tipo = 'pessoa' then 'CPF inválido (dígito verificador não confere).' else 'CNPJ inválido (dígito verificador não confere).' end, 'documento');
    end if;
    select ps.nome into v_dono from imobdesk.at_pessoas ps where ps.documento = v_doc and ps.id is distinct from v_id;
    if v_dono is not null then
      perform imobdesk.erro('DUPLICATE', format('Esse documento já está cadastrado em "%s". Use Mesclar pessoa se for a mesma.', v_dono), 'documento');
    end if;
  end if;
  select coalesce(array_agg(distinct lower(btrim(x, ' @'))) filter (where btrim(x, ' @') <> ''), '{}') into v_dominios
  from jsonb_array_elements_text(coalesce(p -> 'dominios', '[]')) x;
  if v_tipo = 'pessoa' then
    v_dominios := '{}';
  elsif exists (select 1 from unnest(v_dominios) d where imobdesk.at_dominio_publico(d)) then
    perform imobdesk.erro('INVALID_INPUT', 'Domínio público (gmail, hotmail, outlook…) não identifica empresa.', 'dominios');
  end if;
  -- Contatos: válidos e de ninguém mais.
  for c in select * from jsonb_array_elements(coalesce(p -> 'contatos', '[]')) loop
    if c ->> 'tipo' not in ('email', 'telefone', 'whatsapp') then
      perform imobdesk.erro('INVALID_INPUT', 'Tipo de contato inválido.', 'contatos');
    end if;
    v_valor := imobdesk.at_contato_normalizar(c ->> 'tipo', c ->> 'valor');
    if c ->> 'tipo' = 'email' and v_valor !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      perform imobdesk.erro('INVALID_INPUT', format('E-mail inválido: %s', c ->> 'valor'), 'contatos');
    end if;
    if c ->> 'tipo' <> 'email' and v_valor !~ '^\d{10,15}$' then
      perform imobdesk.erro('INVALID_INPUT', format('Telefone inválido: %s (use DDD + número).', c ->> 'valor'), 'contatos');
    end if;
    select ps.nome into v_dono from imobdesk.at_pessoa_contatos ct join imobdesk.at_pessoas ps on ps.id = ct.pessoa_id
    where ct.tipo = c ->> 'tipo' and ct.valor = v_valor and ct.pessoa_id is distinct from v_id;
    if v_dono is not null then
      perform imobdesk.erro('DUPLICATE', format('O contato %s já pertence a "%s". Use Mesclar pessoa se for a mesma.', c ->> 'valor', v_dono), 'contatos');
    end if;
  end loop;

  begin
    if v_id is null then
      insert into imobdesk.at_pessoas (tipo, nome, criado_por, atualizado_por) values (v_tipo, v_nome, v_ator, v_ator) returning id into v_id;
    else
      select to_jsonb(x) into v_antes from imobdesk.at_pessoas x where x.id = v_id;
      if v_antes is null then
        perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
      end if;
    end if;
    update imobdesk.at_pessoas x set
      tipo = v_tipo, nome = v_nome,
      razao_social = case when v_tipo = 'pessoa' then null else nullif(btrim(p ->> 'razaoSocial'), '') end,
      ramo = case when v_tipo = 'pessoa' then null else nullif(btrim(p ->> 'ramo'), '') end,
      documento = v_doc,
      cod_ref = nullif(btrim(p ->> 'codRef'), ''),
      cod_ref_adicional = nullif(btrim(p ->> 'codRefAdicional'), ''),
      classificacao = coalesce(nullif(btrim(p ->> 'classificacao'), ''), 'Cliente'),
      dominios = v_dominios,
      sinalizadores = coalesce((select array_agg(distinct btrim(s)) filter (where btrim(s) <> '') from jsonb_array_elements_text(coalesce(p -> 'sinalizadores', '[]')) s), '{}'),
      observacoes = nullif(p ->> 'observacoes', ''),
      avatar_path = case when p ? 'avatarPath' then nullif(p ->> 'avatarPath', '') else x.avatar_path end,
      habilitada = coalesce((p ->> 'habilitada')::boolean, x.habilitada),
      atualizado_em = now(), atualizado_por = v_ator
    where x.id = v_id;
  exception when check_violation then
    perform imobdesk.erro('INVALID_INPUT', 'Algum campo passou do tamanho permitido.');
  end;

  -- Contatos: troca o conjunto (o primeiro de cada grupo vira principal se nenhum vier marcado).
  delete from imobdesk.at_pessoa_contatos where pessoa_id = v_id;
  insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal)
  select v_id, x.tipo, x.valor, coalesce(x.principal, false)
  from (select distinct on (e ->> 'tipo', imobdesk.at_contato_normalizar(e ->> 'tipo', e ->> 'valor'))
               e ->> 'tipo' as tipo, imobdesk.at_contato_normalizar(e ->> 'tipo', e ->> 'valor') as valor, (e ->> 'principal')::boolean as principal
        from jsonb_array_elements(coalesce(p -> 'contatos', '[]')) e) x;
  update imobdesk.at_pessoa_contatos ct set principal = true
  where ct.pessoa_id = v_id
    and ct.id = (select min(c2.id) from imobdesk.at_pessoa_contatos c2 where c2.pessoa_id = v_id and (c2.tipo = 'email') = (ct.tipo = 'email'))
    and not exists (select 1 from imobdesk.at_pessoa_contatos c3 where c3.pessoa_id = v_id and c3.principal and (c3.tipo = 'email') = (ct.tipo = 'email'));

  -- Relações (do lado desta ficha).
  if p ? 'relacoes' then
    if v_tipo = 'pessoa' then
      delete from imobdesk.at_pessoa_relacoes where pessoa_id = v_id;
    else
      delete from imobdesk.at_pessoa_relacoes where empresa_id = v_id;
    end if;
    for r in select * from jsonb_array_elements(p -> 'relacoes') loop
      v_outro := (r ->> 'pessoaId')::bigint;
      select ps.tipo into v_outro_tipo from imobdesk.at_pessoas ps where ps.id = v_outro;
      if v_outro_tipo is null or v_outro = v_id then
        perform imobdesk.erro('INVALID_INPUT', 'Relação com uma ficha que não existe.', 'relacoes');
      end if;
      if v_tipo = 'pessoa' then
        if v_outro_tipo = 'pessoa' then
          perform imobdesk.erro('INVALID_INPUT', 'Uma pessoa se relaciona com uma empresa ou um departamento.', 'relacoes');
        end if;
        insert into imobdesk.at_pessoa_relacoes (pessoa_id, empresa_id, cargo) values (v_id, v_outro, nullif(btrim(r ->> 'cargo'), ''))
        on conflict (pessoa_id, empresa_id) do update set cargo = excluded.cargo;
      else
        insert into imobdesk.at_pessoa_relacoes (pessoa_id, empresa_id, cargo) values (v_outro, v_id, nullif(btrim(r ->> 'cargo'), ''))
        on conflict (pessoa_id, empresa_id) do update set cargo = excluded.cargo;
      end if;
    end loop;
  end if;

  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', case when v_antes is null then 'create' else 'update' end,
    format('Pessoa "%s" %s', v_nome, case when v_antes is null then 'cadastrada' else 'alterada' end), v_antes,
    (select to_jsonb(x) from imobdesk.at_pessoas x where x.id = v_id), v_id::text);
  return v_id;
end;
$$;

-- ---------- Mesclar (a ficha `p_sai` é incorporada em `p_fica`) ----------
create or replace function imobdesk.at_pessoa_mesclar(p_fica bigint, p_sai bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_pessoas();
  f imobdesk.at_pessoas;
  s imobdesk.at_pessoas;
begin
  if p_fica = p_sai then
    perform imobdesk.erro('INVALID_INPUT', 'Escolha duas fichas diferentes.');
  end if;
  select * into f from imobdesk.at_pessoas where id = p_fica;
  select * into s from imobdesk.at_pessoas where id = p_sai;
  if f.id is null or s.id is null then
    perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
  end if;
  -- Contatos que a ficha que fica ainda não tem.
  update imobdesk.at_pessoa_contatos c set pessoa_id = p_fica, principal = false
  where c.pessoa_id = p_sai
    and not exists (select 1 from imobdesk.at_pessoa_contatos x where x.pessoa_id = p_fica and x.tipo = c.tipo and x.valor = c.valor);
  -- Relações (sem duplicar e sem relacionar a ficha com ela mesma).
  insert into imobdesk.at_pessoa_relacoes (pessoa_id, empresa_id, cargo)
  select case when r.pessoa_id = p_sai then p_fica else r.pessoa_id end, case when r.empresa_id = p_sai then p_fica else r.empresa_id end, r.cargo
  from imobdesk.at_pessoa_relacoes r
  where (r.pessoa_id = p_sai or r.empresa_id = p_sai)
    and (case when r.pessoa_id = p_sai then p_fica else r.pessoa_id end) <> (case when r.empresa_id = p_sai then p_fica else r.empresa_id end)
  on conflict do nothing;
  update imobdesk.at_pessoa_anexos set pessoa_id = p_fica where pessoa_id = p_sai;
  update imobdesk.at_conversas set pessoa_id = p_fica where pessoa_id = p_sai;
  update imobdesk.at_email_recebidos set pessoa_id = p_fica where pessoa_id = p_sai;
  update imobdesk.at_pessoas x set
    razao_social = coalesce(x.razao_social, s.razao_social), ramo = coalesce(x.ramo, s.ramo),
    cod_ref = coalesce(x.cod_ref, s.cod_ref), cod_ref_adicional = coalesce(x.cod_ref_adicional, s.cod_ref_adicional),
    dominios = (select coalesce(array_agg(distinct d), '{}') from unnest(x.dominios || s.dominios) d),
    sinalizadores = (select coalesce(array_agg(distinct d), '{}') from unnest(x.sinalizadores || s.sinalizadores) d),
    observacoes = nullif(concat_ws(E'\n\n', x.observacoes, s.observacoes), ''),
    avatar_path = coalesce(x.avatar_path, s.avatar_path),
    ultimo_contato_em = greatest(x.ultimo_contato_em, s.ultimo_contato_em),
    atualizado_em = now(), atualizado_por = v_ator
  where x.id = p_fica;
  -- O documento passa depois de apagar a ficha que sai (é único).
  delete from imobdesk.at_pessoas where id = p_sai;
  if f.documento is null and s.documento is not null then
    update imobdesk.at_pessoas set documento = s.documento where id = p_fica;
  end if;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'update', format('Pessoa "%s" incorporada em "%s"', s.nome, f.nome),
    to_jsonb(s), jsonb_build_object('fica', p_fica), p_fica::text);
end;
$$;

create or replace function imobdesk.at_pessoa_excluir(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_pessoas();
  v_antes jsonb;
  v_paths jsonb;
begin
  select to_jsonb(x) into v_antes from imobdesk.at_pessoas x where x.id = p_id;
  if v_antes is null then
    perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
  end if;
  if exists (select 1 from imobdesk.at_conversas c where c.pessoa_id = p_id)
     or exists (select 1 from imobdesk.at_email_recebidos e where e.pessoa_id = p_id) then
    perform imobdesk.erro('INVALID_INPUT', 'Esta pessoa já tem chamados no histórico. Desabilite em vez de excluir.');
  end if;
  -- Devolve os arquivos para a tela apagar do Storage.
  select coalesce(jsonb_agg(a.path), '[]')
         || case when v_antes ->> 'avatar_path' is null then '[]'::jsonb else jsonb_build_array(v_antes ->> 'avatar_path') end
    into v_paths from imobdesk.at_pessoa_anexos a where a.pessoa_id = p_id;
  delete from imobdesk.at_pessoas where id = p_id;
  perform imobdesk.registrar_auditoria(v_ator, 'atendimento', 'delete', format('Pessoa "%s" excluída', v_antes ->> 'nome'), v_antes, null, p_id::text);
  return jsonb_build_object('arquivos', v_paths);
end;
$$;

-- ---------- Anexos ----------
create or replace function imobdesk.at_pessoa_anexo_registrar(p_pessoa bigint, p_nome text, p_path text, p_mime text, p_tamanho bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := imobdesk.at_exigir_pessoas();
  v_id bigint;
begin
  if not exists (select 1 from imobdesk.at_pessoas where id = p_pessoa) then
    perform imobdesk.erro('NOT_FOUND', 'Pessoa não encontrada.');
  end if;
  if p_path !~ ('^pessoas/' || p_pessoa || '/') then
    perform imobdesk.erro('INVALID_INPUT', 'Caminho do anexo inválido.');
  end if;
  insert into imobdesk.at_pessoa_anexos (pessoa_id, nome, path, mime, tamanho, enviado_por)
  values (p_pessoa, left(btrim(p_nome), 200), p_path, p_mime, p_tamanho, v_ator) returning id into v_id;
  return v_id;
end;
$$;

create or replace function imobdesk.at_pessoa_anexo_remover(p_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  perform imobdesk.at_exigir_pessoas();
  delete from imobdesk.at_pessoa_anexos where id = p_id returning path into v_path;
  if v_path is null then
    perform imobdesk.erro('NOT_FOUND', 'Anexo não encontrado.');
  end if;
  return v_path;
end;
$$;

-- ---------- Autocadastro (só Edge Functions: leitura de e-mail e webhook do WhatsApp) ----------
-- Acha a pessoa pelo contato ou cria. E-mail de domínio de empresa cadastrada já nasce relacionado a ela.
create or replace function imobdesk.at_pessoa_identificar(p_tipo text, p_valor text, p_nome text default null, p_origem_detalhe text default null)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tipo text := case when p_tipo = 'email' then 'email' else 'whatsapp' end;
  v_valor text := imobdesk.at_contato_normalizar(v_tipo, p_valor);
  v_id bigint;
  v_dominio text;
  v_empresa bigint;
begin
  if v_tipo = 'email' and v_valor !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or v_tipo = 'whatsapp' and v_valor !~ '^\d{10,15}$' then
    return null;
  end if;
  -- O mesmo número pode estar cadastrado como "telefone" ou "whatsapp".
  select c.pessoa_id into v_id from imobdesk.at_pessoa_contatos c
  where c.valor = v_valor and (c.tipo = v_tipo or (v_tipo = 'whatsapp' and c.tipo = 'telefone'))
  order by (c.tipo = v_tipo) desc limit 1;
  if v_id is not null then
    update imobdesk.at_pessoas set ultimo_contato_em = now() where id = v_id;
    return v_id;
  end if;
  insert into imobdesk.at_pessoas (tipo, nome, origem, origem_detalhe, ultimo_contato_em)
  values ('pessoa', coalesce(nullif(left(btrim(p_nome), 160), ''), case when v_tipo = 'email' then v_valor else '+' || v_valor end),
          case when v_tipo = 'email' then 'email' else 'whatsapp' end, p_origem_detalhe, now())
  returning id into v_id;
  insert into imobdesk.at_pessoa_contatos (pessoa_id, tipo, valor, principal) values (v_id, v_tipo, v_valor, true);
  if v_tipo = 'email' then
    v_dominio := split_part(v_valor, '@', 2);
    if not imobdesk.at_dominio_publico(v_dominio) then
      select e.id into v_empresa from imobdesk.at_pessoas e
      where e.tipo <> 'pessoa' and e.habilitada and v_dominio = any (e.dominios) order by e.id limit 1;
      if v_empresa is not null then
        insert into imobdesk.at_pessoa_relacoes (pessoa_id, empresa_id) values (v_id, v_empresa) on conflict do nothing;
      end if;
    end if;
  end if;
  return v_id;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'imobdesk.at_exigir_pessoas()', 'imobdesk.at_pessoas_lista(jsonb)', 'imobdesk.at_pessoas_busca(text, text[])',
    'imobdesk.at_pessoa_detalhe(bigint)', 'imobdesk.at_pessoa_salvar(jsonb)', 'imobdesk.at_pessoa_mesclar(bigint, bigint)',
    'imobdesk.at_pessoa_excluir(bigint)', 'imobdesk.at_pessoa_anexo_registrar(bigint, text, text, text, bigint)',
    'imobdesk.at_pessoa_anexo_remover(bigint)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  revoke execute on function imobdesk.at_pessoa_identificar(text, text, text, text) from public, anon, authenticated;
  grant execute on function imobdesk.at_pessoa_identificar(text, text, text, text) to service_role;
  revoke execute on function imobdesk.at_documento_valido(text), imobdesk.at_contato_normalizar(text, text),
    imobdesk.at_dominio_publico(text) from public, anon;
  grant execute on function imobdesk.at_documento_valido(text), imobdesk.at_contato_normalizar(text, text),
    imobdesk.at_dominio_publico(text) to authenticated, service_role;
end;
$$;

do $$
begin
  if to_regclass('acessos.aplicativos') is not null then
    if exists (select 1 from acessos.aplicativos a where a.schema_name = 'imobdesk' and a.controle_ativo) then
      perform acessos.aplicar_protecao('imobdesk', true);
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';
