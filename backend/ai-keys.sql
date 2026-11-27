-- Layover Logbook: personal AI keys for the MCP server (Pro + AI).
-- Applied to Supabase project layover-logbook as migration `ai_keys_for_mcp`.
-- A key lets an AI assistant (Claude, ChatGPT, Cursor...) read the user's layovers and
-- spending and add expenses or wishlist items. Only a SHA-256 fingerprint of each key is stored.
-- Keys stop working by themselves when Pro ends (when the paywall is on).

create table public.ai_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  key_hash text not null unique,
  hint text not null,                           -- last 4 characters, to tell keys apart
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  minute_start timestamptz not null default now(),
  minute_calls int not null default 0
);
create index ai_keys_user on public.ai_keys(user_id);
alter table public.ai_keys enable row level security;   -- no policies: only the functions below touch it

-- Create a key. The full key is returned once and never again.
create or replace function public.ai_key_create(p_name text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); tok text; nm text := btrim(coalesce(p_name,'')); new_id uuid;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  if not public._full_access(uid) then raise exception 'Connecting an AI assistant is part of Pro.'; end if;
  if nm = '' then nm := 'My assistant'; end if;
  nm := left(regexp_replace(nm, '[\x00-\x1f<>]', '', 'g'), 40);
  if (select count(*) from public.ai_keys where user_id = uid) >= 5 then
    raise exception 'You can have up to 5 keys. Remove one first.';
  end if;
  tok := 'llb_' || translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_');
  insert into public.ai_keys(user_id, name, key_hash, hint)
  values (uid, nm, encode(extensions.digest(tok, 'sha256'), 'hex'), right(tok, 4))
  returning id into new_id;
  return jsonb_build_object('id', new_id, 'name', nm, 'token', tok);
end $$;

create or replace function public.ai_key_list() returns jsonb
language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'hint', hint,
           'created_at', created_at, 'last_used_at', last_used_at) order by created_at desc), '[]'::jsonb)
  from public.ai_keys where user_id = (select auth.uid());
$$;

create or replace function public.ai_key_revoke(p_id uuid) returns void
language sql security definer set search_path to '' as $$
  delete from public.ai_keys where id = p_id and user_id = (select auth.uid());
$$;

-- Used only by the mcp Edge Function (service role): who owns this key, are they Pro,
-- and are they under 120 calls a minute.
create or replace function public.ai_resolve(p_hash text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare k public.ai_keys%rowtype;
begin
  update public.ai_keys set
    minute_calls = case when minute_start < now() - interval '1 minute' then 1 else minute_calls + 1 end,
    minute_start = case when minute_start < now() - interval '1 minute' then now() else minute_start end,
    last_used_at = now()
  where key_hash = p_hash returning * into k;
  if not found then return null; end if;
  return jsonb_build_object('uid', k.user_id, 'pro', public._full_access(k.user_id), 'limited', k.minute_calls > 120);
end $$;

-- Atomic writes into the synced data row, so nothing else in the row is touched.
create or replace function public.ai_tx_add(p_uid uuid, p_item jsonb) returns void
language plpgsql security definer set search_path to '' as $$
begin
  insert into public.user_data(user_id, data, updated_at) values (p_uid, '{}'::jsonb, now())
  on conflict (user_id) do nothing;
  update public.user_data
     set data = jsonb_set(data, '{tx}', coalesce(data->'tx', '[]'::jsonb) || jsonb_build_array(p_item)),
         updated_at = now()
   where user_id = p_uid and jsonb_array_length(coalesce(data->'tx', '[]'::jsonb)) < 20000;
end $$;

create or replace function public.ai_wish_add(p_uid uuid, p_code text, p_item jsonb) returns void
language plpgsql security definer set search_path to '' as $$
begin
  insert into public.user_data(user_id, data, updated_at) values (p_uid, '{}'::jsonb, now())
  on conflict (user_id) do nothing;
  update public.user_data
     set data = jsonb_set(
           case when jsonb_typeof(data->'wish') = 'object' then data else jsonb_set(data, '{wish}', '{}'::jsonb) end,
           array['wish', p_code],
           coalesce(data->'wish'->p_code, '[]'::jsonb) || jsonb_build_array(p_item)),
         updated_at = now()
   where user_id = p_uid and jsonb_array_length(coalesce(data->'wish'->p_code, '[]'::jsonb)) < 500;
end $$;

revoke all on function public.ai_key_create(text), public.ai_key_list(), public.ai_key_revoke(uuid),
  public.ai_resolve(text), public.ai_tx_add(uuid, jsonb), public.ai_wish_add(uuid, text, jsonb) from public, anon;
grant execute on function public.ai_key_create(text), public.ai_key_list(), public.ai_key_revoke(uuid) to authenticated;
revoke all on function public.ai_resolve(text), public.ai_tx_add(uuid, jsonb), public.ai_wish_add(uuid, text, jsonb) from authenticated;
grant execute on function public.ai_resolve(text), public.ai_tx_add(uuid, jsonb), public.ai_wish_add(uuid, text, jsonb) to service_role;
