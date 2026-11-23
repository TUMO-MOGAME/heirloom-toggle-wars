-- Richer assets (15 Nov 2026): up to 24 labelled photos per asset, and a spec sheet (key facts, details,
-- condition, performance) kept off-chain with the photos. photos_root now holds the media root: SHA-256 over the
-- photo hashes, their labels and the spec sheet's hash (app/src/lib/assets/spec.ts), so the on-chain
-- AssetMedia account fingerprints all three. Same access model as 0003: RLS on, no policies, service role only.

alter table public.asset_photos drop constraint if exists asset_photos_position_check;
alter table public.asset_photos add constraint asset_photos_position_check check (position between 0 and 23);

alter table public.asset_photos add column if not exists label text
  check (label is null or label in ('Front','Rear','Side','Interior','Dashboard','Engine','Boot','Wheels','Damage','Other'));

-- The spec sheet as the owner signed it (validated by the API; ≤ 400 characters of roadworthy notes).
alter table public.asset_media add column if not exists spec jsonb
  check (spec is null or (jsonb_typeof(spec) = 'object' and octet_length(spec::text) <= 4000));
