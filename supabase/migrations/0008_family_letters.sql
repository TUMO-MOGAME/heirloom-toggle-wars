-- Letters for later (plan.md §16). Personal information (POPIA), never on-chain. Written and signed by the estate
-- owner's wallet while the estate is Active; read only by the author and, once open, the recipient (or the estate's
-- active beneficiaries for a family letter). Same access model as 0001-0007: service-role key on the server, RLS ON
-- with NO policies. Deleting: the owner's delete empties the row (tombstone); on request, delete the row.
-- NOT APPLIED YET (18 Nov 2026): until it is, /api/letters keeps letters in server memory and the owner's device.
create table if not exists public.family_letters (
  estate      text not null,
  id          text not null check (id ~ '^ltr_[1-9A-HJ-NP-Za-km-z]{16}$'),
  author      text not null,                                     -- owner wallet
  recipient   text not null,                                     -- 'family' or a wallet
  opens_kind  text not null check (opens_kind in ('unlock','date','payment','send')),
  opens_on    date,                                              -- date
  opens_rule  text,                                              -- payment: Rule PDA
  baseline    numeric,                                           -- payment: spent_total when linked (base units)
  opens_sig   text,                                              -- send: transfer signature
  about_asset text,
  transcribed jsonb,                                             -- { person, year } or null
  occasion    text not null default '' check (char_length(occasion) <= 60),
  body        text not null default '' check (char_length(body) <= 2000),
  version     integer not null check (version >= 1),
  hash        text not null check (char_length(hash) = 64),
  sig         text,                                              -- null only for seeded demo letters
  signed_at   bigint not null,
  created_at  bigint not null,
  updated_at  bigint not null,
  opened_at   bigint,
  deleted     boolean not null default false,
  primary key (estate, id)
);
create index if not exists family_letters_estate_idx on public.family_letters (estate, recipient);
alter table public.family_letters enable row level security;
revoke all on public.family_letters from anon, authenticated;
