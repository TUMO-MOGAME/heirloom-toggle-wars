-- The written reasons of disputes and objections (plan §18.9 M9). On-chain an Objection holds only the reason's SHA-256;
-- until now the words stayed on the device that wrote them. Saved by the writer (signed, checked against the chain:
-- the objection exists, it is theirs and its hash is this text's), read by the estate's members only. Personal
-- information (POPIA): never on-chain. Same access model as 0001-0009: service-role key on the server, RLS ON with NO
-- policies. Deleting on request: delete the row.
create table if not exists public.challenge_reasons (
  estate       text not null,                                     -- Estate PDA (base58)
  target       text not null,                                     -- the challenged claim, estate, asset, hardship, seat or guard
  reason_hash  text not null check (reason_hash ~ '^[0-9a-f]{64}$'),
  reason       text not null check (char_length(reason) between 1 and 600),
  writer       text not null,                                     -- the wallet that raised it
  created_at   bigint not null,                                   -- unix seconds
  primary key (estate, target, reason_hash)
);
create index if not exists challenge_reasons_estate_idx on public.challenge_reasons (estate);

alter table public.challenge_reasons enable row level security;
revoke all on public.challenge_reasons from anon, authenticated;
