use anchor_lang::prelude::*;

pub const ESTATE_SEED: &[u8] = b"estate";
pub const BENEFICIARY_SEED: &[u8] = b"beneficiary";
pub const PAYEE_SEED: &[u8] = b"payee";
pub const RULE_SEED: &[u8] = b"rule";
pub const CLAIM_SEED: &[u8] = b"claim";
pub const ASSET_SEED: &[u8] = b"asset";
pub const OFFER_SEED: &[u8] = b"offer";
pub const HARDSHIP_SEED: &[u8] = b"hardship";
pub const SEAT_SEED: &[u8] = b"seat";
pub const GUARD_SEED: &[u8] = b"guard";
pub const STAMP_SEED: &[u8] = b"stamp";
pub const OBJECTION_SEED: &[u8] = b"objection";
pub const MEDIA_SEED: &[u8] = b"media";
pub const YEAR_CAP_SEED: &[u8] = b"yearcap";
pub const RESIDUAL_SEED: &[u8] = b"residual";
pub const AGENT_VOTE_SEED: &[u8] = b"agentvote";
pub const FALLBACK_REPORT_SEED: &[u8] = b"fallbackreport";

pub const MAX_WILL_URI_LEN: usize = 200;
pub const MAX_LABEL_LEN: usize = 32;
pub const MAX_PAYEE_NAME_LEN: usize = 64;
pub const VERIFIER_COUNT: usize = 3;
pub const FALLBACK_COUNT: usize = 4;
/// Photos per asset (set_asset_media). Raised from 8 to 24 on 15 Nov 2026 for labelled vehicle galleries.
pub const MAX_PHOTOS: u8 = 24;
/// `Objection.seat_index` when the objection is not about one seat (Unlock, Fallback).
pub const NO_SEAT: u8 = 255;
/// `Objection.seat_index` of a dispute (U9): raised by a beneficiary or a verifier, resolved by 2 of 3 verifiers.
pub const DISPUTE_SEAT: u8 = 254;
/// A dispute lapses after the estate's waiting period, but never sooner than this.
pub const DISPUTE_MIN_SECS: i64 = 60;
/// Length of a yearly-cap period (365 days).
pub const YEAR_SECS: i64 = 365 * 86_400;
/// Every wait is bounded, so no setting can lock funds forever.
pub const MIN_WAITING_SECS: i64 = 60;
pub const MAX_WAITING_SECS: i64 = YEAR_SECS;
/// The death waiting period a new estate (or any later change) may set: at least 5 minutes, so nobody is declared
/// dead offline in a minute (plan §22.1 P1). Estates created before keep their stored value; the 60 s floors stay.
pub const MIN_DEATH_WAITING_SECS: i64 = 300;
/// Trusted people needed to confirm a death on a new estate (or any later change): one person and the agent can't
/// unlock a living owner (P1). Quorums still shrink to the living seats.
pub const MIN_DEATH_THRESHOLD: u8 = 2;
/// High bit of a Sale `Objection.votes_uphold` (seat votes use bits 0..2): an earlier objection to this sale was
/// upheld, so offers made before `raised_at` stay too old even after this one is dismissed or lapses (P5).
pub const SALE_CUTOFF_KEPT: u8 = 1 << 7;
pub const MAX_GUARD_WAIT_SECS: i64 = 180 * 86_400;
pub const MAX_INTERVAL_SECS: i64 = 10 * YEAR_SECS;
pub const MIN_LISTING_SECS: i64 = 3_600;
pub const MAX_LISTING_SECS: i64 = 90 * 86_400;
/// sweep_residual passes every rule in one legacy transaction.
pub const MAX_RULES: u16 = 16;
/// People needed for anything the agent referred instead of approving.
pub const REFERRED_MIN_APPROVALS: u8 = 2;
/// An unreviewed death report keeps its place for one waiting period, at least 60 s and at most this long.
pub const MAX_REPORT_GRACE_SECS: i64 = 86_400;
/// High bit of `Estate.death_attestations` and `Claim.approvals`: the only trusted person left, who is also the
/// one who gains, decided alone (H4). The wait or the objection window is then doubled.
pub const DECIDED_ALONE: u8 = 1 << 7;

// ---------------------------------------------------------------- enums (Borsh order matters)

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum EstateStatus {
    Active,
    DeathPending,
    Unlocked,
    Frozen,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Category {
    Tuition,
    Accommodation,
    Books,
    Medical,
    General,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PayeeKind {
    University,
    School,
    Landlord,
    Other,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Verdict {
    Pending,
    Approved,
    Rejected,
    /// The agent could not decide: people do, with a higher quorum (appended 2026-11-22).
    Referred,
}

impl Verdict {
    /// The agent looked and did not reject: people may now decide.
    pub fn open_to_people(&self) -> bool {
        matches!(self, Verdict::Approved | Verdict::Referred)
    }

    /// The approvals needed, given the estate's threshold.
    pub fn quorum(&self, threshold: u8) -> u8 {
        if *self == Verdict::Referred { threshold.max(REFERRED_MIN_APPROVALS) } else { threshold }
    }
}

/// The agent's answer to review_death, review_claim and review_hardship. The first two values encode
/// like the bool they replace.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReviewOutcome {
    Reject,
    Approve,
    Refer,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ClaimStatus {
    Open,
    Paid,
    Rejected,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AssetStatus {
    Held,
    Listed,
    Sold,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum HardshipStatus {
    Open,
    Approved,
    Rejected,
}

// ---------------------------------------------------------------- accounts

/// Seeds: ["estate", owner]
#[account]
#[derive(InitSpace)]
pub struct Estate {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub usdt_mint: Pubkey,
    pub verifiers: [Pubkey; 3],
    pub death_threshold: u8,
    pub claim_threshold: u8,
    pub hardship_threshold: u8,
    pub waiting_period_secs: i64,
    pub status: EstateStatus,
    pub will_hash: [u8; 32],
    #[max_len(200)]
    pub will_uri: String,
    pub death_cert_hash: [u8; 32],
    pub death_submitted_by: Pubkey,
    pub death_verdict: Verdict,
    /// Bitmap: verifier i sets bit 1 << i.
    pub death_attestations: u8,
    /// While Active with a death claim: when it was submitted. Afterwards: when the quorum confirmed it.
    /// Read the state from `status` and `death_cert_hash`, never from this being non-zero.
    pub death_pending_since: i64,
    pub last_heartbeat: i64,
    pub rule_count: u16,
    pub bump: u8,
}

impl Estate {
    /// Index (0..3) of `key` in the verifier list.
    pub fn verifier_index(&self, key: &Pubkey) -> Option<usize> {
        self.verifiers.iter().position(|v| v == key)
    }

    /// The waiting period, clamped for estates created before the bounds existed (never under 60 s).
    pub fn waiting_secs(&self) -> i64 {
        self.waiting_period_secs.clamp(MIN_WAITING_SECS, MAX_WAITING_SECS)
    }

    /// Bitmap of the seats someone holds, leaving out `who` (nobody decides in their own favour).
    pub fn living_seats_except(&self, who: &Pubkey) -> u8 {
        self.verifiers.iter().enumerate().fold(0u8, |mask, (i, v)| {
            if *v != Pubkey::default() && v != who { mask | 1 << i } else { mask }
        })
    }

    /// `votes` reach min(`needed`, the living seats that may decide), which is never zero. One seat, one vote:
    /// a successor holds the seat's vote; a vacant seat's vote no longer counts.
    pub fn quorum_met(&self, votes: u8, interested: &Pubkey, needed: u8) -> bool {
        Self::votes_meet(votes, self.living_seats_except(interested), needed)
    }

    /// `votes` reach min(`needed`, the seats in `eligible`), and `eligible` is not empty.
    pub fn votes_meet(votes: u8, eligible: u8, needed: u8) -> bool {
        eligible != 0 && (votes & eligible).count_ones() >= u32::from(needed).min(eligible.count_ones())
    }

    /// The seats that decide, leaving out whoever gains. When nobody else holds a seat and the agent approved
    /// (never referred), the one who gains may decide alone (H4).
    pub fn deciders(&self, interested: &Pubkey, verdict: Verdict) -> u8 {
        let others = self.living_seats_except(interested);
        if others == 0 && verdict == Verdict::Approved { self.living_seats_except(&Pubkey::default()) } else { others }
    }

    /// The owner showed life after the open death claim was made (or quorum reached), for example under an older
    /// program whose check-in did not clear it (M2). Such a claim can't go on; anyone may replace it.
    pub fn death_disproved(&self) -> bool {
        self.death_cert_hash != [0u8; 32]
            && self.status != EstateStatus::Unlocked
            && self.last_heartbeat > self.death_pending_since
    }

    /// RT: how long an unanswered step waits before a recovery route opens (H3, H7).
    pub fn recovery_timeout(&self) -> i64 {
        self.reviewed_hold().saturating_mul(2)
    }

    /// The waiting period, clamped to 60 s..1 day: how long an unreviewed report keeps its place.
    pub fn report_grace(&self) -> i64 {
        self.waiting_secs().clamp(MIN_WAITING_SECS, MAX_REPORT_GRACE_SECS)
    }

    /// The wait between the quorum and the unlock: doubled when the one who gains decided alone.
    pub fn unlock_delay(&self) -> i64 {
        let times = if self.death_attestations & DECIDED_ALONE != 0 { 2 } else { 1 };
        self.waiting_secs().saturating_mul(times)
    }

    pub fn has_living_seat(&self) -> bool {
        self.living_seats_except(&Pubkey::default()) != 0
    }

    /// How long a reviewed death report keeps its place.
    pub fn reviewed_hold(&self) -> i64 {
        self.waiting_secs().max(MIN_WAITING_SECS).saturating_mul(2)
    }

    /// An unconfirmed death report (the estate's, a seat's or a fallback recipient's) may give way to one by
    /// `who`. Whoever made it waits one grace longer, so nobody refreshes their own hold ahead of the others.
    /// A report from before the times were stored (since = 0) is long stale.
    pub fn report_replaceable(
        &self,
        verdict: Verdict,
        since: i64,
        reporter: &Pubkey,
        who: &Pubkey,
        grace: i64,
        reviewed_hold: i64,
        ts: i64,
    ) -> bool {
        let mut hold = if verdict == Verdict::Pending { grace } else { reviewed_hold };
        if reporter == who {
            hold = hold.saturating_add(grace);
        }
        ts >= since.saturating_add(hold)
    }

    /// The death quorum and waiting period every new setting must meet (P1): create_estate, and any later change.
    pub fn check_death_settings(death_threshold: u8, waiting_period_secs: i64) -> Result<()> {
        require!(death_threshold >= MIN_DEATH_THRESHOLD, crate::errors::HeirloomError::DeathQuorumTooLow);
        require!(waiting_period_secs >= MIN_DEATH_WAITING_SECS, crate::errors::HeirloomError::DeathWaitTooShort);
        Ok(())
    }

    pub fn clear_death_claim(&mut self) {
        self.death_cert_hash = [0u8; 32];
        self.death_submitted_by = Pubkey::default();
        self.death_verdict = Verdict::Pending;
        self.death_attestations = 0;
        self.death_pending_since = 0;
    }
}

/// Seeds: ["beneficiary", estate, wallet]
#[account]
#[derive(InitSpace)]
pub struct Beneficiary {
    pub estate: Pubkey,
    pub wallet: Pubkey,
    #[max_len(32)]
    pub label: String,
    pub active: bool,
    pub bump: u8,
}

/// Seeds: ["payee", estate, wallet]
#[account]
#[derive(InitSpace)]
pub struct Payee {
    pub estate: Pubkey,
    pub wallet: Pubkey,
    pub kind: PayeeKind,
    #[max_len(64)]
    pub name: String,
    pub bump: u8,
}

/// Seeds: ["rule", estate, id.to_le_bytes() (u16)]
#[account]
#[derive(InitSpace)]
pub struct Rule {
    pub estate: Pubkey,
    pub id: u16,
    /// Beneficiary wallet (not the Beneficiary PDA).
    pub beneficiary: Pubkey,
    pub category: Category,
    pub allowed_payee_kind: PayeeKind,
    pub max_per_claim: u64,
    pub lifetime_cap: u64,
    pub spent_total: u64,
    pub valid_until: i64,
    pub claim_count: u32,
    /// Living plan: claims (and scheduled payments) work while the estate is still Active.
    pub starts_now: bool,
    /// Scheduled payment per interval; 0 = not recurring.
    pub recurring_amount: u64,
    pub interval_secs: i64,
    /// Unix time the next scheduled payment may be executed.
    pub next_due: i64,
    /// Payee wallet of the scheduled payment; Pubkey::default() = none.
    pub fixed_payee: Pubkey,
    pub bump: u8,
}

impl Rule {
    /// A reused slot starts its claim ids at the next multiple of 65,536, so the high 16 bits of an id say
    /// which of the slot's rules the claim was made under, and no claim address repeats.
    fn generation(id: u32) -> u32 {
        id >> 16
    }

    /// The claim was made under this rule, not under one that held the slot before it.
    pub fn is_current_claim(&self, claim_id: u32) -> bool {
        Self::generation(claim_id) == Self::generation(self.claim_count)
    }

    /// The id after `claim_count`, if it is still inside this rule's range.
    pub fn next_claim_count(&self) -> Option<u32> {
        self.claim_count.checked_add(1).filter(|next| self.is_current_claim(*next))
    }

    /// Where the claim ids of the slot's next rule start.
    pub fn next_generation_start(&self) -> Option<u32> {
        (self.claim_count | 0xffff).checked_add(1)
    }
}

/// Seeds: ["claim", rule, id.to_le_bytes() (u32)]
#[account]
#[derive(InitSpace)]
pub struct Claim {
    pub estate: Pubkey,
    pub rule: Pubkey,
    pub id: u32,
    /// Beneficiary wallet.
    pub beneficiary: Pubkey,
    /// Payee wallet.
    pub payee: Pubkey,
    pub amount: u64,
    pub evidence_hash: [u8; 32],
    pub agent_verdict: Verdict,
    pub agent_report_hash: [u8; 32],
    /// Bitmap: verifier i sets bit 1 << i.
    pub approvals: u8,
    pub status: ClaimStatus,
    pub created_at: i64,
    /// Set by `owner_approve_claim` (living plans, estate Active): replaces the verifier quorum.
    pub owner_approved: bool,
    pub bump: u8,
}

/// Seeds: ["asset", estate, nft_mint]
#[account]
#[derive(InitSpace)]
pub struct Asset {
    pub estate: Pubkey,
    pub nft_mint: Pubkey,
    pub floor_price: u64,
    pub hardship_floor: u64,
    pub asking_price: u64,
    pub proceeds_to: Pubkey,
    pub status: AssetStatus,
    pub listing_ends: i64,
    pub doc_hash: [u8; 32],
    pub hardship_beneficiary: Option<Pubkey>,
    pub bump: u8,
}

/// Seeds: ["offer", asset, buyer]
#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub asset: Pubkey,
    pub buyer: Pubkey,
    pub amount: u64,
    pub created_at: i64,
    pub bump: u8,
}

/// Seeds: ["hardship", asset, beneficiary_wallet]
#[account]
#[derive(InitSpace)]
pub struct Hardship {
    pub asset: Pubkey,
    /// Beneficiary wallet.
    pub beneficiary: Pubkey,
    pub evidence_hash: [u8; 32],
    pub agent_verdict: Verdict,
    pub agent_report_hash: [u8; 32],
    /// Bitmap: verifier i sets bit 1 << i.
    pub approvals: u8,
    pub status: HardshipStatus,
    pub bump: u8,
}

// ================================================================ guardians (added 2026-11-14)
// New accounts only: the layouts above are deployed on devnet and must not change.

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum TargetKind {
    Claim,
    Unlock,
    Sale,
    Hardship,
    Succession,
    Fallback,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ObjectionStatus {
    Open,
    Upheld,
    Dismissed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AssetKind {
    Car,
    Motorbike,
    Furniture,
    Jewellery,
    Electronics,
    Other,
}

/// Seeds: ["seat", estate, &[index]] (index 0..3, mirrors estate.verifiers[index]).
#[account]
#[derive(InitSpace)]
pub struct Seat {
    pub estate: Pubkey,
    pub index: u8,
    /// Always == estate.verifiers[index]; Pubkey::default() when vacant.
    pub holder: Pubkey,
    pub backups: [Pubkey; 2],
    /// Set by the owner only; survive succession.
    pub monitors: [Pubkey; 2],
    /// +1 on every succession or owner replacement.
    pub generation: u16,
    /// Holder proven dead and no backup left.
    pub vacant: bool,
    pub death_cert_hash: [u8; 32],
    pub death_reported_by: Pubkey,
    pub death_verdict: Verdict,
    pub death_confirmed_by: Pubkey,
    /// When the death was reported; once `death_confirmed_by` is set, when it was confirmed (the succession wait
    /// runs from there).
    pub death_pending_since: i64,
    pub bump: u8,
}

impl Seat {
    pub fn succession_pending(&self) -> bool {
        self.death_cert_hash != [0u8; 32]
    }

    pub fn clear_succession(&mut self) {
        self.death_cert_hash = [0u8; 32];
        self.death_reported_by = Pubkey::default();
        self.death_verdict = Verdict::Pending;
        self.death_confirmed_by = Pubkey::default();
        self.death_pending_since = 0;
    }

    /// A pending report that nobody confirmed and that `who` may replace.
    pub fn report_stale(&self, estate: &Estate, who: &Pubkey, ts: i64) -> bool {
        self.death_confirmed_by == Pubkey::default()
            && estate.report_replaceable(
                self.death_verdict,
                self.death_pending_since,
                &self.death_reported_by,
                who,
                estate.report_grace(),
                // A reviewed report stands long enough for the recovery route to open (H3) and be used.
                estate.recovery_timeout().saturating_add(estate.reviewed_hold()),
                ts,
            )
    }

    pub fn is_monitor(&self, key: &Pubkey) -> bool {
        *key != Pubkey::default() && self.monitors.contains(key)
    }
}

/// Seeds: ["guard", estate]. One per estate; its existence switches on windows and objections.
#[account]
#[derive(InitSpace)]
pub struct Guard {
    pub estate: Pubkey,
    /// Claims: delay between reaching the approval threshold and execute.
    pub objection_window_secs: i64,
    pub succession_wait_secs: i64,
    pub fallback_wait_secs: i64,
    pub open_objections: u16,
    /// Ordered fallback recipients (wallets); default = unused.
    pub fallback: [Pubkey; 4],
    /// Bitmap: recipient i proven dead sets bit 1 << i.
    pub fallback_dead: u8,
    /// 0 = not started.
    pub fallback_started_at: i64,
    pub fallback_done: bool,
    pub bump: u8,
}

impl Guard {
    pub fn objection_window(&self) -> i64 {
        self.objection_window_secs.clamp(0, MAX_GUARD_WAIT_SECS)
    }

    /// At least 60 s, so a living holder always has time to say "I'm still here" (a stored 0 waits 60 s).
    pub fn succession_wait(&self) -> i64 {
        self.succession_wait_secs.clamp(MIN_WAITING_SECS, MAX_GUARD_WAIT_SECS)
    }

    pub fn fallback_wait(&self) -> i64 {
        self.fallback_wait_secs.clamp(0, MAX_GUARD_WAIT_SECS)
    }

    /// How long a reported recipient has to refute before a second person can confirm.
    pub fn refute_wait(&self) -> i64 {
        self.fallback_wait().max(MIN_WAITING_SECS)
    }

    /// Set, not proven dead and not the estate itself (an older list could name it; paying the vault to itself
    /// can never execute, L1).
    pub fn is_living_recipient(&self, index: usize) -> bool {
        index < FALLBACK_COUNT
            && self.fallback[index] != Pubkey::default()
            && self.fallback[index] != self.estate
            && self.fallback_dead & (1u8 << index) == 0
    }

    pub fn is_living_listed(&self, who: &Pubkey) -> bool {
        (0..FALLBACK_COUNT).any(|i| self.is_living_recipient(i) && self.fallback[i] == *who)
    }

    /// The first living recipient at or after `from`.
    pub fn living_recipient_from(&self, from: usize) -> Option<usize> {
        (from..FALLBACK_COUNT).find(|i| self.is_living_recipient(*i))
    }

    /// Index of the next recipient; NO_SEAT if none.
    pub fn next_fallback_index(&self) -> u8 {
        self.living_recipient_from(0).map_or(NO_SEAT, |i| i as u8)
    }

    /// First recipient that is set and not proven dead; Pubkey::default() if none.
    pub fn next_fallback_recipient(&self) -> Pubkey {
        self.living_recipient_from(0).map(|i| self.fallback[i]).unwrap_or_default()
    }
}

/// Seeds: ["stamp", target]. Written by approve_claim; `approved_at` is set when the threshold is reached.
#[account]
#[derive(InitSpace)]
pub struct ApprovalStamp {
    pub target: Pubkey,
    pub seat_index: u8,
    pub approver: Pubkey,
    /// 0 = threshold not reached yet. Until it is, `seat_index` is NO_SEAT: the approvals being collected
    /// were all given after the unlock.
    pub approved_at: i64,
    pub bump: u8,
}

impl ApprovalStamp {
    /// The claim's approvals were given after the unlock. Those from before this death (an older program took
    /// them) neither pay nor stand in the way of a fresh quorum.
    pub fn votes_count(stamp: Option<&Self>, claim: &Claim, estate: &Estate) -> bool {
        let since = estate.death_pending_since;
        claim.created_at > since
            || stamp.is_some_and(|s| if s.approved_at == 0 { s.seat_index == NO_SEAT } else { s.approved_at >= since })
    }
}

/// Seeds: ["objection", target]. One per target; a resolved one can be re-raised (overwritten).
#[account]
#[derive(InitSpace)]
pub struct Objection {
    pub estate: Pubkey,
    pub target: Pubkey,
    pub kind: TargetKind,
    pub monitor: Pubkey,
    /// Seat being watched (NO_SEAT = 255 for Unlock / Fallback).
    pub seat_index: u8,
    pub reason_hash: [u8; 32],
    pub raised_at: i64,
    pub status: ObjectionStatus,
    /// Bitmaps: seat i sets 1 << i (Fallback: monitor j of seat i sets 1 << (2i + j)).
    pub votes_uphold: u8,
    pub votes_dismiss: u8,
    pub bump: u8,
}

impl Objection {
    /// A dispute (U9) rather than a monitor's objection.
    pub fn is_dispute(&self) -> bool {
        self.seat_index == DISPUTE_SEAT
    }

    /// Unix time this challenge lapses (counts as Dismissed). A dispute: one waiting period (at least 60 s).
    /// A monitors' objection: two, so one raised as an unlock starts still holds when the wait ends.
    /// Fallback objections lapse on the Guard's fallback wait instead.
    pub fn lapses_at(&self, estate: &Estate) -> i64 {
        let periods = if self.is_dispute() { 1 } else { 2 };
        self.raised_at
            .saturating_add(estate.waiting_secs().max(DISPUTE_MIN_SECS).saturating_mul(periods))
    }

    /// When a dismissed Sale or Succession objection may be raised again: the action gets as much free
    /// time as the objection could take.
    pub fn reraise_at(&self, estate: &Estate) -> i64 {
        self.lapses_at(estate)
            .saturating_add(estate.waiting_secs().max(DISPUTE_MIN_SECS))
    }

    /// The owner showed life after it was raised, so the death it challenged, and any votes on it, are void.
    /// Offers made at or before this time can't be accepted (M8): when this objection was upheld, or when an earlier
    /// one was (P5). None when no objection to the sale has been upheld.
    pub fn sale_cutoff(&self) -> Option<i64> {
        (self.kind == TargetKind::Sale
            && (self.status == ObjectionStatus::Upheld || self.votes_uphold & SALE_CUTOFF_KEPT != 0))
            .then_some(self.raised_at)
    }

    pub fn voided_by_owner(&self, estate: &Estate) -> bool {
        matches!(self.kind, TargetKind::Unlock | TargetKind::Fallback) && self.raised_at < estate.last_heartbeat
    }

    /// Open and still binding: a challenge past its lapse time no longer blocks anything.
    pub fn is_effectively_open(&self, estate: &Estate, ts: i64) -> bool {
        self.status == ObjectionStatus::Open
            && (self.kind == TargetKind::Fallback || (ts < self.lapses_at(estate) && !self.voided_by_owner(estate)))
    }
}

/// Seeds: ["media", asset]
#[account]
#[derive(InitSpace)]
pub struct AssetMedia {
    pub asset: Pubkey,
    pub kind: AssetKind,
    /// SHA-256 of the concatenated photo hashes, in display order.
    pub photos_root: [u8; 32],
    pub photo_count: u8,
    pub updated_at: i64,
    pub bump: u8,
}

// ================================================================ yearly caps (added 2026-11-15)

/// Seeds: ["yearcap", rule]. Optional per-rule cap per 365-day period, on top of the per-claim and
/// lifetime caps. Claims and scheduled payments under the rule add to `period_spent`.
#[account]
#[derive(InitSpace)]
pub struct YearCap {
    pub rule: Pubkey,
    /// Most that may be paid under the rule per period (base units).
    pub cap: u64,
    /// Start of the current period; rolls forward by whole periods.
    pub period_start: i64,
    /// Paid in the period that starts at `period_start`.
    pub period_spent: u64,
    pub bump: u8,
}

impl YearCap {
    /// (start, spent) of the period that contains `ts`: once a period has ended, spending starts again from 0.
    pub fn current(&self, ts: i64) -> (i64, u64) {
        if ts < self.period_start.saturating_add(YEAR_SECS) {
            return (self.period_start, self.period_spent);
        }
        let periods = (ts - self.period_start) / YEAR_SECS;
        (self.period_start.saturating_add(periods.saturating_mul(YEAR_SECS)), 0)
    }
}

// ================================================================ continuity (added 2026-11-22)

/// Seeds: ["residual", estate]. Who receives what no live rule still needs after the unlock.
#[account]
#[derive(InitSpace)]
pub struct Residual {
    pub estate: Pubkey,
    pub recipient: Pubkey,
    pub bump: u8,
}

/// Seeds: ["agentvote", estate, candidate]. The trusted people's votes to replace a lost agent key.
#[account]
#[derive(InitSpace)]
pub struct AgentVote {
    pub estate: Pubkey,
    pub candidate: Pubkey,
    /// The agent these votes replace; they are void once it is no longer the agent.
    pub replaces: Pubkey,
    /// The wallet that voted from each seat; counts only while it still holds that seat.
    pub voters: [Pubkey; 3],
    pub bump: u8,
}

/// Seeds: ["fallbackreport", estate, &[index]]. An open report that fallback recipient `index` died. Closed,
/// with the rent going back to `rent_payer`, when it is rejected, refuted or confirmed.
#[account]
#[derive(InitSpace)]
pub struct FallbackReport {
    pub estate: Pubkey,
    pub index: u8,
    /// The recipient reported; the report is void once the list names someone else there.
    pub recipient: Pubkey,
    pub reporter: Pubkey,
    /// Who created the account. A report that replaces it never takes over the rent.
    pub rent_payer: Pubkey,
    pub cert_hash: [u8; 32],
    pub verdict: Verdict,
    pub reported_at: i64,
    pub bump: u8,
}

impl FallbackReport {
    /// An approved report on `recipient` holds payments to them until it has had time to be confirmed or
    /// refuted: twice the refute wait, and no longer.
    pub fn holds_payment(&self, guard: &Guard, recipient: &Pubkey, ts: i64) -> bool {
        self.recipient == *recipient
            && self.verdict == Verdict::Approved
            && ts < self.reported_at.saturating_add(guard.refute_wait().saturating_mul(2))
    }
}
