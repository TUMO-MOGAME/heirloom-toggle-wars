-- Legacy Voice: a parent's message in the child's language (plan §20.1 item 4).
-- The estate owner's own versions of their Legacy Book messages in other spoken languages. Each row was approved by
-- the living owner: the API checks the wallet signature over the exact body, that the signer is the estate's
-- on-chain owner, and that the estate is Active. A machine suggestion is never stored here until the owner approves
-- it. Personal information (POPIA): same access model as 0002 (service-role key only; RLS ON with NO policies).
-- Nothing here goes on-chain.

create table if not exists public.legacy_translations (
  estate        text not null references public.legacy_books(estate) on delete cascade,
  milestone_id  text not null check (milestone_id ~ '^[a-z0-9-]{1,40}$'),
  lang          text not null check (lang ~ '^[a-z]{2}$'),                -- lib/voice/languages.ts (speech only)
  text          text not null check (char_length(text) between 1 and 2000), -- the approved words, exactly
  text_sha256   text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),       -- sha256(text)
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),     -- sha256(original message) when approved;
                                                                            -- a changed original is not played until re-approved
  owner_wallet  text not null,                                             -- the owner wallet that signed the approval
  approved_at   timestamptz not null default now(),
  primary key (estate, milestone_id, lang)
);

alter table public.legacy_translations enable row level security;
revoke all on public.legacy_translations from anon, authenticated;

-- Retention: deleted with the Legacy Book (cascade), when the owner removes a version, or when its message is
-- removed from the book.
