-- Layover Logbook: daily question counter for the Ask AI help assistant (backend/ask-ai.ts).
-- Applied to Supabase project layover-logbook as migration `ask_ai_daily_limit`.

create table if not exists public.ai_help_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default (now() at time zone 'utc')::date,
  n int not null default 0,
  primary key (user_id, day)
);
alter table public.ai_help_usage enable row level security;   -- no policies: only the function below touches it

-- Count one question for the caller today and return today's total.
create or replace function public.ai_help_tick() returns int
language plpgsql security definer set search_path to '' as $$
declare uid uuid := (select auth.uid()); total int;
begin
  if uid is null then raise exception 'Not signed in'; end if;
  insert into public.ai_help_usage as u (user_id, day, n) values (uid, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set n = u.n + 1
  returning n into total;
  delete from public.ai_help_usage where day < (now() at time zone 'utc')::date - 7;
  return total;
end $$;

revoke all on function public.ai_help_tick() from public, anon;
grant execute on function public.ai_help_tick() to authenticated;
