# Guardians, monitors, succession, fallback plan and asset photos: design and build spec

> Branch `feature/guardians`. Started 14 Nov 2026, judging day.
> **Nothing here touches `main`, the live site or the deployed devnet program until after judging.** The program is
> built and tested locally (LiteSVM); a devnet upgrade happens only when Tumo says so.
> Decisions (Tumo, 14 Nov): monitors are notified AND can object; succession = death certificate + AI check +
> confirmation + short wait; fallback = certificates for everyone + AI check + long wait with objections.

## 1. What we are building (plain words)

1. **Photos of anything to sell.** The owner can register any asset (car, motorbike, furniture, jewellery, other) and
   upload photos of it. Photos are converted to **WebP** in the browser before upload, checked again on the server,
   stored off-chain, and only a hash of the photo set goes on-chain. Buyers see the photos on the asset page.
2. **Monitors.** For each trusted person ("seat"), the owner can name up to 2 **monitors** (e.g. Thabo names his sister
   to watch his brother). Every approval that seat holder makes is recorded on-chain and shown to the monitors. A monitor
   can **raise an objection** within a review window; the objection **pauses** that payment / unlock / sale until it is
   resolved. The objection and its outcome stay on-chain as evidence ("the brother approved X; the sister objected").
3. **Backups and succession (the chain never runs out).** Each seat holder has up to 2 **backups**. If the holder dies,
   anyone uploads the holder's death certificate; the AI checks it; another trusted person (or, if none is left, the
   seat's second backup or a monitor) confirms; a short waiting period runs (the holder can say "I'm still here"); then
   the first backup takes the seat. The new holder names their own 2 backups, so there is always someone available.
4. **Fallback plan (when everyone is gone).** The owner writes an ordered fallback list: e.g. 1) all funds to Lerato,
   2) if Lerato has died, to Sipho, 3) if no family member is left, to a named charity. It runs only when **every seat
   is vacant** (each holder and all backups proven dead), the owner's death is proven, and a **long waiting period**
   (90 days; 2 minutes in the demo) has passed with no objection. Then the whole vault goes to the first recipient who
   is not proven dead.

## 2. Contract (Anchor program, `programs/heirloom`) — owner: Agent A

**Compatibility rule:** do NOT change the layout of any existing account (`Estate`, `Claim`, `Asset`, …). Existing
devnet estates must keep deserialising. Only add new account types, new instructions, new events and new errors.
Changing a *value* inside an existing account (e.g. `estate.verifiers[i] = new_holder`, `claim.status = Rejected`) is fine.

### 2.1 New accounts
```rust
/// Seeds: ["seat", estate, &[index]]  (index 0..3, mirrors estate.verifiers[index])
pub struct Seat {
    pub estate: Pubkey,
    pub index: u8,
    pub holder: Pubkey,            // always == estate.verifiers[index]; Pubkey::default() when vacant
    pub backups: [Pubkey; 2],      // default = empty
    pub monitors: [Pubkey; 2],     // set by the owner only; survive succession
    pub generation: u16,           // +1 on every succession
    pub vacant: bool,              // holder dead and no backup left
    // succession in progress
    pub death_cert_hash: [u8; 32],
    pub death_reported_by: Pubkey,
    pub death_verdict: Verdict,    // agent review
    pub death_confirmed_by: Pubkey,// one confirmer (see 2.3)
    pub death_pending_since: i64,  // 0 = none
    pub bump: u8,
}

/// Seeds: ["guard", estate]   one per estate; created by the owner (or the agent at setup)
pub struct Guard {
    pub estate: Pubkey,
    pub objection_window_secs: i64,     // claims: delay between final approval and execute (demo 60)
    pub succession_wait_secs: i64,      // demo 60; real 7 days
    pub fallback_wait_secs: i64,        // demo 120; real 90 days
    pub open_objections: u16,
    pub fallback: [Pubkey; 4],          // ordered recipients (wallets); default = unused
    pub fallback_dead: u8,              // bitmap: recipient i proven dead
    pub fallback_started_at: i64,       // 0 = not started
    pub fallback_done: bool,
    pub bump: u8,
}

/// Seeds: ["stamp", target]   created when a claim reaches its approval threshold
pub struct ApprovalStamp { pub target: Pubkey, pub seat_index: u8, pub approver: Pubkey, pub approved_at: i64, pub bump: u8 }

/// Seeds: ["objection", target]   one per target (claim, hardship, estate-unlock, sale offer, seat succession, fallback)
pub struct Objection {
    pub estate: Pubkey,
    pub target: Pubkey,
    pub kind: TargetKind,          // Claim | Unlock | Sale | Hardship | Succession | Fallback
    pub monitor: Pubkey,           // who objected
    pub seat_index: u8,            // seat being watched (255 = not seat-specific)
    pub reason_hash: [u8; 32],     // SHA-256 of the written reason (text stays off-chain)
    pub raised_at: i64,
    pub status: ObjectionStatus,   // Open | Upheld | Dismissed
    pub votes_uphold: u8,          // bitmap of seats
    pub votes_dismiss: u8,
    pub bump: u8,
}

/// Seeds: ["media", asset]
pub struct AssetMedia { pub asset: Pubkey, pub kind: AssetKind, pub photos_root: [u8; 32], pub photo_count: u8, pub updated_at: i64, pub bump: u8 }
// AssetKind: Car | Motorbike | Furniture | Jewellery | Electronics | Other
```

### 2.2 New instructions (names are the IDL names the app will call)
| Instruction | Signer | What it does / checks |
|---|---|---|
| `init_guard(objection_window, succession_wait, fallback_wait)` | owner (Active) or agent at setup | creates Guard; creates nothing else |
| `init_seat(index, backups[2], monitors[2])` | owner (Active) | creates Seat i; holder = estate.verifiers[i] |
| `set_seat_backups(index, backups[2])` | owner (Active) **or** the current holder | backups ≠ holder, ≠ other holders, ≠ owner |
| `set_seat_monitors(index, monitors[2])` | owner (Active) only | monitors ≠ the holder they watch |
| `set_fallback(recipients[4])` | owner (Active) | ordered fallback list |
| `report_seat_death(index, cert_hash)` | anyone except the holder | seat not vacant, no succession pending |
| `review_seat_death(index, approve, report_hash)` | agent | sets death_verdict |
| `confirm_seat_death(index)` | holder of another seat; if no other seat has a living holder: backups[1] of this seat or a monitor of this seat | needs verdict Approved; confirmer ≠ reporter ≠ backups[0] |
| `veto_seat_death(index)` | the holder ("I'm still here") | clears the pending succession |
| `finalize_succession(index)` | anyone | verdict Approved, confirmed, `now ≥ pending_since + succession_wait`, no open Objection on the seat; holder := backups[0] (or [1]); shift backups; generation += 1; also writes `estate.verifiers[index]`; if no backup: vacant = true, holder = default |
| `owner_replace_seat(index, new_holder)` | owner (Active) | owner alive can simply swap a trusted person |
| `raise_objection(kind, target, seat_index, reason_hash)` | a monitor of that seat (any monitor for Unlock/Fallback; for Fallback also any beneficiary) | creates Objection, open_objections += 1 |
| `vote_objection(uphold)` | a seat holder who is not the watched holder; or the owner while Active (decides alone) | 2 votes (or the owner) decide; Upheld → target cancelled (claim.status = Rejected; death claim cleared; succession cleared; fallback reset; offer acceptance blocked until relisted); Dismissed → paused flow continues |
| `set_asset_media(kind, photos_root, photo_count)` | owner (Active) or agent | creates/updates AssetMedia |
| `report_fallback_death(i, cert_hash)` + `review_fallback_death(i, approve, report_hash)` | anyone / agent | marks fallback recipient i dead (bit in fallback_dead) |
| `start_fallback()` | anyone | all 3 Seats vacant; owner's death claim agent-approved (estate.death_verdict == Approved) or estate Unlocked; not started |
| `execute_fallback()` | anyone | started, `now ≥ started + fallback_wait`, no open objection on the guard, not done; transfers the **whole vault** to the first recipient whose dead bit is 0; sets fallback_done; estate stays Unlocked |

### 2.3 Changes to existing instructions (accounts may be added; layouts may not change)
- `approve_claim`: when the threshold is reached, also init `ApprovalStamp` for the claim (payer = approver or sponsor).
- `execute_claim`: if a Guard exists for the estate: require the stamp and `now ≥ approved_at + objection_window_secs`,
  and the `["objection", claim]` PDA must be empty or not Open. Pass the guard / stamp / objection PDAs as accounts
  (objection as an unchecked PDA: the program checks its address and, if data exists, its status).
- `finalize_unlock`, `accept_offer`, `approve_hardship`-gated sales: same objection-PDA check for their targets
  (Unlock target = the estate; Sale target = the asset).
- `attest_death`, `approve_claim`, `approve_hardship`: emit `SeatApproval { estate, seat_index, approver, kind, target, ts }`
  so monitors are notified from on-chain events.
- Verifier checks use `estate.verifiers` as today, so a successor can approve immediately after `finalize_succession`.
- Estates without a Guard behave exactly as today (no window, no objections): backwards compatible.

### 2.4 Events and errors
Events: `SeatApproval`, `SeatDeathReported`, `SeatDeathReviewed`, `SeatDeathConfirmed`, `SuccessionFinalized`,
`SeatVacated`, `ObjectionRaised`, `ObjectionResolved`, `FallbackSet`, `FallbackStarted`, `FallbackExecuted`,
`AssetMediaSet`. Errors (append at the end of the enum, never reorder): `NotMonitor`, `ObjectionOpen`,
`ObjectionWindowOpen`, `SuccessionPending`, `NoSuccessionPending`, `SeatVacant`, `SeatsNotVacant`, `NotConfirmer`,
`FallbackNotReady`, `FallbackDone`, `NoFallbackRecipient`, `BadBackup`, `BadMonitor`.

### 2.5 Tests (Rust, `programs/heirloom/tests/heirloom.rs`, LiteSVM) — one test per check
Monitor objects to a claim → execute blocked → 2 holders uphold → claim Rejected; dismissed → executes after window;
window not passed → `ObjectionWindowOpen`; non-monitor objects → `NotMonitor`; succession happy path (brother dies,
first backup takes the seat and can approve); holder vetoes; reporter can't confirm; backups[0] can't confirm their own
promotion; no backups → vacant; chain of succession twice (generation 2); fallback blocked while a seat is filled;
fallback to recipient 0; recipient 0 proven dead → recipient 1; open objection blocks execute_fallback; estates
without Guard unchanged (all 25 existing tests still pass).

Build/test: `wsl -d Ubuntu -u tumo --cd ~ -- bash "/mnt/c/Users/tumom/Hackathons/heirloom-guardians/scripts/build-program.sh" test`
(mirrors to `~/heirloom-build`, copies the IDL into `app/src/lib/chain/idl/heirloom.json`). **Never run `deploy`.**

## 3. App service layer — owner: Agent B
Shared types: `app/src/lib/guardians/types.ts` (already written; extend, don't rename). Implement `GuardiansService`
in `lib/service/mock.ts` (realistic demo data: Thabo's brother, Uncle Bongani, holds seat 3; his backups are cousin Kagiso and
Ms. Pillay's colleague Adv. Naidoo; Thabo's sister, Aunt Zodwa, monitors Bongani) and in `lib/service/chain.ts` (instruction builders in `lib/chain/instructions.ts`, PDAs in `pda.ts`, reads in
`reads.ts`/`snapshot.ts`, events in `events.ts`), then make `HeirloomService` extend it. Add the new instructions to
the sponsor allow-list (`lib/sponsor/policy.ts`) and the agent's allowed instructions. `/api/review` gains purposes
`seat-death` and `fallback-death` (same reviewer, death-certificate context naming the person). Monitor
notifications: derived from `SeatApproval` events in the snapshot (`guardians.feed`); in-app first (inbox badge).
Mock rules mirror the contract (the mock is the contract's twin; add tests for each rule in `mock.test.ts`).

## 4. UI — owner: Agent C (guardians) and Agent D (assets + photos)
Copy lives in NEW content files (`app/src/content/guardians.ts`, `app/src/content/assets.ts`) wired through the copy
provider; design tokens only; every form has the consent box; WCAG AA; works at 360 px.
- **C:** Plan builder + People screen: per trusted person, backups (2) and monitors (2); fallback order (children,
  named heir, charity with name + wallet). Monitor's inbox: "Approvals by <name> you watch" with **Raise an objection**
  (reason text, hashed). Objection card for trusted people/owner: Uphold / Dismiss. "Report a trusted person's passing"
  flow (upload certificate → agent report → confirm → waiting countdown → "<backup> now holds this seat"). Timeline
  shows successions. Fallback status card ("All trusted people are gone: the fallback plan starts in …").
- **D:** Generalise "Car" to **Assets** (any kind; the existing car keeps working). Photo uploader: pick/take up to 8
  photos, convert each to WebP in the browser (`canvas.toBlob("image/webp", 0.82)`, max 1600 px long edge; keep EXIF
  out), preview grid, reorder, remove. Server route `/api/assets/photos` (owner-signed like the legacy routes): checks
  the RIFF/WEBP magic bytes and size (≤ 1.5 MB each), stores in Supabase Storage (`asset-photos`, private, signed URLs)
  or memory, returns SHA-256s; the client then calls `setAssetMedia` with the Merkle-free root = SHA-256 of the
  concatenated photo hashes in order. Asset page shows a photo gallery to buyers. Tests for the WebP conversion
  helper, the magic-byte check and the root hash.

- **D2, richer assets (15 Nov 2026):** up to **24** photos per asset (program `MAX_PHOTOS`, app, API; Supabase
  migration 0004), each with a **label** (Front, Rear, Side, Interior, Dashboard, Engine, Boot, Wheels, Damage, Other);
  photo 1 is the cover ("Make cover" moves a photo to the front). AVIF is accepted: the browser decodes it and
  re-encodes WebP; the server's sharp reads AVIF for the fallback path. A **spec sheet** per vehicle (key facts:
  mileage, drive type, transmission, fuel, consumption, engine; Details; Condition; Performance), edited by the owner
  while the estate is Active, shown to family and buyers, stored off-chain with the photos and signed in the upload
  manifest. Code: `app/src/lib/assets/spec.ts` (schema, labels, root), `spec-form.ts`, `components/assets/spec-*.tsx`.
  **Every kind has its own sheet** (Tumo, 15 Nov: "the buyer would love to know something about that asset"),
  `SPEC_LAYOUTS`: Car/Motorbike as above; Furniture (material, size, pieces, condition; brand, colour, year, weight;
  proof of purchase, known faults); Jewellery (metal, purity, weight in grams, stones; brand, colour, year; condition,
  certificate, proof of purchase, known faults); Electronics (brand, model, year, condition; main features, colour,
  size, comes with; warranty, proof of purchase, known faults); Other (brand, model, year, condition; material,
  colour, size, weight, comes with; proof of purchase, known faults). The API, mock and chain service refuse a field
  that is not on that kind's sheet.
  **Media root** (what `AssetMedia.photos_root` now holds): zero when there are no photos and no spec sheet, else
  `SHA-256(0x02 ‖ photo digests in order ‖ one label byte per photo (index, 0xff = none) ‖ SHA-256(canonical JSON of
  the spec sheet, or 32 zero bytes))`. Changing, reordering or relabelling a photo, or any spec value, changes it.
  Demo: Thabo's 2017 Toyota Corolla 1.8 Exclusive CVT (16 photos; 13,500 / 12,500 / 10,500 USD₮) replaces the 2016
  Corolla in the story, and his 2025 Big Boy Mustang 250 (9 photos; 2,000 / 1,800 / 1,500) is a second asset. Photos
  converted by `scripts/demo-asset-photos.mjs` into `app/public/demo/assets/` (published with Tumo's permission).

## 5. Integration and release (lead)
1. A finishes → IDL in the branch → B wires `chain.ts`. 2. Lead merges, runs tsc, eslint, vitest, contrast, the Rust
tests. 3. Browser check of both flows in demo mode at 360 px and desktop. 4. After judging and with Tumo's OK:
`build-program.sh deploy` (program upgrade, same address), seed a Guard + Seats on a fresh demo estate, merge to main.

## 6. Out of scope for now
Email/WhatsApp notifications (in-app only), equal splits across several fallback recipients, Home Affairs checks,
moving the photos to Arweave/IPFS.
