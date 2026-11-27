-- Layover Logbook: owner dashboard (sign-ups, installs, paying users).
-- Applied to Supabase project layover-logbook as migration `owner_business_stats`.
-- Shown in the app under Notebook -> Account and data -> Site statistics (owners in crew_owners only).

-- 1. Page views now say whether they came from an installed copy of the app,
--    and mark the first open of each installation (no identifier is stored).
alter table public.page_views add column if not exists app text;          -- 'home_screen' | 'android' | 'desktop' | null (browser)
alter table public.page_views add column if not exists install boolean not null default false;

drop function if exists public.track_view(text, text, text, text, boolean);
create or replace function public.track_view(p_path text, p_ref text default null, p_lang text default null,
  p_device text default 'desktop', p_entry boolean default false, p_app text default null, p_install boolean default false)
returns void language plpgsql security definer set search_path to '' as $$
declare
  pth text := left(split_part(split_part(coalesce(p_path,'/'), '?', 1), '#', 1), 120);
  ref text := lower(left(nullif(btrim(coalesce(p_ref,'')), ''), 100));
  lng text := lower(left(coalesce(p_lang,''), 2));
  ap text := case when p_app in ('home_screen','android','desktop','ios') then p_app end;
begin
  if pth !~ '^/[A-Za-z0-9/_.\-]*$' then return; end if;
  if ref is not null and ref !~ '^[a-z0-9.\-]+$' then ref := null; end if;
  if ref in ('karawene112.github.io') then ref := null; end if;
  if lng !~ '^[a-z]{2}$' then lng := null; end if;
  if p_device not in ('phone','tablet','desktop') then p_device := 'desktop'; end if;
  if (select count(*) from public.page_views where at > now() - interval '1 minute') >= 1000 then return; end if;
  insert into public.page_views (path, ref_host, lang, device, entry, app, install)
  values (pth, ref, lng, p_device, coalesce(p_entry,false), ap, ap is not null and coalesce(p_install,false));
end $$;
grant execute on function public.track_view(text,text,text,text,boolean,text,boolean) to anon, authenticated;

-- 2. Business numbers for the owner.
create or replace function public.owner_stats(p_days int default 30) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare d int := least(greatest(coalesce(p_days,30),1),365);
  since timestamptz := date_trunc('day', now()) - make_interval(days => d - 1);
  monthly_id text := 'pri_01m77y1hvwrf421vjdt01wq0s6';
  yearly_id  text := 'pri_01m77y2y25qstp4g1hrq91795q';
begin
  if not exists (select 1 from auth.users u join public.crew_owners o on o.email = lower(u.email)
                 where u.id = (select auth.uid()) and u.email_confirmed_at is not null) then
    raise exception 'not_owner';
  end if;
  return (
    with paying as (select * from public.subscriptions where status in ('active','trialing','past_due'))
    select jsonb_build_object(
      'accounts',       (select count(*) from auth.users where email_confirmed_at is not null),
      'accounts_new',   (select count(*) from auth.users where email_confirmed_at is not null and created_at >= since),
      'unconfirmed',    (select count(*) from auth.users where email_confirmed_at is null),
      'active',         (select count(*) from public.user_data where updated_at >= since),
      'crew',           (select count(*) from public.crew_members),
      'installs',       (select count(*) from public.page_views where install),
      'installs_new',   (select count(*) from public.page_views where install and at >= since),
      'install_kinds',  (select coalesce(jsonb_object_agg(app, n), '{}') from (select app, count(*) n from public.page_views where install group by 1) x),
      'app_visits',     (select count(*) from public.page_views where entry and app is not null and at >= since),
      'paying',         (select count(*) from paying),
      'monthly',        (select count(*) from paying where plan = monthly_id),
      'yearly',         (select count(*) from paying where plan = yearly_id),
      'trialing',       (select count(*) from paying where status = 'trialing'),
      'past_due',       (select count(*) from paying where status = 'past_due'),
      'cancelling',     (select count(*) from paying where cancel_at is not null),
      'cancelled',      (select count(*) from public.subscriptions where status in ('canceled','cancelled')),
      'mrr',            (select round(coalesce(sum(case when plan = yearly_id then 39.99/12 else 4.99 end),0)::numeric, 2) from paying where status <> 'trialing'),
      'signups_by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', g::date, 'n', coalesce(v.n,0)) order by g), '[]')
                         from generate_series(since::date, now()::date, interval '1 day') g
                         left join (select created_at::date dd, count(*) n from auth.users where created_at >= since group by 1) v on v.dd = g::date),
      'recent',         (select coalesce(jsonb_agg(x), '[]') from (
                           select u.email, u.created_at::date as joined, u.email_confirmed_at is not null as confirmed,
                                  coalesce(s.status, 'free') as status,
                                  case when s.plan = yearly_id then 'yearly' when s.plan = monthly_id then 'monthly' end as plan,
                                  exists (select 1 from public.crew_members m where m.user_id = u.id) as crew
                           from auth.users u left join public.subscriptions s on s.user_id = u.id
                           order by u.created_at desc limit 25) x)
    ));
end $$;
revoke all on function public.owner_stats(int) from public, anon;
grant execute on function public.owner_stats(int) to authenticated;
