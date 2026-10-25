-- Login: trocar a senha não liberava a conta e a tentativa barrada prolongava o bloqueio (10/10/2026).
-- Caso real: o Wagner errou a senha algumas vezes, trocou pelo link (15:22:12) e, 5 s depois, foi barrado por
-- RATE_LIMIT_IP_ACCOUNT (SEC_AUTH_006, 5 tentativas do mesmo IP na mesma conta em 15 min). Duas falhas somadas:
--   1. o limite de IP + conta (e o de conta) contava TODA tentativa, inclusive as barradas (denied) e os logins
--      certos (success): cada nova tentativa durante o bloqueio gerava outra linha e empurrava o bloqueio;
--   2. security_apos_troca_senha zerava o controle da conta, mas não essas contagens (vêm de security_attempts).
-- Correção: os limites da CONTA contam só failure/pending e só depois de security_auth_control.contar_desde, que a
-- troca de senha marca. Os limites do IP (rajada, spray, por hora) continuam contando tudo.
-- Só aditiva: uma coluna nova e as duas funções trocadas (mesma assinatura e mesmas permissões).

alter table imobdesk.security_auth_control add column if not exists contar_desde timestamptz;

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

  -- Limites da CONTA (IP + conta e conta): só senha errada de verdade (failure) ou em andamento (pending), e só depois
  -- da última troca de senha. Tentativa barrada (denied) não é palpite de senha: contá-la fazia cada nova tentativa
  -- durante o bloqueio empurrar o bloqueio para frente. Os limites do IP continuam contando tudo.
  select count(*) filter (where a.ip_hash = v_ip_hash and a.created_at > v_now - interval '15 minutes' and a.kind = 'login'
                                and a.outcome in ('failure', 'pending') and a.created_at > coalesce(c.contar_desde, '-infinity'::timestamptz)),
         count(*) filter (where a.created_at > v_now - interval '15 minutes' and a.kind = 'login'
                                and a.outcome in ('failure', 'pending') and a.created_at > coalesce(c.contar_desde, '-infinity'::timestamptz)),
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
      and a.created_at > coalesce(c.contar_desde, '-infinity'::timestamptz)
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
      contar_desde = now(), user_id = v_uid, updated_at = now()
  where user_hash = v_hash;

  update imobdesk.security_sessions
  set revoked_at = now(), revoked_reason = 'password_changed'
  where user_id = v_uid and revoked_at is null and session_id is distinct from v_sid;

  perform imobdesk.security_log_event('SESSION_REVOKED', 'info', null, null, null, v_hash, v_uid, v_email,
    'PASSWORD_CHANGED', null, jsonb_build_object('scope', 'others'));
end;
$$;

-- De carona (achado pelo teste "anon não tem privilégio" ao rodar a suíte): a função da migração 20261009150000 ficou
-- executável por anon. É só um "case" do canal, mas a regra do schema é nenhum privilégio para anon.
revoke execute on function imobdesk.ch_forma_atendimento_do_canal(text) from public, anon;
grant execute on function imobdesk.ch_forma_atendimento_do_canal(text) to authenticated, service_role;

notify pgrst, 'reload schema';
