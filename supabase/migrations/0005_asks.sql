-- "Ask for money" notes (plan.md §13.1). The request itself is an on-chain claim (amount, payee, the SHA-256 of the
-- letter or request note); this table keeps only what the chain does not: the purpose in the asker's words, the
-- currency they typed, and the owner's "no" (the program has no owner decline; while the estate is Active nothing is
-- paid without the owner's approval). Same access model as 0001-0003: the Next.js server uses the service-role key;
-- RLS is ON with NO policies, so the anon/authenticated roles can neither read nor write. Writes are signed by the
-- asker's (note) or the owner's (decline) wallet and checked against the chain by /api/asks.

create table if not exists public.asks (
  claim        text primary key,                                  -- Claim PDA (base58)
  estate       text not null,                                     -- Estate PDA (base58)
  purpose      text not null default '' check (char_length(purpose) <= 80),
  currency     text not null default 'USDT' check (currency in ('ZAR', 'USDT')),
  typed        numeric not null default 0 check (typed >= 0),
  attachment   boolean not null default true,
  created_at   bigint not null,                                   -- unix seconds
  declined_at  bigint                                             -- unix seconds, null = not declined
);

create index if not exists asks_estate_idx on public.asks (estate, created_at desc);

alter table public.asks enable row level security;
revoke all on public.asks from anon, authenticated;
