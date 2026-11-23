-- Trust Tree photos (plan.md §15.11). A face is personal information (POPIA) and is never on-chain, nor in the tree's
-- fingerprint. One small photo per person on an estate's tree: a 256x256 WebP made in the browser (re-encoded on a
-- canvas, so EXIF and location are stripped), at most 60 KB, stored as a data URL. Consent is checked by
-- /api/tree/photo before a write: a living adult sets only their own photo; the estate owner sets one for a child,
-- someone who has passed, someone without a wallet or an organisation (a logo). Same access model as 0001-0006: the
-- Next.js server uses the service-role key; RLS is ON with NO policies, so anon/authenticated can neither read nor
-- write. Deleting on request: delete the person's row (or the estate's rows).

create table if not exists public.family_photos (
  estate      text not null,                                         -- Estate PDA (base58)
  person      text not null check (char_length(person) <= 48),       -- wallet, or local:<slug> for someone without one
  data        text not null check (data = ''                         -- '' = removed (also hides a default drawing)
                                   or (char_length(data) <= 84000     -- data:image/webp;base64,… (60 KB of image data)
                                       and data like 'data:image/webp;base64,%')),
  created_by  text not null,                                         -- the wallet that added it
  created_at  bigint not null,                                       -- unix seconds
  primary key (estate, person)
);

create index if not exists family_photos_estate_idx on public.family_photos (estate);

alter table public.family_photos enable row level security;
revoke all on public.family_photos from anon, authenticated;
