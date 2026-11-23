-- Trust Tree family links (plan.md §15.5). Relationships between family members and "hide me" flags are personal
-- information (POPIA) and are never on-chain: the chain keeps only wallets, roles and actions. Relationships are
-- declared by the estate's owner; a hidden flag is set by the person themselves (a living adult). Both are signed by
-- the acting wallet and checked against the chain by /api/tree. Same access model as 0001-0005: the Next.js server
-- uses the service-role key; RLS is ON with NO policies, so the anon/authenticated roles can neither read nor write.
-- Deleting on request: delete the estate's rows (relationships) or the wallet's rows (hidden flags).

create table if not exists public.family_links (
  estate      text not null,                                     -- Estate PDA (base58)
  id          text not null check (char_length(id) <= 200),     -- deterministic: rel:<kind>:<from>:<to>
  kind        text not null check (kind in ('parentOf', 'spouseOf', 'siblingOf')),
  from_id     text not null check (char_length(from_id) <= 48),  -- wallet, or local:<slug> for someone without one
  to_id       text not null check (char_length(to_id) <= 48),
  created_by  text not null,                                     -- the owner wallet that declared (or removed) it
  created_at  bigint not null,                                   -- unix seconds
  removed     boolean not null default false,                    -- a removed default relationship stays removed
  primary key (estate, id)
);

create index if not exists family_links_estate_idx on public.family_links (estate);

create table if not exists public.family_hidden (
  estate      text not null,                                     -- Estate PDA (base58)
  wallet      text not null,                                     -- the person who chose to hide (base58)
  hidden      boolean not null default true,
  updated_at  bigint not null,                                   -- unix seconds
  primary key (estate, wallet)
);

alter table public.family_links enable row level security;
alter table public.family_hidden enable row level security;
revoke all on public.family_links from anon, authenticated;
revoke all on public.family_hidden from anon, authenticated;
