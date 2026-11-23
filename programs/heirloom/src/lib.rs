//! Heirloom: a programmable estate trust. USD₮ sits in a vault owned by the Estate PDA and
//! only moves under the rules below. Spec: docs/program-spec.md (source of truth).
#![allow(unexpected_cfgs)]
#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

pub use errors::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY");

#[program]
pub mod heirloom {
    use super::*;

    // ------------------------------------------------------------------ setup (owner)

    pub fn create_estate(
        ctx: Context<CreateEstate>,
        agent: Pubkey,
        verifiers: [Pubkey; 3],
        death_threshold: u8,
        claim_threshold: u8,
        hardship_threshold: u8,
        waiting_period_secs: i64,
    ) -> Result<()> {
        instructions::setup::create_estate_handler(
            ctx,
            agent,
            verifiers,
            death_threshold,
            claim_threshold,
            hardship_threshold,
            waiting_period_secs,
        )
    }

    pub fn set_will(ctx: Context<SetWill>, will_hash: [u8; 32], will_uri: String) -> Result<()> {
        instructions::setup::set_will_handler(ctx, will_hash, will_uri)
    }

    pub fn add_beneficiary(ctx: Context<AddBeneficiary>, label: String) -> Result<()> {
        instructions::setup::add_beneficiary_handler(ctx, label)
    }

    pub fn add_payee(ctx: Context<AddPayee>, kind: PayeeKind, name: String) -> Result<()> {
        instructions::setup::add_payee_handler(ctx, kind, name)
    }

    /// Renamed from add_rule when rule_id became the first argument, so old clients and old programs fail closed.
    pub fn add_rule_v2(
        ctx: Context<AddRule>,
        rule_id: u16,
        category: Category,
        allowed_payee_kind: PayeeKind,
        max_per_claim: u64,
        lifetime_cap: u64,
        valid_until: i64,
        starts_now: bool,
        recurring_amount: u64,
        interval_secs: i64,
        first_due: i64,
    ) -> Result<()> {
        instructions::setup::add_rule_handler(
            ctx,
            rule_id,
            category,
            allowed_payee_kind,
            max_per_claim,
            lifetime_cap,
            valid_until,
            starts_now,
            recurring_amount,
            interval_secs,
            first_due,
        )
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::setup::deposit_handler(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::setup::withdraw_handler(ctx, amount)
    }

    pub fn heartbeat(ctx: Context<Heartbeat>) -> Result<()> {
        instructions::setup::heartbeat_handler(ctx)
    }

    pub fn register_asset(
        ctx: Context<RegisterAsset>,
        floor_price: u64,
        hardship_floor: u64,
        asking_price: u64,
        proceeds_to: Pubkey,
        doc_hash: [u8; 32],
    ) -> Result<()> {
        instructions::setup::register_asset_handler(
            ctx,
            floor_price,
            hardship_floor,
            asking_price,
            proceeds_to,
            doc_hash,
        )
    }

    // ------------------------------------------------------------------ death

    pub fn submit_death_claim(ctx: Context<SubmitDeathClaim>, cert_hash: [u8; 32]) -> Result<()> {
        instructions::death::submit_death_claim_handler(ctx, cert_hash)
    }

    pub fn review_death(
        ctx: Context<ReviewDeath>,
        outcome: ReviewOutcome,
        report_hash: [u8; 32],
        cert_hash: [u8; 32],
    ) -> Result<()> {
        instructions::death::review_death_handler(ctx, outcome, report_hash, cert_hash)
    }

    pub fn attest_death(ctx: Context<AttestDeath>) -> Result<()> {
        instructions::death::attest_death_handler(ctx)
    }

    pub fn veto_death(ctx: Context<VetoDeath>) -> Result<()> {
        instructions::death::veto_death_handler(ctx)
    }

    pub fn finalize_unlock(ctx: Context<FinalizeUnlock>) -> Result<()> {
        instructions::death::finalize_unlock_handler(ctx)
    }

    // ------------------------------------------------------------------ claims

    pub fn submit_claim(ctx: Context<SubmitClaim>, amount: u64, evidence_hash: [u8; 32]) -> Result<()> {
        instructions::claims::submit_claim_handler(ctx, amount, evidence_hash)
    }

    pub fn review_claim(ctx: Context<ReviewClaim>, outcome: ReviewOutcome, report_hash: [u8; 32]) -> Result<()> {
        instructions::claims::review_claim_handler(ctx, outcome, report_hash)
    }

    pub fn approve_claim(ctx: Context<ApproveClaim>) -> Result<()> {
        instructions::claims::approve_claim_handler(ctx)
    }

    pub fn execute_claim(ctx: Context<ExecuteClaim>) -> Result<()> {
        instructions::claims::execute_claim_handler(ctx)
    }

    pub fn owner_approve_claim(ctx: Context<OwnerApproveClaim>) -> Result<()> {
        instructions::claims::owner_approve_claim_handler(ctx)
    }

    pub fn execute_scheduled(ctx: Context<ExecuteScheduled>) -> Result<()> {
        instructions::claims::execute_scheduled_handler(ctx)
    }

    // ------------------------------------------------------------------ asset sale

    pub fn list_asset(ctx: Context<ListAsset>, duration_secs: i64) -> Result<()> {
        instructions::sale::list_asset_handler(ctx, duration_secs)
    }

    pub fn place_offer(ctx: Context<PlaceOffer>, amount: u64) -> Result<()> {
        instructions::sale::place_offer_handler(ctx, amount)
    }

    pub fn withdraw_offer(ctx: Context<WithdrawOffer>) -> Result<()> {
        instructions::sale::withdraw_offer_handler(ctx)
    }

    pub fn submit_hardship(ctx: Context<SubmitHardship>, evidence_hash: [u8; 32]) -> Result<()> {
        instructions::sale::submit_hardship_handler(ctx, evidence_hash)
    }

    pub fn review_hardship(ctx: Context<ReviewHardship>, outcome: ReviewOutcome, report_hash: [u8; 32]) -> Result<()> {
        instructions::sale::review_hardship_handler(ctx, outcome, report_hash)
    }

    pub fn approve_hardship(ctx: Context<ApproveHardship>) -> Result<()> {
        instructions::sale::approve_hardship_handler(ctx)
    }

    pub fn accept_offer(ctx: Context<AcceptOffer>, expected_amount: u64) -> Result<()> {
        instructions::sale::accept_offer_handler(ctx, expected_amount)
    }

    // ------------------------------------------------------------------ guardians (2026-11-14)

    pub fn init_guard(
        ctx: Context<InitGuard>,
        objection_window_secs: i64,
        succession_wait_secs: i64,
        fallback_wait_secs: i64,
    ) -> Result<()> {
        instructions::guardians::init_guard_handler(ctx, objection_window_secs, succession_wait_secs, fallback_wait_secs)
    }

    pub fn init_seat(ctx: Context<InitSeat>, index: u8, backups: [Pubkey; 2], monitors: [Pubkey; 2]) -> Result<()> {
        instructions::guardians::init_seat_handler(ctx, index, backups, monitors)
    }

    pub fn set_seat_backups(ctx: Context<SetSeatBackups>, index: u8, backups: [Pubkey; 2]) -> Result<()> {
        instructions::guardians::set_seat_backups_handler(ctx, index, backups)
    }

    pub fn set_seat_monitors(ctx: Context<SetSeatMonitors>, index: u8, monitors: [Pubkey; 2]) -> Result<()> {
        instructions::guardians::set_seat_monitors_handler(ctx, index, monitors)
    }

    pub fn set_fallback(ctx: Context<SetFallback>, recipients: [Pubkey; 4]) -> Result<()> {
        instructions::guardians::set_fallback_handler(ctx, recipients)
    }

    pub fn report_seat_death(ctx: Context<ReportSeatDeath>, index: u8, cert_hash: [u8; 32]) -> Result<()> {
        instructions::guardians::report_seat_death_handler(ctx, index, cert_hash)
    }

    pub fn review_seat_death(
        ctx: Context<ReviewSeatDeath>,
        index: u8,
        approve: bool,
        report_hash: [u8; 32],
        cert_hash: [u8; 32],
        holder: Pubkey,
    ) -> Result<()> {
        instructions::guardians::review_seat_death_handler(ctx, index, approve, report_hash, cert_hash, holder)
    }

    pub fn confirm_seat_death(ctx: Context<ConfirmSeatDeath>, index: u8) -> Result<()> {
        instructions::guardians::confirm_seat_death_handler(ctx, index)
    }

    pub fn veto_seat_death(ctx: Context<VetoSeatDeath>, index: u8) -> Result<()> {
        instructions::guardians::veto_seat_death_handler(ctx, index)
    }

    pub fn finalize_succession(ctx: Context<FinalizeSuccession>, index: u8) -> Result<()> {
        instructions::guardians::finalize_succession_handler(ctx, index)
    }

    pub fn owner_replace_seat(ctx: Context<OwnerReplaceSeat>, index: u8, new_holder: Pubkey) -> Result<()> {
        instructions::guardians::owner_replace_seat_handler(ctx, index, new_holder)
    }

    pub fn raise_objection(
        ctx: Context<RaiseObjection>,
        kind: TargetKind,
        target: Pubkey,
        seat_index: u8,
        reason_hash: [u8; 32],
    ) -> Result<()> {
        instructions::guardians::raise_objection_handler(ctx, kind, target, seat_index, reason_hash)
    }

    pub fn vote_objection<'info>(ctx: Context<'info, VoteObjection<'info>>, uphold: bool) -> Result<()> {
        instructions::guardians::vote_objection_handler(ctx, uphold)
    }

    pub fn set_asset_media(
        ctx: Context<SetAssetMedia>,
        kind: AssetKind,
        photos_root: [u8; 32],
        photo_count: u8,
    ) -> Result<()> {
        instructions::guardians::set_asset_media_handler(ctx, kind, photos_root, photo_count)
    }

    pub fn report_fallback_death(ctx: Context<ReportFallbackDeath>, index: u8, cert_hash: [u8; 32]) -> Result<()> {
        instructions::guardians::report_fallback_death_handler(ctx, index, cert_hash)
    }

    pub fn review_fallback_death(
        ctx: Context<ReviewFallbackDeath>,
        index: u8,
        approve: bool,
        report_hash: [u8; 32],
        cert_hash: [u8; 32],
        recipient: Pubkey,
    ) -> Result<()> {
        instructions::guardians::review_fallback_death_handler(ctx, index, approve, report_hash, cert_hash, recipient)
    }

    pub fn resolve_fallback_death(ctx: Context<ResolveFallbackDeath>, index: u8, dead: bool) -> Result<()> {
        instructions::guardians::resolve_fallback_death_handler(ctx, index, dead)
    }

    pub fn start_fallback(ctx: Context<StartFallback>) -> Result<()> {
        instructions::guardians::start_fallback_handler(ctx)
    }

    pub fn execute_fallback(ctx: Context<ExecuteFallback>) -> Result<()> {
        instructions::guardians::execute_fallback_handler(ctx)
    }

    pub fn lapse_objection(ctx: Context<LapseObjection>) -> Result<()> {
        instructions::guardians::lapse_objection_handler(ctx)
    }

    // ------------------------------------------------------------------ disputes, yearly caps (2026-11-15)

    pub fn raise_dispute(
        ctx: Context<RaiseDispute>,
        kind: TargetKind,
        target: Pubkey,
        reason_hash: [u8; 32],
    ) -> Result<()> {
        instructions::disputes::raise_dispute_handler(ctx, kind, target, reason_hash)
    }

    pub fn resolve_dispute(ctx: Context<ResolveDispute>, uphold: bool) -> Result<()> {
        instructions::disputes::resolve_dispute_handler(ctx, uphold)
    }

    pub fn set_yearly_cap(ctx: Context<SetYearlyCap>, cap: u64, period_start: i64) -> Result<()> {
        instructions::caps::set_yearly_cap_handler(ctx, cap, period_start)
    }

    // ------------------------------------------------------------------ continuity (22 Nov 2026)

    pub fn end_rule(ctx: Context<EndRule>) -> Result<()> {
        instructions::continuity::end_rule_handler(ctx)
    }

    pub fn set_residual(ctx: Context<SetResidual>, recipient: Pubkey) -> Result<()> {
        instructions::continuity::set_residual_handler(ctx, recipient)
    }

    pub fn sweep_residual<'info>(ctx: Context<'info, SweepResidual<'info>>) -> Result<()> {
        instructions::continuity::sweep_residual_handler(ctx)
    }

    pub fn set_agent(ctx: Context<SetAgent>, agent: Pubkey) -> Result<()> {
        instructions::continuity::set_agent_handler(ctx, agent)
    }

    pub fn vote_agent<'info>(ctx: Context<'info, VoteAgent<'info>>, candidate: Pubkey) -> Result<()> {
        instructions::continuity::vote_agent_handler(ctx, candidate)
    }

    // ------------------------------------------------------------------ second review (22 Nov 2026)

    pub fn release_asset(ctx: Context<ReleaseAsset>) -> Result<()> {
        instructions::setup::release_asset_handler(ctx)
    }

    pub fn remove_member(ctx: Context<RemoveMember>) -> Result<()> {
        instructions::setup::remove_member_handler(ctx)
    }
}
