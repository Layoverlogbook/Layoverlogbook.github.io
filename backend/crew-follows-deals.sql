-- Layover Logbook: crew profiles with followers/following, and crew deals.
-- Applied to Supabase project layover-logbook as migration `crew_follows_and_deals`.
-- Everything goes through security-definer functions; the tables have RLS on and no policies.

-- ---------- following ----------
create table public.crew_follows (
  follower uuid not null references auth.users(id) on delete cascade,
  followee uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, followee),
  check (follower <> followee)
);
create index crew_follows_followee on public.crew_follows (followee, created_at desc);
alter table public.crew_follows enable row level security;

-- ---------- deals ----------
alter table public.crew_posts
  add column deal text check (deal is null or char_length(deal) between 3 and 80),
  add column deal_until date;
alter table public.crew_posts drop constraint crew_posts_category_check;
alter table public.crew_posts add constraint crew_posts_category_check
  check (category = any (array['Food','Sights','Shopping','Transport','Safety','Other','Deal']));
create index crew_posts_deals_idx on public.crew_posts (dest_key, id desc) where category = 'Deal' and not hidden;

-- One feed builder for every view: a city, everywhere, people I follow, deals, or one person's posts.
create or replace function public._crew_feed2(p_mode text, p_dest text, p_before bigint, p_author uuid default null)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  uid uuid := (select auth.uid());
  full_access boolean := public._full_access(uid);
  lim int; total int; posts jsonb;
begin
  -- deals and personal profiles are open to every member; the main feeds keep the free preview of 10
  lim := case when full_access or p_mode in ('deals','author') then 20 when p_before is null then 10 else 0 end;
  select count(*) into total from public.crew_posts p
   where not p.hidden
     and case p_mode
           when 'city' then p.dest_key = p_dest
           when 'following' then exists (select 1 from public.crew_follows f where f.follower = uid and f.followee = p.user_id)
           when 'deals' then p.category = 'Deal' and (p.deal_until is null or p.deal_until >= current_date) and (p_dest is null or p.dest_key = p_dest)
           when 'author' then p.user_id = p_author
           else true end;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc), '[]'::jsonb) into posts
  from (
    select p.id, coalesce(pr.name, 'Crew member') as name, p.dest_key, p.dest_name, p.category as c, p.body as t,
           p.place, p.rating, p.photo_path as photo, p.likes, p.comments, p.created_at as at,
           p.deal, p.deal_until as until,
           p.user_id = uid as mine,
           exists (select 1 from public.crew_post_likes l where l.post_id = p.id and l.user_id = uid) as liked
    from public.crew_posts p
    left join public.crew_profiles pr on pr.user_id = p.user_id
    where not p.hidden
      and case p_mode
            when 'city' then p.dest_key = p_dest
            when 'following' then exists (select 1 from public.crew_follows f where f.follower = uid and f.followee = p.user_id)
            when 'deals' then p.category = 'Deal' and (p.deal_until is null or p.deal_until >= current_date) and (p_dest is null or p.dest_key = p_dest)
            when 'author' then p.user_id = p_author
            else true end
      and (p_before is null or ((full_access or p_mode in ('deals','author')) and p.id < p_before))
    order by p.id desc
    limit lim
  ) r;
  return jsonb_build_object('full', full_access or p_mode in ('deals','author'), 'total', total, 'posts', posts,
    'me', (select name from public.crew_profiles where user_id = uid));
end $$;

-- The existing feed (city / everywhere) now also returns deal fields.
create or replace function public._crew_feed(p_dest text, p_before bigint)
returns jsonb language sql stable security definer set search_path to '' as $$
  select public._crew_feed2(case when p_dest is null then 'all' else 'city' end, p_dest, p_before);
$$;

-- Following and deals views.
create or replace function public.crew_feed_view(p_mode text, p_dest text default null, p_before bigint default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  perform public._crew_only();
  if p_mode not in ('following','deals') then raise exception 'Unknown view.'; end if;
  return public._crew_feed2(p_mode, p_dest, p_before) || jsonb_build_object('member', true);
end $$;

-- A crew member's profile: counts, whether I follow them, and their posts.
create or replace function public.crew_profile(p_name text, p_before bigint default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); them public.crew_profiles%rowtype;
begin
  perform public._crew_only();
  select * into them from public.crew_profiles where lower(name) = lower(btrim(coalesce(p_name, '')));
  if not found then raise exception 'That crew member isn''t here any more.'; end if;
  return jsonb_build_object(
    'name', them.name,
    'is_me', them.user_id = uid,
    'i_follow', exists (select 1 from public.crew_follows where follower = uid and followee = them.user_id),
    'follows_me', exists (select 1 from public.crew_follows where follower = them.user_id and followee = uid),
    'followers', (select count(*) from public.crew_follows where followee = them.user_id),
    'following', (select count(*) from public.crew_follows where follower = them.user_id),
    'post_count', (select count(*) from public.crew_posts where user_id = them.user_id and not hidden),
    'since', them.created_at
  ) || public._crew_feed2('author', null, p_before, them.user_id);
end $$;

create or replace function public.crew_follow(p_name text, p_on boolean default true)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); target uuid;
begin
  perform public._crew_only();
  if not exists (select 1 from public.crew_profiles where user_id = uid) then raise exception 'Choose your crew name first.'; end if;
  select user_id into target from public.crew_profiles where lower(name) = lower(btrim(coalesce(p_name, '')));
  if target is null then raise exception 'That crew member isn''t here any more.'; end if;
  if target = uid then raise exception 'That''s you.'; end if;
  if p_on then
    if (select count(*) from public.crew_follows where follower = uid and created_at > now() - interval '24 hours') >= 200 then
      raise exception 'You''ve followed a lot of crew today. Try again tomorrow.'; end if;
    if (select count(*) from public.crew_follows where follower = uid) >= 2000 then
      raise exception 'You can follow up to 2,000 crew.'; end if;
    insert into public.crew_follows (follower, followee) values (uid, target) on conflict do nothing;
  else
    delete from public.crew_follows where follower = uid and followee = target;
  end if;
  return jsonb_build_object('i_follow', p_on, 'followers', (select count(*) from public.crew_follows where followee = target));
end $$;

-- Who follows someone, or who they follow (names only, newest first).
create or replace function public.crew_follow_list(p_name text, p_kind text)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); target uuid;
begin
  perform public._crew_only();
  select user_id into target from public.crew_profiles where lower(name) = lower(btrim(coalesce(p_name, '')));
  if target is null then raise exception 'That crew member isn''t here any more.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('name', pr.name,
             'i_follow', exists (select 1 from public.crew_follows x where x.follower = uid and x.followee = pr.user_id),
             'is_me', pr.user_id = uid) order by f.created_at desc)
    from (select * from public.crew_follows f
           where (p_kind = 'followers' and f.followee = target) or (p_kind = 'following' and f.follower = target)
           order by f.created_at desc limit 300) f
    join public.crew_profiles pr on pr.user_id = case when p_kind = 'followers' then f.follower else f.followee end
  ), '[]'::jsonb);
end $$;

-- Posting a deal: the offer in a few words, the place, and an optional last day.
create or replace function public.crew_deal_add(p_dest text, p_name text, p_body text, p_place text, p_deal text, p_until date, p_photo text)
returns bigint language plpgsql security definer set search_path to '' as $$
declare new_id bigint; d text := btrim(coalesce(p_deal, ''));
begin
  perform public._crew_only();
  if char_length(d) not between 3 and 80 then raise exception 'Say what the deal is in a few words, e.g. 20%% off with crew ID.'; end if;
  if nullif(btrim(coalesce(p_place, '')), '') is null then raise exception 'Add the place name, so crew can find it.'; end if;
  if p_until is not null and (p_until < current_date or p_until > current_date + 400) then
    raise exception 'Choose a last day between today and next year.'; end if;
  new_id := public._crew_post_add(p_dest, p_name, 'Deal', coalesce(nullif(btrim(coalesce(p_body, '')), ''), d), p_place, null, p_photo);
  update public.crew_posts set deal = d, deal_until = p_until where id = new_id;
  return new_id;
end $$;

-- Regular posts can't use the Deal category (deals need an offer); _crew_post_add allows it for crew_deal_add.
create or replace function public.crew_post_add(p_dest text, p_name text, p_cat text, p_body text, p_place text, p_rating integer, p_photo text)
returns bigint language plpgsql security definer set search_path to '' as $$
begin
  perform public._crew_only();
  if p_cat = 'Deal' then raise exception 'Use Share a deal to post a deal.'; end if;
  return public._crew_post_add(p_dest, p_name, p_cat, p_body, p_place, p_rating, p_photo);
end $$;

-- _crew_post_add: same as before, with Deal allowed (only crew_deal_add passes it).
create or replace function public._crew_post_add(p_dest text, p_name text, p_cat text, p_body text, p_place text, p_rating integer, p_photo text)
returns bigint language plpgsql security definer set search_path to '' as $$
declare
  uid uuid := (select auth.uid());
  txt text := btrim(regexp_replace(coalesce(p_body, ''), '[ \t]+', ' ', 'g'));
  plc text := nullif(btrim(coalesce(p_place, '')), '');
  new_id bigint;
begin
  if uid is null then raise exception 'Sign in to post.'; end if;
  if not exists (select 1 from public.crew_profiles where user_id = uid) then
    raise exception 'Choose your crew name first.'; end if;
  if p_photo is not null and p_photo !~ ('^' || uid::text || '/[0-9a-f-]{36}\.(jpg|mp4|mov)$') then
    raise exception 'That photo or video could not be attached. Try again.'; end if;
  if char_length(txt) < 3 and p_photo is null then raise exception 'Write a few words or add a photo or video.'; end if;
  if char_length(txt) > 500 then raise exception 'Keep the post under 500 characters.'; end if;
  if plc is not null and char_length(plc) > 60 then raise exception 'Keep the place name under 60 characters.'; end if;
  if p_rating is not null and p_rating not between 1 and 5 then raise exception 'Choose 1 to 5 stars.'; end if;
  if p_cat is null or p_cat not in ('Food','Sights','Shopping','Transport','Safety','Other','Deal') then
    raise exception 'Choose a category.'; end if;
  if p_dest is null or char_length(p_dest) not between 2 and 80 then
    raise exception 'Choose a destination first.'; end if;
  if (select count(*) from public.crew_posts where user_id = uid and created_at > now() - interval '24 hours') >= 10 then
    raise exception 'You''ve posted 10 times today. Come back tomorrow to share more.'; end if;
  insert into public.crew_posts (user_id, dest_key, dest_name, category, body, place, rating, photo_path)
  values (uid, p_dest, left(coalesce(nullif(btrim(p_name), ''), p_dest), 80), p_cat, txt, plc, p_rating, p_photo)
  returning id into new_id;
  return new_id;
end $$;

-- Who can call what: internal helpers stay private; the views need a signed-in crew member.
revoke all on function public._crew_feed2(text, text, bigint, uuid) from public, anon, authenticated;
revoke all on function public.crew_feed_view(text, text, bigint), public.crew_profile(text, bigint), public.crew_follow(text, boolean),
  public.crew_follow_list(text, text), public.crew_deal_add(text, text, text, text, text, date, text) from public, anon;
grant execute on function public.crew_feed_view(text, text, bigint), public.crew_profile(text, bigint), public.crew_follow(text, boolean),
  public.crew_follow_list(text, text), public.crew_deal_add(text, text, text, text, text, date, text) to authenticated;
