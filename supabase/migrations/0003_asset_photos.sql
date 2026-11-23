-- Asset photos: pictures of the things an owner wants sold after their death (car, motorbike, furniture,
-- jewellery, electronics, other). Same access model as 0001/0002: the Next.js server uses the service-role key;
-- RLS is ON with NO policies, so the anon/authenticated roles can neither read nor write. Buyers see the photos
-- through short-lived signed URLs the server creates. Only photos_root (SHA-256 of the photo hashes in order)
-- goes on-chain (AssetMedia account). Photos are re-encoded to WebP in the browser, so EXIF (GPS) is dropped.

create table if not exists public.asset_media (
  estate       text not null,                                    -- Estate PDA (base58)
  asset        text not null,                                    -- Asset PDA (base58), checked against the chain by the API
  kind         text not null check (kind in ('Car','Motorbike','Furniture','Jewellery','Electronics','Other')),
  title        text not null check (char_length(title) between 1 and 120),
  description  text not null default '' check (char_length(description) <= 600),  -- off-chain only
  photos_root  text not null check (photos_root ~ '^[0-9a-f]{64}$'),
  updated_at   timestamptz not null default now(),
  primary key (estate, asset)
);

create table if not exists public.asset_photos (
  estate     text not null,
  asset      text not null,
  position   smallint not null check (position between 0 and 7),  -- display order; at most 8 photos per asset
  sha256     text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  path       text not null,                                        -- object in `asset-photos`; holds no names
  width      integer not null check (width between 1 and 1600),
  height     integer not null check (height between 1 and 1600),
  bytes      integer not null check (bytes between 1 and 1500000),
  created_at timestamptz not null default now(),
  primary key (estate, asset, position),
  unique (estate, asset, sha256),
  foreign key (estate, asset) references public.asset_media(estate, asset) on delete cascade
);

alter table public.asset_media  enable row level security;
alter table public.asset_photos enable row level security;
revoke all on public.asset_media, public.asset_photos from anon, authenticated;

-- Private bucket, WebP only, 1.5 MB per object (the API also checks the RIFF/WEBP magic bytes).
-- Paths: "<sha256(estate) prefix>/<sha256(asset) prefix>/<photo sha256>.webp".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('asset-photos', 'asset-photos', false, 1500000, array['image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Retention (placeholder, see the privacy policy): photos are deleted when the owner removes them, and
-- [N] months after the asset is sold, by a scheduled job the operator runs.
