-- Segurança do login (Security Gateway) do Imobdesk — etapa 1 de 2.
--
-- Esta etapa não muda o acesso de ninguém: cria as tabelas, o gateway e a regra de sessão confiável.
-- A etapa 2 (20261009120100_..._sessao_obrigatoria.sql) é que liga a regra na RLS, depois do deploy
-- da Edge Function e do front (ordem em docs/SEGURANCA-LOGIN.md).
--
-- Divisão de responsabilidades (docs/SEGURANCA-LOGIN.md):
--   * Supabase Auth  = identidade, senha, sessão e tokens. Nada aqui guarda ou compara senha.
--   * Este arquivo   = tentativas, bloqueios, rate limit, risco e auditoria (decide se a tentativa
--                      pode chegar ao Auth). Quem chama é a Edge Function imobdesk-auth.
--   * RLS            = o que cada sessão enxerga. Sessão de senha só vale no portal se passou
--                      pelo gateway (security_sessions); assim um login feito direto na API do
--                      Auth, contornando o gateway, não lê nem grava nada do portal.
--
-- Não altera nada no schema auth (é compartilhado com os outros sistemas da WSA): só lê
-- auth.users (e-mail para o hook) e auth.sessions (sessão ainda existe?).
--
-- Atomicidade: security_auth_begin/finish travam IP e conta com pg_advisory_xact_lock (sempre na
-- ordem IP -> conta, sem deadlock) e a linha da conta com FOR UPDATE. Além disso, cada conta só tem
-- UMA tentativa em andamento por vez (inflight_until): 50 requisições simultâneas na mesma conta
-- resultam em 1 chamada ao Auth e 49 negadas.

create extension if not exists pgcrypto with schema extensions;

-- ============================================================================================
-- Tabelas (nenhuma é acessível pelo front: RLS ligada, sem policy e sem grant para anon/authenticated)
-- ============================================================================================

-- Limites ajustáveis sem deploy (update direto no SQL editor, com service_role/postgres).
create table if not exists imobdesk.security_config (
  key text primary key,
  value integer not null check (value >= 0),
  descricao text not null
);

insert into imobdesk.security_config (key, value, descricao) values
  ('account_max_failures',       5,    'Falhas consecutivas por conta até o bloqueio'),
  ('account_lock_1_min',         15,   '1º bloqueio (minutos)'),
  ('account_lock_2_min',         30,   '2º bloqueio (minutos)'),
  ('account_lock_3_min',         60,   '3º bloqueio em diante (minutos)'),
  ('account_lock_decay_hours',   24,   'Horas sem falha para o nível de bloqueio voltar a zero'),
  ('account_backoff_base_ms',    1000, 'Espera após a 1ª falha; dobra a cada falha (1s, 2s, 4s, 8s)'),
  ('account_inflight_seconds',   15,   'Reserva da conta enquanto a tentativa está no Auth'),
  ('account_attempts_15m',       20,   'Tentativas por conta em 15 min, somando todos os IPs'),
  ('ip_attempts_1m',             10,   'Tentativas por IP em 1 min'),
  ('ip_attempts_15m',            30,   'Tentativas por IP em 15 min'),
  ('ip_attempts_1h',             100,  'Tentativas por IP em 1 h'),
  ('ip_account_attempts_15m',    5,    'Tentativas do mesmo IP na mesma conta em 15 min'),
  ('spray_accounts_5m',          10,   'Contas diferentes pelo mesmo IP em 5 min (password spraying)'),
  ('spray_block_min',            30,   'Bloqueio do IP ao detectar spraying (minutos)'),
  ('distributed_ips_15m',        5,    'IPs diferentes na mesma conta em 15 min (ataque distribuído)'),
  ('velocity_window_ms',         2000, 'Janela para detectar rajada de requisições do mesmo IP'),
  ('velocity_max',               3,    'Requisições do mesmo IP dentro da janela de rajada'),
  ('risk_cooldown',              30,   'Risco a partir do qual exige intervalo mínimo entre tentativas'),
  ('risk_cooldown_seconds',      5,    'Intervalo mínimo exigido no cooldown por risco'),
  ('risk_block',                 60,   'Risco a partir do qual bloqueia o IP'),
  ('risk_block_min',             15,   'Bloqueio do IP por risco alto (minutos)'),
  ('risk_critical',              80,   'Risco crítico: bloqueio ampliado + evento crítico'),
  ('risk_critical_block_min',    60,   'Bloqueio do IP por risco crítico (minutos)'),
  ('recover_ip_15m',             5,    'Pedidos de redefinição de senha por IP em 15 min'),
  ('recover_account_1h',         3,    'Pedidos de redefinição de senha por conta em 1 h'),
  ('hook_counts_failures',       0,    '1 quando o Password Verification Hook está ligado no Auth (evita contar a falha duas vezes)'),
  ('attempts_retention_hours',   48,   'Horas que as tentativas brutas ficam guardadas'),
  ('events_retention_days',      180,  'Dias que os eventos de segurança ficam guardados')
on conflict (key) do nothing;

-- Pepper do HMAC de e-mail e IP. Gerado no banco, nunca sai dele (nem para a Edge Function).
create table if not exists imobdesk.security_secret (
  id smallint primary key default 1 check (id = 1),
  pepper bytea not null default extensions.gen_random_bytes(32),
  created_at timestamptz not null default now()
);
insert into imobdesk.security_secret (id) values (1) on conflict (id) do nothing;

-- Estado por conta. A chave é o HMAC do e-mail normalizado: vale também para e-mail inexistente,
-- então bloqueio e limites não revelam se a conta existe. Nunca guarda senha, hash de senha ou token.
create table if not exists imobdesk.security_auth_control (
  user_hash text primary key,
  user_id uuid,
  failed_attempts integer not null default 0,
  lock_level integer not null default 0,
  locked_until timestamptz,
  next_allowed_at timestamptz,
  inflight_until timestamptz,
  last_failed_at timestamptz,
  last_hook_failure_at timestamptz,
  last_success_at timestamptz,
  last_lock_at timestamptz,
  risk_score integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists security_auth_control_user_id on imobdesk.security_auth_control (user_id) where user_id is not null;

-- Toda tentativa (permitida ou negada). Base dos limites por IP, conta e IP+conta e da detecção
-- de spraying/distribuído. Vida curta (attempts_retention_hours).
create table if not exists imobdesk.security_attempts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  kind text not null check (kind in ('login', 'recover')),
  ip_hash text not null,
  user_hash text not null,
  outcome text not null check (outcome in ('pending', 'success', 'failure', 'denied', 'error')),
  reason text,
  risk_score integer not null default 0,
  request_id uuid,
  finished_at timestamptz
);
create index if not exists security_attempts_ip on imobdesk.security_attempts (ip_hash, created_at desc);
create index if not exists security_attempts_user on imobdesk.security_attempts (user_hash, created_at desc);
create index if not exists security_attempts_created on imobdesk.security_attempts (created_at);

create table if not exists imobdesk.security_ip_blocks (
  ip_hash text primary key,
  blocked_until timestamptz not null,
  reason text not null,
  block_count integer not null default 1,
  last_block_at timestamptz not null default now()
);

-- Auditoria permanente. E-mail só mascarado; IP só o prefixo (/24 ou /48) + HMAC.
create table if not exists imobdesk.security_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event_type text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  request_id uuid,
  ip_hash text,
  ip_prefix text,
  user_hash text,
  user_id uuid,
  email_masked text,
  reason_code text,
  risk_score integer,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists security_events_created on imobdesk.security_events (created_at desc);
create index if not exists security_events_type on imobdesk.security_events (event_type, created_at desc);
create index if not exists security_events_user on imobdesk.security_events (user_id, created_at desc) where user_id is not null;

-- Sessões de senha emitidas pelo gateway. Só o id da sessão do Auth (nunca token).
create table if not exists imobdesk.security_sessions (
  session_id uuid primary key,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  ip_hash text,
  revoked_at timestamptz,
  revoked_reason text
);
create index if not exists security_sessions_user on imobdesk.security_sessions (user_id);

do $$
declare
  t text;
begin
  foreach t in array array['security_config', 'security_secret', 'security_auth_control', 'security_attempts',
                           'security_ip_blocks', 'security_events', 'security_sessions'] loop
    -- RLS ligada e nenhuma policy: anon/authenticated não leem nem gravam nada, nem com grant futuro.
    execute format('alter table imobdesk.%I enable row level security', t);
    execute format('revoke all on imobdesk.%I from anon, public, authenticated', t);
    execute format('grant all on imobdesk.%I to service_role', t);
  end loop;
end;
$$;

-- ============================================================================================
-- Funções internas (sem grant para ninguém além do dono)
-- ============================================================================================

create or replace function imobdesk.security_cfg(p_key text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v integer;
begin
  select c.value into v from imobdesk.security_config c where c.key = p_key;
  -- Fail closed: limite sem valor é erro, nunca "sem limite".
  if v is null then
    raise exception 'security_config sem a chave %', p_key;
  end if;
  return v;
end;
$$;

create or replace function imobdesk.security_hash(p_kind text, p_value text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(extensions.hmac(convert_to(p_kind || ':' || p_value, 'UTF8'), s.pepper, 'sha256'), 'hex')
  from imobdesk.security_secret s
  where s.id = 1;
$$;

create or replace function imobdesk.security_normalize_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(trim(coalesce(p_email, '')));
$$;

create or replace function imobdesk.security_mask_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when position('@' in coalesce(p_email, '')) < 2 then null
    else left(p_email, 1) || '***' || substr(p_email, position('@' in p_email) - 1, 1) || substr(p_email, position('@' in p_email))
  end;
$$;

create or replace function imobdesk.security_ip_prefix(p_ip text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v inet;
begin
  begin
    v := p_ip::inet;
  exception when others then
    return null;
  end;
  return host(network(set_masklen(v, case when family(v) = 4 then 24 else 48 end))) || case when family(v) = 4 then '/24' else '/48' end;
end;
$$;

create or replace function imobdesk.security_log_event(
  p_type text, p_severity text, p_request_id uuid, p_ip_hash text, p_ip text, p_user_hash text,
  p_user_id uuid, p_email text, p_reason text, p_risk integer, p_detail jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into imobdesk.security_events
    (event_type, severity, request_id, ip_hash, ip_prefix, user_hash, user_id, email_masked, reason_code, risk_score, detail)
  values
    (p_type, p_severity, p_request_id, p_ip_hash, imobdesk.security_ip_prefix(p_ip), p_user_hash, p_user_id,
     imobdesk.security_mask_email(p_email), p_reason, p_risk, coalesce(p_detail, '{}'::jsonb));
$$;

create or replace function imobdesk.security_block_ip(p_ip_hash text, p_minutes integer, p_reason text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into imobdesk.security_ip_blocks (ip_hash, blocked_until, reason, block_count, last_block_at)
  values (p_ip_hash, clock_timestamp() + make_interval(mins => p_minutes), p_reason, 1, clock_timestamp())
  on conflict (ip_hash) do update
    set blocked_until = greatest(imobdesk.security_ip_blocks.blocked_until, excluded.blocked_until),
        reason = excluded.reason,
        block_count = imobdesk.security_ip_blocks.block_count + 1,
        last_block_at = excluded.last_block_at;
$$;

-- Duração do bloqueio da conta pelo nível (1 = 15 min, 2 = 30 min, 3+ = 60 min). Nunca permanente.
create or replace function imobdesk.security_lock_minutes(p_level integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_level <= 1 then imobdesk.security_cfg('account_lock_1_min')
    when p_level = 2 then imobdesk.security_cfg('account_lock_2_min')
    else imobdesk.security_cfg('account_lock_3_min')
  end;
$$;

-- Registra uma falha de credencial na conta (linha já travada por quem chama). Devolve true se bloqueou.
create or replace function imobdesk.security_register_failure(p_user_hash text, p_from_hook boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  c imobdesk.security_auth_control;
  v_level integer;
begin
  select * into c from imobdesk.security_auth_control where user_hash = p_user_hash for update;

  -- Nível de bloqueio "esquece" depois de um dia inteiro sem falhas.
  v_level := c.lock_level;
  if v_level > 0 and coalesce(c.last_failed_at, c.last_lock_at, v_now) < v_now - make_interval(hours => imobdesk.security_cfg('account_lock_decay_hours')) then
    v_level := 0;
  end if;

  if c.failed_attempts + 1 >= imobdesk.security_cfg('account_max_failures') then
    v_level := v_level + 1;
    update imobdesk.security_auth_control
    set failed_attempts = 0,
        lock_level = v_level,
        locked_until = v_now + make_interval(mins => imobdesk.security_lock_minutes(v_level)),
        next_allowed_at = null,
        inflight_until = null,
        last_failed_at = v_now,
        last_lock_at = v_now,
        last_hook_failure_at = case when p_from_hook then v_now else last_hook_failure_at end,
        updated_at = v_now
    where user_hash = p_user_hash;
    return true;
  end if;

  update imobdesk.security_auth_control
  set failed_attempts = c.failed_attempts + 1,
      lock_level = v_level,
      -- Atraso progressivo sem dormir no servidor: 1s, 2s, 4s, 8s...
      next_allowed_at = v_now + make_interval(secs => (imobdesk.security_cfg('account_backoff_base_ms') * power(2, c.failed_attempts)) / 1000.0),
      inflight_until = null,
      last_failed_at = v_now,
      last_hook_failure_at = case when p_from_hook then v_now else last_hook_failure_at end,
      updated_at = v_now
  where user_hash = p_user_hash;
  return false;
end;
$$;

-- Limpeza das tentativas brutas e eventos antigos (chamada de vez em quando pelo begin).
create or replace function imobdesk.security_cleanup()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from imobdesk.security_attempts
  where created_at < clock_timestamp() - make_interval(hours => imobdesk.security_cfg('attempts_retention_hours'));
  delete from imobdesk.security_events
  where created_at < clock_timestamp() - make_interval(days => imobdesk.security_cfg('events_retention_days'));
  delete from imobdesk.security_ip_blocks
  where blocked_until < clock_timestamp() - interval '7 days';
  delete from imobdesk.security_sessions s
  where s.revoked_at < clock_timestamp() - interval '30 days'
     or (s.created_at < clock_timestamp() - interval '1 day'
         and not exists (select 1 from auth.sessions a where a.id = s.session_id));
$$;

-- ============================================================================================
-- Gateway: begin (antes do Auth) e finish (depois do Auth). Só a Edge Function (service_role) chama.
-- ============================================================================================

-- Códigos internos (nunca saem do servidor; a resposta pública é sempre a mesma):
--   SEC_AUTH_001 ACCOUNT_LOCKED          SEC_AUTH_007 RATE_LIMIT_ACCOUNT
--   SEC_AUTH_002 ACCOUNT_COOLDOWN        SEC_AUTH_008 PASSWORD_SPRAY
--   SEC_AUTH_003 ACCOUNT_BUSY (paralelo) SEC_AUTH_009 DISTRIBUTED_ATTACK
--   SEC_AUTH_004 IP_BLOCKED              SEC_AUTH_010 RISK_COOLDOWN
--   SEC_AUTH_005 RATE_LIMIT_IP           SEC_AUTH_011 RISK_BLOCK
--   SEC_AUTH_006 RATE_LIMIT_IP_ACCOUNT   SEC_AUTH_012 RISK_CRITICAL
--   SEC_AUTH_013 DOMAIN_NOT_ALLOWED      SEC_AUTH_020 RATE_LIMIT_RECOVER
create or replace function imobdesk.security_auth_begin(
  p_kind text,
  p_email text,
  p_ip text,
  p_request_id uuid,
  p_domain_allowed boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_email text := imobdesk.security_normalize_email(p_email);
  v_ip text := coalesce(nullif(trim(p_ip), ''), 'unknown');
  v_user_hash text;
  v_ip_hash text;
  c imobdesk.security_auth_control;
  v_block imobdesk.security_ip_blocks;
  v_ip_1m integer; v_ip_15m integer; v_ip_1h integer; v_ip_burst integer;
  v_ipacc_15m integer; v_acc_15m integer; v_acc_recover_1h integer; v_ip_recover_15m integer;
  v_spray integer; v_dist integer;
  v_last_ip_attempt timestamptz;
  v_last_acct_attempt timestamptz;
  v_risk integer := 0;
  v_ip_risk integer := 0;
  v_signals text[] := '{}';
  v_reason text;
  v_event text;
  v_severity text := 'warning';
  v_attempt uuid;
begin
  if p_kind not in ('login', 'recover') or v_email = '' or length(v_email) > 254 or length(v_ip) > 64 then
    raise exception 'security_auth_begin: parâmetros inválidos';
  end if;

  v_user_hash := imobdesk.security_hash('acct', v_email);
  v_ip_hash := imobdesk.security_hash('ip', v_ip);

  -- Serializa por IP e por conta (sempre nesta ordem). Fecha a corrida "todas leem 4 e passam".
  perform pg_advisory_xact_lock(hashtextextended('sec:ip:' || v_ip_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('sec:acct:' || v_user_hash, 0));

  if random() < 0.01 then
    perform imobdesk.security_cleanup();
  end if;

  insert into imobdesk.security_auth_control (user_hash) values (v_user_hash) on conflict (user_hash) do nothing;
  select * into c from imobdesk.security_auth_control where user_hash = v_user_hash for update;
  select * into v_block from imobdesk.security_ip_blocks where ip_hash = v_ip_hash;

  -- Contagens ANTES desta tentativa.
  select count(*) filter (where a.created_at > v_now - interval '1 minute' and a.kind = p_kind),
         count(*) filter (where a.created_at > v_now - interval '15 minutes' and a.kind = p_kind),
         count(*) filter (where a.kind = p_kind),
         count(*) filter (where a.created_at > v_now - make_interval(secs => imobdesk.security_cfg('velocity_window_ms') / 1000.0)),
         count(*) filter (where a.kind = 'recover' and a.created_at > v_now - interval '15 minutes'),
         max(a.created_at)
    into v_ip_1m, v_ip_15m, v_ip_1h, v_ip_burst, v_ip_recover_15m, v_last_ip_attempt
  from imobdesk.security_attempts a
  where a.ip_hash = v_ip_hash and a.created_at > v_now - interval '1 hour';

  select count(*) filter (where a.ip_hash = v_ip_hash and a.created_at > v_now - interval '15 minutes' and a.kind = 'login'),
         count(*) filter (where a.created_at > v_now - interval '15 minutes' and a.kind = 'login'),
         count(*) filter (where a.kind = 'recover'),
         max(a.created_at) filter (where a.kind = 'login')
    into v_ipacc_15m, v_acc_15m, v_acc_recover_1h, v_last_acct_attempt
  from imobdesk.security_attempts a
  where a.user_hash = v_user_hash and a.created_at > v_now - interval '1 hour';

  -- Contas distintas por este IP (5 min) e IPs distintos nesta conta (15 min), contando a atual.
  select count(distinct u) into v_spray from (
    select a.user_hash as u from imobdesk.security_attempts a
    where a.ip_hash = v_ip_hash and a.created_at > v_now - interval '5 minutes'
    union select v_user_hash
  ) x;
  select count(distinct i) into v_dist from (
    select a.ip_hash as i from imobdesk.security_attempts a
    where a.user_hash = v_user_hash and a.created_at > v_now - interval '15 minutes' and a.kind = 'login'
    union select v_ip_hash
  ) x;

  -- ---------- Risco (sinais combinados; nenhum sinal isolado decide sozinho) ----------
  -- Sinais da CONTA (falhas, muitos IPs) e sinais do IP (rajada, muitas contas, paralelismo,
  -- bloqueio recente) somam no risco; mas só os do IP podem levar a bloquear o IP — senão um
  -- usuário errando a senha bloquearia todo o escritório atrás do mesmo NAT.
  if c.failed_attempts > 0 then
    v_risk := v_risk + least(c.failed_attempts * 10, 40); v_signals := array_append(v_signals, 'senha_invalida');
  end if;
  if v_dist >= 3 then
    v_risk := v_risk + 30; v_signals := array_append(v_signals, 'muitos_ips_mesma_conta');
  end if;
  if v_ip_1m >= 5 then
    v_ip_risk := v_ip_risk + 20; v_signals := array_append(v_signals, 'muitas_tentativas');
  end if;
  if v_spray >= 4 then
    v_ip_risk := v_ip_risk + 30; v_signals := array_append(v_signals, 'muitas_contas_mesmo_ip');
  end if;
  if v_ip_burst >= imobdesk.security_cfg('velocity_max') then
    v_ip_risk := v_ip_risk + 30; v_signals := array_append(v_signals, 'velocidade_anormal');
  end if;
  if c.inflight_until > v_now then
    v_ip_risk := v_ip_risk + 40; v_signals := array_append(v_signals, 'requisicoes_paralelas');
  end if;
  if v_block.ip_hash is not null and v_block.last_block_at > v_now - interval '24 hours' then
    v_ip_risk := v_ip_risk + 40; v_signals := array_append(v_signals, 'ip_bloqueado_recentemente');
  end if;
  v_risk := least(v_risk + v_ip_risk, 100);

  -- ---------- Decisão (primeira regra que nega vence) ----------
  if not p_domain_allowed then
    v_reason := 'SEC_AUTH_013'; v_event := 'LOGIN_BLOCKED'; v_severity := 'info';
  elsif v_block.blocked_until > v_now then
    v_reason := 'SEC_AUTH_004'; v_event := 'LOGIN_BLOCKED';
  elsif p_kind = 'recover' then
    if v_ip_recover_15m >= imobdesk.security_cfg('recover_ip_15m')
       or v_acc_recover_1h >= imobdesk.security_cfg('recover_account_1h') then
      v_reason := 'SEC_AUTH_020'; v_event := 'RATE_LIMIT_RECOVER';
    end if;
  elsif v_spray > imobdesk.security_cfg('spray_accounts_5m') then
    v_reason := 'SEC_AUTH_008'; v_event := 'PASSWORD_SPRAY_DETECTED'; v_severity := 'critical';
    perform imobdesk.security_block_ip(v_ip_hash, imobdesk.security_cfg('spray_block_min'), 'PASSWORD_SPRAY');
  elsif v_ip_1m >= imobdesk.security_cfg('ip_attempts_1m')
     or v_ip_15m >= imobdesk.security_cfg('ip_attempts_15m')
     or v_ip_1h >= imobdesk.security_cfg('ip_attempts_1h') then
    v_reason := 'SEC_AUTH_005'; v_event := 'RATE_LIMIT_IP';
  elsif c.locked_until > v_now then
    -- Bloqueada continua bloqueada mesmo com a senha certa: nem chega ao Auth.
    v_reason := 'SEC_AUTH_001'; v_event := 'LOGIN_BLOCKED';
  elsif c.inflight_until > v_now then
    v_reason := 'SEC_AUTH_003'; v_event := 'BOT_PATTERN';
  elsif c.next_allowed_at > v_now then
    v_reason := 'SEC_AUTH_002'; v_event := 'LOGIN_BLOCKED'; v_severity := 'info';
  elsif v_ipacc_15m >= imobdesk.security_cfg('ip_account_attempts_15m') then
    v_reason := 'SEC_AUTH_006'; v_event := 'RATE_LIMIT_IP_ACCOUNT';
  elsif v_dist > imobdesk.security_cfg('distributed_ips_15m') then
    -- Muitos IPs na mesma conta: a conta é bloqueada (independe do IP de onde vier a próxima).
    v_reason := 'SEC_AUTH_009'; v_event := 'DISTRIBUTED_ATTACK'; v_severity := 'critical';
    update imobdesk.security_auth_control
    set lock_level = c.lock_level + 1,
        locked_until = v_now + make_interval(mins => imobdesk.security_lock_minutes(c.lock_level + 1)),
        last_lock_at = v_now, updated_at = v_now
    where user_hash = v_user_hash;
  elsif v_acc_15m >= imobdesk.security_cfg('account_attempts_15m') then
    v_reason := 'SEC_AUTH_007'; v_event := 'RATE_LIMIT_ACCOUNT';
  elsif v_risk >= imobdesk.security_cfg('risk_critical') and v_ip_risk >= 30 then
    v_reason := 'SEC_AUTH_012'; v_event := 'BOT_PATTERN'; v_severity := 'critical';
    perform imobdesk.security_block_ip(v_ip_hash, imobdesk.security_cfg('risk_critical_block_min'), 'RISK_CRITICAL');
  elsif v_risk >= imobdesk.security_cfg('risk_block') and v_ip_risk >= 30 then
    v_reason := 'SEC_AUTH_011'; v_event := 'BOT_PATTERN';
    perform imobdesk.security_block_ip(v_ip_hash, imobdesk.security_cfg('risk_block_min'), 'RISK_BLOCK');
  elsif v_risk >= imobdesk.security_cfg('risk_cooldown')
     and greatest(v_last_ip_attempt, v_last_acct_attempt) > v_now - make_interval(secs => imobdesk.security_cfg('risk_cooldown_seconds')) then
    -- Risco médio (ou alto só por sinais da conta): exige intervalo mínimo entre tentativas.
    v_reason := 'SEC_AUTH_010'; v_event := 'LOGIN_BLOCKED'; v_severity := 'info';
  end if;

  update imobdesk.security_auth_control set risk_score = v_risk, updated_at = v_now where user_hash = v_user_hash;

  if v_reason is not null then
    insert into imobdesk.security_attempts (kind, ip_hash, user_hash, outcome, reason, risk_score, request_id, finished_at)
    values (p_kind, v_ip_hash, v_user_hash, 'denied', v_reason, v_risk, p_request_id, v_now);
    perform imobdesk.security_log_event(v_event, v_severity, p_request_id, v_ip_hash, v_ip, v_user_hash, c.user_id,
      v_email, v_reason, v_risk, jsonb_build_object('kind', p_kind, 'signals', to_jsonb(v_signals)));
    return jsonb_build_object('allowed', false, 'reason', v_reason, 'risk', v_risk);
  end if;

  -- Permitida: reserva a conta (uma tentativa por vez) e registra a tentativa em andamento.
  if p_kind = 'login' then
    update imobdesk.security_auth_control
    set inflight_until = v_now + make_interval(secs => imobdesk.security_cfg('account_inflight_seconds')), updated_at = v_now
    where user_hash = v_user_hash;
  end if;
  insert into imobdesk.security_attempts (kind, ip_hash, user_hash, outcome, risk_score, request_id)
  values (p_kind, v_ip_hash, v_user_hash, 'pending', v_risk, p_request_id)
  returning id into v_attempt;

  return jsonb_build_object('allowed', true, 'attempt_id', v_attempt, 'risk', v_risk);
end;
$$;

-- p_result: SUCCESS | INVALID_CREDENTIALS | ACCOUNT_UNAVAILABLE | AUTH_RATE_LIMITED | AUTH_ERROR
-- Só INVALID_CREDENTIALS conta como falha de senha.
create or replace function imobdesk.security_auth_finish(
  p_attempt_id uuid,
  p_result text,
  p_email text,
  p_ip text,
  p_user_id uuid default null,
  p_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_email text := imobdesk.security_normalize_email(p_email);
  a imobdesk.security_attempts;
  c imobdesk.security_auth_control;
  v_locked boolean := false;
  v_counted_by_hook boolean;
begin
  if p_result not in ('SUCCESS', 'INVALID_CREDENTIALS', 'ACCOUNT_UNAVAILABLE', 'AUTH_RATE_LIMITED', 'AUTH_ERROR') then
    raise exception 'security_auth_finish: resultado inválido';
  end if;

  select * into a from imobdesk.security_attempts where id = p_attempt_id;
  -- Uma tentativa só fecha uma vez (sem replay) e só com o mesmo e-mail que a abriu.
  if a.id is null or a.outcome <> 'pending' or a.user_hash <> imobdesk.security_hash('acct', v_email) then
    raise exception 'security_auth_finish: tentativa inexistente ou já concluída';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sec:ip:' || a.ip_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('sec:acct:' || a.user_hash, 0));
  select * into a from imobdesk.security_attempts where id = p_attempt_id for update;
  if a.outcome <> 'pending' then
    raise exception 'security_auth_finish: tentativa já concluída';
  end if;
  select * into c from imobdesk.security_auth_control where user_hash = a.user_hash for update;

  if a.kind = 'recover' then
    update imobdesk.security_attempts
    set outcome = case when p_result = 'SUCCESS' then 'success' else 'error' end, reason = p_result, finished_at = v_now
    where id = a.id;
    perform imobdesk.security_log_event('PASSWORD_RESET', 'info', a.request_id, a.ip_hash, p_ip, a.user_hash, c.user_id,
      v_email, p_result, a.risk_score);
    return jsonb_build_object('ok', true);
  end if;

  if p_result = 'SUCCESS' then
    if p_user_id is null or p_session_id is null then
      raise exception 'security_auth_finish: sucesso sem usuário/sessão';
    end if;
    -- Zera só as falhas consecutivas. Nível de bloqueio, eventos e bloqueios de IP continuam.
    update imobdesk.security_auth_control
    set failed_attempts = 0, next_allowed_at = null, inflight_until = null,
        last_success_at = v_now, user_id = p_user_id, updated_at = v_now
    where user_hash = a.user_hash;
    insert into imobdesk.security_sessions (session_id, user_id, ip_hash)
    values (p_session_id, p_user_id, a.ip_hash)
    on conflict (session_id) do nothing;
    update imobdesk.security_attempts set outcome = 'success', finished_at = v_now where id = a.id;
    perform imobdesk.security_log_event('LOGIN_SUCCESS', 'info', a.request_id, a.ip_hash, p_ip, a.user_hash, p_user_id,
      v_email, null, a.risk_score);
    return jsonb_build_object('ok', true);
  end if;

  if p_result = 'INVALID_CREDENTIALS' then
    -- Com o hook do Auth ligado, ele já contou esta falha (e marcou last_hook_failure_at).
    v_counted_by_hook := imobdesk.security_cfg('hook_counts_failures') = 1
                         and c.last_hook_failure_at >= a.created_at;
    if v_counted_by_hook then
      update imobdesk.security_auth_control set inflight_until = null, updated_at = v_now where user_hash = a.user_hash;
      v_locked := (select x.locked_until > v_now from imobdesk.security_auth_control x where x.user_hash = a.user_hash);
    else
      v_locked := imobdesk.security_register_failure(a.user_hash, false);
    end if;
    update imobdesk.security_attempts set outcome = 'failure', reason = p_result, finished_at = v_now where id = a.id;
    perform imobdesk.security_log_event('LOGIN_FAILED', 'info', a.request_id, a.ip_hash, p_ip, a.user_hash, c.user_id,
      v_email, p_result, a.risk_score);
    if v_locked then
      perform imobdesk.security_log_event('LOGIN_BLOCKED', 'warning', a.request_id, a.ip_hash, p_ip, a.user_hash, c.user_id,
        v_email, 'SEC_AUTH_001', a.risk_score, jsonb_build_object('lock_level', (select x.lock_level from imobdesk.security_auth_control x where x.user_hash = a.user_hash)));
    end if;
    return jsonb_build_object('ok', true);
  end if;

  -- Erro que não é de senha (Auth fora, limite do próprio Auth, conta sem confirmação): libera a
  -- reserva, não conta falha, registra.
  update imobdesk.security_auth_control set inflight_until = null, updated_at = v_now where user_hash = a.user_hash;
  update imobdesk.security_attempts set outcome = 'error', reason = p_result, finished_at = v_now where id = a.id;
  perform imobdesk.security_log_event('LOGIN_FAILED', case when p_result = 'AUTH_ERROR' then 'warning' else 'info' end,
    a.request_id, a.ip_hash, p_ip, a.user_hash, c.user_id, v_email, p_result, a.risk_score);
  return jsonb_build_object('ok', true);
end;
$$;

-- O schema dá EXECUTE a authenticated por padrão (20261006141700_..._base.sql): revogar explicitamente.
revoke all on function
  imobdesk.security_normalize_email(text),
  imobdesk.security_mask_email(text),
  imobdesk.security_ip_prefix(text),
  imobdesk.security_cfg(text),
  imobdesk.security_hash(text, text),
  imobdesk.security_log_event(text, text, uuid, text, text, text, uuid, text, text, integer, jsonb),
  imobdesk.security_block_ip(text, integer, text),
  imobdesk.security_lock_minutes(integer),
  imobdesk.security_register_failure(text, boolean),
  imobdesk.security_cleanup(),
  imobdesk.security_auth_begin(text, text, text, uuid, boolean),
  imobdesk.security_auth_finish(uuid, text, text, text, uuid, uuid)
from public, anon, authenticated;
grant execute on function
  imobdesk.security_auth_begin(text, text, text, uuid, boolean),
  imobdesk.security_auth_finish(uuid, text, text, text, uuid, uuid),
  imobdesk.security_cleanup()
to service_role;

-- ============================================================================================
-- Sessão confiável: a RLS do portal só aceita sessão de senha emitida pelo gateway
-- ============================================================================================

-- Regra para uma sessão (user_id, session_id, amr do JWT):
--   * a sessão ainda existe no Auth (logout, "encerrar sessão" e troca de senha cortam na hora,
--     sem esperar o access token expirar);
--   * se o login foi por senha (amr contém "password"), a sessão tem de estar em security_sessions;
--   * login por link de e-mail (recovery/invite/otp) não passa por senha, então vale sem vínculo.
create or replace function imobdesk.security_sessao_valida(p_user_id uuid, p_session_id uuid, p_amr jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and p_session_id is not null
    and exists (select 1 from auth.sessions s where s.id = p_session_id and s.user_id = p_user_id)
    and (
      not jsonb_path_exists(coalesce(p_amr, '[]'::jsonb), '$[*] ? (@.method == "password")')
      or exists (
        select 1 from imobdesk.security_sessions b
        where b.session_id = p_session_id and b.user_id = p_user_id and b.revoked_at is null
      )
    );
$$;

create or replace function imobdesk.sessao_confiavel()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := auth.jwt();
  v_sid uuid;
begin
  -- Sem JWT = conexão interna (migrations, cron). service_role = Edge Function, que valida a sessão do chamador em portalContext.
  if v_claims is null or v_claims ->> 'role' = 'service_role' then
    return true;
  end if;
  if v_claims ->> 'role' is distinct from 'authenticated' then
    return false;
  end if;
  begin
    v_sid := (v_claims ->> 'session_id')::uuid;
  exception when others then
    return false;
  end;
  return imobdesk.security_sessao_valida(auth.uid(), v_sid, v_claims -> 'amr');
end;
$$;

-- Para o front descobrir que a sessão salva no navegador não vale mais (ex.: aberta antes desta versão).
create or replace function imobdesk.sessao_atual_confiavel()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select imobdesk.sessao_confiavel();
$$;

revoke all on function imobdesk.security_sessao_valida(uuid, uuid, jsonb), imobdesk.sessao_confiavel(),
  imobdesk.sessao_atual_confiavel() from public, anon, authenticated;
grant execute on function imobdesk.sessao_confiavel(), imobdesk.sessao_atual_confiavel() to authenticated, service_role;
grant execute on function imobdesk.security_sessao_valida(uuid, uuid, jsonb) to service_role;

-- ============================================================================================
-- Depois da troca de senha (pelo link do e-mail ou pela tela "Trocar senha")
-- ============================================================================================

-- Quem provou ser dono da conta e trocou a senha sai do bloqueio; as outras sessões de senha
-- deixam de valer no portal (o front também chama signOut({ scope: "others" }) no Auth).
create or replace function imobdesk.security_apos_troca_senha()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_sid uuid;
  v_email text;
  v_hash text;
begin
  if v_uid is null or not imobdesk.sessao_confiavel() then
    perform imobdesk.erro('UNAUTHENTICATED', 'Sua sessão expirou. Entre novamente.');
  end if;
  begin
    v_sid := (auth.jwt() ->> 'session_id')::uuid;
  exception when others then
    v_sid := null;
  end;
  select imobdesk.security_normalize_email(u.email) into v_email from auth.users u where u.id = v_uid;
  v_hash := imobdesk.security_hash('acct', v_email);

  update imobdesk.security_auth_control
  set failed_attempts = 0, locked_until = null, next_allowed_at = null, inflight_until = null,
      user_id = v_uid, updated_at = now()
  where user_hash = v_hash;

  update imobdesk.security_sessions
  set revoked_at = now(), revoked_reason = 'password_changed'
  where user_id = v_uid and revoked_at is null and session_id is distinct from v_sid;

  perform imobdesk.security_log_event('SESSION_REVOKED', 'info', null, null, null, v_hash, v_uid, v_email,
    'PASSWORD_CHANGED', null, jsonb_build_object('scope', 'others'));
end;
$$;

revoke all on function imobdesk.security_apos_troca_senha() from public, anon;
grant execute on function imobdesk.security_apos_troca_senha() to authenticated;

-- ============================================================================================
-- Password Verification Hook do Supabase Auth (OPCIONAL, desligado por padrão)
-- ============================================================================================
--
-- O endpoint público do Auth (/auth/v1/token) continua aceitando senha direto com a chave pública,
-- e o projeto é compartilhado: não dá para desligá-lo. Sem o hook, quem chama o Auth direto
-- esbarra só no limite nativo do Auth por IP; a sessão obtida assim não abre o portal (RLS acima),
-- mas a tentativa serve para adivinhar senha. Com o hook ligado, o próprio Auth consulta este
-- bloqueio em TODA verificação de senha — inclusive as diretas — e passa a contar as falhas.
--
-- Ligar (decisão do dono do projeto compartilhado: vale para todos os sistemas da WSA):
--   Dashboard > Authentication > Hooks > Password Verification Attempt > Postgres >
--   imobdesk.security_password_verification_hook
--   e depois: update imobdesk.security_config set value = 1 where key = 'hook_counts_failures';
create or replace function imobdesk.security_password_verification_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_uid uuid;
  v_valid boolean;
  v_email text;
  v_hash text;
  c imobdesk.security_auth_control;
  v_locked boolean;
begin
  v_uid := (event ->> 'user_id')::uuid;
  v_valid := coalesce((event ->> 'valid')::boolean, false);
  select imobdesk.security_normalize_email(u.email) into v_email from auth.users u where u.id = v_uid;
  if v_email is null or v_email = '' then
    return jsonb_build_object('decision', 'continue');
  end if;
  v_hash := imobdesk.security_hash('acct', v_email);

  perform pg_advisory_xact_lock(hashtextextended('sec:acct:' || v_hash, 0));
  insert into imobdesk.security_auth_control (user_hash, user_id) values (v_hash, v_uid)
  on conflict (user_hash) do update set user_id = excluded.user_id;
  select * into c from imobdesk.security_auth_control where user_hash = v_hash for update;

  if c.locked_until > v_now or (c.next_allowed_at > v_now and c.inflight_until is null) then
    perform imobdesk.security_log_event('LOGIN_BLOCKED', 'warning', null, null, null, v_hash, v_uid, v_email,
      'SEC_AUTH_001', c.risk_score, jsonb_build_object('source', 'auth_hook', 'valid', v_valid));
    return jsonb_build_object('decision', 'reject',
      'message', 'Não foi possível realizar o acesso. Verifique os dados informados ou tente novamente mais tarde.',
      'should_logout_user', false);
  end if;

  if not v_valid then
    v_locked := imobdesk.security_register_failure(v_hash, true);
    perform imobdesk.security_log_event(case when v_locked then 'LOGIN_BLOCKED' else 'LOGIN_FAILED' end,
      case when v_locked then 'warning' else 'info' end, null, null, null, v_hash, v_uid, v_email,
      'INVALID_CREDENTIALS', c.risk_score, jsonb_build_object('source', 'auth_hook'));
  end if;
  return jsonb_build_object('decision', 'continue');
end;
$$;

revoke all on function imobdesk.security_password_verification_hook(jsonb) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema imobdesk to supabase_auth_admin;
    grant execute on function imobdesk.security_password_verification_hook(jsonb) to supabase_auth_admin;
  end if;
end;
$$;

-- ============================================================================================
-- Higiene: funções de trigger não precisam de EXECUTE para PUBLIC/anon (o disparo não confere
-- esse privilégio). Achado do teste "anon não tem privilégio em nenhuma função do schema".
-- ============================================================================================
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'imobdesk' and p.prorettype = 'trigger'::regtype
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end;
$$;

-- Helpers internos dos gatilhos (20261007210000_..._gatilhos.sql) ficaram com EXECUTE para PUBLIC/anon.
revoke execute on function imobdesk.ch_gatilho_em_execucao(), imobdesk.ch_gatilho_exigir_admin() from public, anon;
