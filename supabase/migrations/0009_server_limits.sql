-- Shared single-use tokens and allowances for the Next.js server (plan.md §18.3 S3), so replay protection, rate
-- limits and the agent's allowances hold across server instances. Both functions are atomic.
-- Keys are HMACs made by the server (lib/server/shared-store.ts): no wallet, estate, IP address or signature is stored
-- as itself, and every row expires. Same access model as 0001-0008: service-role key on the server, RLS ON with NO
-- policies, and only the service role may run the functions.
-- NOT APPLIED YET (22 Nov 2026): until it is, the limits are per instance, with a backstop read from the chain.

create table if not exists public.server_once (
  key         text primary key check (char_length(key) = 64),
  expires_at  timestamptz not null
);
create index if not exists server_once_expiry_idx on public.server_once (expires_at);

create table if not exists public.server_hits (
  id          bigint generated always as identity primary key,
  key         text not null check (char_length(key) = 64),
  at          timestamptz not null,
  expires_at  timestamptz not null
);
create index if not exists server_hits_key_idx on public.server_hits (key, at desc);
create index if not exists server_hits_expiry_idx on public.server_hits (expires_at);

alter table public.server_once enable row level security;
alter table public.server_hits enable row level security;
revoke all on public.server_once from anon, authenticated;
revoke all on public.server_hits from anon, authenticated;
grant select, insert, update, delete on public.server_once to service_role;
grant select, insert, update, delete on public.server_hits to service_role;

-- True exactly once per key until it expires.
create or replace function public.heirloom_use_once(p_key text, p_ttl_secs integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_rows integer;
begin
  if random() < 0.01 then
    delete from public.server_once o where o.expires_at <= v_now;
  end if;
  insert into public.server_once as o (key, expires_at)
    values (p_key, v_now + make_interval(secs => p_ttl_secs))
    on conflict (key) do update set expires_at = excluded.expires_at
      where o.expires_at <= v_now;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Takes one from every key's sliding-window allowance, or from none of them.
-- Returns 0 when taken, else the seconds until it could be.
create or replace function public.heirloom_take(p_keys text[], p_maxes integer[], p_windows integer[])
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_n integer := coalesce(cardinality(p_keys), 0);
  v_key text;
  v_now timestamptz;
  v_blocker timestamptz;
  v_wait integer := 0;
begin
  if v_n = 0 or v_n is distinct from cardinality(p_maxes) or v_n is distinct from cardinality(p_windows)
     or exists (select 1 from unnest(p_maxes) m where m is null or m < 1)
     or exists (select 1 from unnest(p_windows) w where w is null or w < 1) then
    raise exception 'heirloom_take: bad arguments';
  end if;

  -- One caller at a time per key, always locked in the same order.
  for v_key in select distinct k from unnest(p_keys) k order by k loop
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
  end loop;
  v_now := clock_timestamp();

  for i in 1..v_n loop
    v_blocker := null;
    -- The max-th newest: while it is inside the window, the allowance is used up.
    select h.at into v_blocker
      from public.server_hits h
      where h.key = p_keys[i] and h.at > v_now - make_interval(secs => p_windows[i])
      order by h.at desc
      offset p_maxes[i] - 1 limit 1;
    if v_blocker is not null then
      v_wait := greatest(v_wait, 1, ceil(extract(epoch from (v_blocker + make_interval(secs => p_windows[i]) - v_now)))::integer);
    end if;
  end loop;
  if v_wait > 0 then
    return v_wait;
  end if;

  -- One row per key, kept for the longest of its windows (a key may have an hourly and a daily allowance).
  insert into public.server_hits (key, at, expires_at)
    select t.k, v_now, v_now + make_interval(secs => max(t.w))
      from unnest(p_keys, p_windows) as t(k, w)
      group by t.k;
  if random() < 0.01 then
    delete from public.server_hits h where h.expires_at <= v_now;
  end if;
  return 0;
end;
$$;

revoke all on function public.heirloom_use_once(text, integer) from public, anon, authenticated;
revoke all on function public.heirloom_take(text[], integer[], integer[]) from public, anon, authenticated;
grant execute on function public.heirloom_use_once(text, integer) to service_role;
grant execute on function public.heirloom_take(text[], integer[], integer[]) to service_role;
