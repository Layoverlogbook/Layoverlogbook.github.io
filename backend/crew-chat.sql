-- Crew chat: rooms (the lounge and one per city), crew members only, text and photos.
-- Run once in Supabase > SQL Editor > New query > paste > Run.
create table public.crew_messages (
  id bigint generated always as identity primary key,
  room text not null check (room ~ '^[a-z0-9:_-]{2,60}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 500),
  photo_path text check (photo_path is null or char_length(photo_path) <= 200),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  check (char_length(body) > 0 or photo_path is not null)
);
create index crew_messages_room_id on public.crew_messages(room, id desc);
create index crew_messages_user_time on public.crew_messages(user_id, created_at desc);
create table public.crew_message_reports (
  message_id bigint not null references public.crew_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
alter table public.crew_messages enable row level security;
alter table public.crew_message_reports enable row level security;

create or replace function public.crew_chat_send(p_room text, p_body text, p_photo text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); nm text; b text := btrim(coalesce(p_body,'')); m public.crew_messages;
begin
  perform public._crew_only();
  select name into nm from public.crew_profiles where user_id = uid;
  if nm is null then raise exception 'Pick your crew name first.'; end if;
  if coalesce(p_room,'') !~ '^[a-z0-9:_-]{2,60}$' then raise exception 'Unknown chat room.'; end if;
  if char_length(b) > 500 then raise exception 'Keep messages under 500 characters.'; end if;
  if b = '' and p_photo is null then raise exception 'Write a message or add a photo.'; end if;
  if p_photo is not null and (p_photo !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$' or split_part(p_photo,'/',1) <> uid::text) then
    raise exception 'That photo could not be sent.'; end if;
  if public._count_links(b) > 1 then raise exception 'Messages can contain at most one link.'; end if;
  if (select count(*) from public.crew_messages where user_id = uid and created_at > now() - interval '1 minute') >= 8 then
    raise exception 'Slow down a little. Try again in a minute.'; end if;
  if b <> '' and exists (select 1 from public.crew_messages where user_id = uid and room = p_room and body = b and created_at > now() - interval '30 seconds') then
    raise exception 'You just sent that.'; end if;
  insert into public.crew_messages(room, user_id, body, photo_path) values (p_room, uid, b, p_photo) returning * into m;
  return jsonb_build_object('id', m.id, 'name', nm, 'body', m.body, 'photo', m.photo_path, 'at', m.created_at, 'mine', true);
end $$;

create or replace function public.crew_chat_list(p_room text, p_after bigint default null) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare uid uuid := (select auth.uid());
begin
  perform public._crew_only();
  return jsonb_build_object(
    'me', (select name from public.crew_profiles where user_id = uid),
    'messages', coalesce((select jsonb_agg(x order by x.id) from (
      select m.id, coalesce(p.name, 'Crew') as name, m.body, m.photo_path as photo, m.created_at as at, m.user_id = uid as mine
      from public.crew_messages m left join public.crew_profiles p on p.user_id = m.user_id
      where m.room = p_room and not m.hidden and (p_after is null or m.id > p_after)
      order by m.id desc limit case when p_after is null then 60 else 200 end) x), '[]'::jsonb));
end $$;

create or replace function public.crew_chat_delete(p_id bigint) returns text
language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); ph text;
begin
  if uid is null then raise exception 'Sign in first.'; end if;
  delete from public.crew_messages m where m.id = p_id and (m.user_id = uid or exists (
    select 1 from public.crew_owners o join auth.users u on lower(u.email) = o.email where u.id = uid))
  returning photo_path into ph;
  return ph;
end $$;

create or replace function public.crew_chat_report(p_id bigint) returns void
language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid());
begin
  perform public._crew_only();
  if (select count(*) from public.crew_message_reports where user_id = uid and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'You have sent a lot of reports today. Try again tomorrow.'; end if;
  if not exists (select 1 from public.crew_messages where id = p_id) then return; end if;
  insert into public.crew_message_reports(message_id, user_id) values (p_id, uid) on conflict do nothing;
  if (select count(*) from public.crew_message_reports where message_id = p_id) >= 3 then
    update public.crew_messages set hidden = true where id = p_id;
  end if;
end $$;

revoke all on function public.crew_chat_send(text, text, text), public.crew_chat_list(text, bigint),
  public.crew_chat_delete(bigint), public.crew_chat_report(bigint) from public, anon;
grant execute on function public.crew_chat_send(text, text, text), public.crew_chat_list(text, bigint),
  public.crew_chat_delete(bigint), public.crew_chat_report(bigint) to authenticated;
