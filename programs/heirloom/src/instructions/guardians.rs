//! Guardians: seats (trusted people) with backups and monitors, succession when a holder dies,
//! monitor objections, the fallback plan and asset photo hashes.
//! Spec: docs/guardians-spec.md §2 and docs/program-spec.md ("Guardians").
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::{
    account_exists, close_program_account, count_bits, now, objection_is_open, read_account, ready_token_account,
    record_proof_of_life, transfer_checked_cpi, void_objection, write_account,
};
use crate::errors::HeirloomError;
use crate::events::*;
use crate::state::*;

fn is_set(k: &Pubkey) -> bool {
    *k != Pubkey::default()
}

/// Moves a lone second entry into the first slot and rejects a duplicate pair.
fn compact_pair(pair: [Pubkey; 2]) -> Option<[Pubkey; 2]> {
    let out = if is_set(&pair[0]) { pair } else { [pair[1], Pubkey::default()] };
    if is_set(&out[1]) && out[0] == out[1] {
        return None;
    }
    Some(out)
}

/// Backups must differ from the owner, the agent, every current holder (this one included) and each other.
fn validate_backups(estate: &Estate, backups: [Pubkey; 2]) -> Result<[Pubkey; 2]> {
    let b = compact_pair(backups).ok_or(HeirloomError::BadBackup)?;
    for k in b.iter().filter(|k| is_set(k)) {
        require!(*k != estate.owner && *k != estate.agent, HeirloomError::BadBackup);
        require!(estate.verifier_index(k).is_none(), HeirloomError::BadBackup);
    }
    Ok(b)
}

/// Monitors must differ from the holder they watch and from each other.
fn validate_monitors(holder: &Pubkey, monitors: [Pubkey; 2]) -> Result<[Pubkey; 2]> {
    let m = compact_pair(monitors).ok_or(HeirloomError::BadMonitor)?;
    for k in m.iter().filter(|k| is_set(k)) {
        require!(k != holder, HeirloomError::BadMonitor);
    }
    Ok(m)
}

fn is_active_beneficiary(estate: &Pubkey, who: &Pubkey, beneficiary: Option<&Beneficiary>) -> bool {
    beneficiary.is_some_and(|b| b.estate == *estate && b.wallet == *who && b.active)
}

/// Someone other than the seat's first backup (who can't confirm their own promotion) watches the seat.
fn watched(seat: &Seat) -> bool {
    seat.monitors.iter().any(|m| is_set(m) && *m != seat.backups[0]) || is_set(&seat.backups[1])
}

/// No other seat is held and nobody watches this one: only then may an active beneficiary confirm its holder's
/// death at once (otherwise after the recovery timeout, H3).
fn beneficiary_may_confirm(estate: &Estate, seat: &Seat) -> bool {
    estate.living_seats_except(&seat.holder) == 0 && !watched(seat)
}

/// The owner changed who may confirm (replaced a holder, a monitor, removed a beneficiary): a confirmation by
/// someone who holds no seat gives way, so a living trusted person confirms instead (M4, L15). With `who`, only
/// that person's confirmations. `seats` are Seat PDAs that may not exist.
pub(crate) fn release_confirmations(estate: &Estate, seats: &[AccountInfo], who: Option<&Pubkey>) -> Result<()> {
    for info in seats.iter().filter(|i| account_exists(i)) {
        let mut seat: Seat = read_account(info)?;
        let by = seat.death_confirmed_by;
        if seat.succession_pending() && is_set(&by) && estate.verifier_index(&by).is_none() && who.map_or(true, |w| *w == by) {
            seat.clear_succession();
            write_account(info, &seat)?;
            emit!(SeatDeathReportCleared { estate: seat.estate, seat_index: seat.index, ts: now()? });
        }
    }
    Ok(())
}

/// A new agent: what the old one reviewed is set back to Pending for the new one to review (M6). `seats` are the
/// three Seat PDAs, `reports` the four FallbackReport PDAs; any may not exist.
pub(crate) fn clear_agent_reviews(estate: &Pubkey, seats: &[AccountInfo], reports: &[AccountInfo], ts: i64) -> Result<()> {
    for info in seats.iter().filter(|i| account_exists(i)) {
        let mut seat: Seat = read_account(info)?;
        if seat.succession_pending() && seat.death_verdict != Verdict::Pending {
            seat.death_verdict = Verdict::Pending;
            seat.death_confirmed_by = Pubkey::default();
            seat.death_pending_since = ts;
            write_account(info, &seat)?;
            emit!(AgentReviewCleared { estate: *estate, target: info.key(), ts });
        }
    }
    for info in reports.iter().filter(|i| account_exists(i)) {
        let mut report: FallbackReport = read_account(info)?;
        if report.verdict != Verdict::Pending {
            report.verdict = Verdict::Pending;
            report.reported_at = ts;
            write_account(info, &report)?;
            emit!(AgentReviewCleared { estate: *estate, target: info.key(), ts });
        }
    }
    Ok(())
}

/// A candidate agent must not be anyone's backup (L9): the seat would otherwise lose that backup.
pub(crate) fn check_not_a_backup(seats: &[AccountInfo], candidate: &Pubkey) -> Result<()> {
    for info in seats.iter().filter(|i| account_exists(i)) {
        let seat: Seat = read_account(info)?;
        require!(!seat.backups.contains(candidate), HeirloomError::BadAgent);
    }
    Ok(())
}

/// A living trusted person, a monitor (of `seat`) or an active beneficiary of this estate; never the agent,
/// who already reviews every report.
fn is_participant(estate: &Account<Estate>, who: &Pubkey, seat: Option<&Seat>, beneficiary: Option<&Beneficiary>) -> bool {
    let key = estate.key();
    *who != estate.agent
        && (estate.verifier_index(who).is_some()
            || seat.is_some_and(|s| s.estate == key && s.is_monitor(who))
            || is_active_beneficiary(&key, who, beneficiary))
}

/// Who may report or confirm a fallback recipient's death: a participant or a living listed recipient.
fn is_fallback_participant(
    estate: &Account<Estate>,
    guard: &Guard,
    who: &Pubkey,
    seat: Option<&Seat>,
    beneficiary: Option<&Beneficiary>,
) -> bool {
    is_participant(estate, who, seat, beneficiary)
        || (*who != estate.agent && (0..FALLBACK_COUNT).any(|i| guard.is_living_recipient(i) && guard.fallback[i] == *who))
}

/// Drops `key` from a pair and compacts it.
fn without(pair: [Pubkey; 2], key: &Pubkey) -> [Pubkey; 2] {
    let p = pair.map(|k| if k == *key { Pubkey::default() } else { k });
    if is_set(&p[0]) { p } else { [p[1], Pubkey::default()] }
}

/// The owner's death is established for the fallback: estate Unlocked, or the agent did not reject the claim and
/// the owner has shown no life since it was made.
fn owner_death_established(estate: &Estate) -> bool {
    estate.status == EstateStatus::Unlocked || (estate.death_verdict.open_to_people() && !estate.death_disproved())
}

/// A death the agent only referred, with no trusted people to decide it, waits twice as long. Never under 60 s.
fn fallback_delay(estate: &Estate, guard: &Guard) -> i64 {
    let times = if estate.status == EstateStatus::Active && estate.death_verdict == Verdict::Referred { 2 } else { 1 };
    guard.fallback_wait().max(MIN_WAITING_SECS).saturating_mul(times)
}

/// When a started countdown may pay: after its own delay, and never before the death's own wait (H6), so the
/// owner always has the waiting period to veto.
fn fallback_runs_at(estate: &Estate, guard: &Guard) -> i64 {
    let countdown = guard.fallback_started_at.saturating_add(fallback_delay(estate, guard));
    let death = match estate.status {
        EstateStatus::Unlocked => 0,
        EstateStatus::DeathPending => estate.death_pending_since.saturating_add(estate.unlock_delay()),
        _ => estate.death_pending_since.saturating_add(estate.waiting_secs()),
    };
    countdown.max(death)
}

/// The countdown still runs: started for this death, and the owner has shown no life since.
fn countdown_valid(estate: &Estate, guard: &Guard) -> bool {
    guard.fallback_started_at != 0
        && estate.last_heartbeat < guard.fallback_started_at
        && estate.death_pending_since <= guard.fallback_started_at
}

/// An Open Fallback objection lapses (counts as Dismissed) once the refute wait (the fallback wait, at least
/// 60 s) has passed since it was raised without it being upheld, so a missing or tied vote can never lock the
/// vault forever. One raised before the owner's last sign of life, or against an earlier countdown, is void with
/// its votes (L11).
fn fallback_objection_lapsed(o: &Objection, estate: &Estate, guard: &Guard, ts: i64) -> Result<bool> {
    if o.kind != TargetKind::Fallback || o.status != ObjectionStatus::Open {
        return Ok(false);
    }
    if o.voided_by_owner(estate) || o.raised_at < guard.fallback_started_at {
        return Ok(true);
    }
    let lapses_at = o.raised_at.checked_add(guard.refute_wait()).ok_or(HeirloomError::MathOverflow)?;
    Ok(ts >= lapses_at)
}

/// An upheld objection or dispute on a claim: an Open claim is cancelled (Rejected).
pub(crate) fn uphold_on_claim(info: &AccountInfo) -> Result<()> {
    let mut claim: Claim = read_account(info)?;
    if claim.status == ClaimStatus::Open {
        claim.status = ClaimStatus::Rejected;
        write_account(info, &claim)?;
    }
    Ok(())
}

/// An upheld objection or dispute on an unlock: the death claim is cleared and the estate is Active again.
pub(crate) fn uphold_on_unlock(estate: &mut Estate) {
    if estate.status != EstateStatus::Unlocked {
        estate.clear_death_claim();
        estate.status = EstateStatus::Active;
    }
}

/// Who gains if the challenged action goes ahead: they neither raise its one challenge nor dismiss it.
fn interested_party(kind: TargetKind, estate: &Estate, guard: &Guard, target: Option<&AccountInfo>) -> Result<Pubkey> {
    Ok(match kind {
        TargetKind::Claim => read_account::<Claim>(target.ok_or(HeirloomError::BadStatus)?)?.beneficiary,
        TargetKind::Hardship => read_account::<Hardship>(target.ok_or(HeirloomError::BadStatus)?)?.beneficiary,
        TargetKind::Unlock => estate.death_submitted_by,
        TargetKind::Fallback => guard.next_fallback_recipient(),
        TargetKind::Sale | TargetKind::Succession => Pubkey::default(),
    })
}

fn emit_seat_configured(seat: &Seat) -> Result<()> {
    emit!(SeatConfigured {
        estate: seat.estate,
        seat_index: seat.index,
        holder: seat.holder,
        backups: seat.backups,
        monitors: seat.monitors,
        generation: seat.generation,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== init_guard

#[derive(Accounts)]
pub struct InitGuard<'info> {
    /// The owner (estate Active): the waits can't be changed later, so never the agent. Pays rent.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        init,
        payer = authority,
        space = 8 + Guard::INIT_SPACE,
        seeds = [GUARD_SEED, estate.key().as_ref()],
        bump
    )]
    pub guard: Account<'info, Guard>,

    pub system_program: Program<'info, System>,
}

pub fn init_guard_handler(
    ctx: Context<InitGuard>,
    objection_window_secs: i64,
    succession_wait_secs: i64,
    fallback_wait_secs: i64,
) -> Result<()> {
    let estate = &ctx.accounts.estate;
    let authority = ctx.accounts.authority.key();
    require!(authority == estate.owner, HeirloomError::NotOwner);
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    for wait in [objection_window_secs, succession_wait_secs, fallback_wait_secs] {
        require!((0..=MAX_GUARD_WAIT_SECS).contains(&wait), HeirloomError::TimeOutOfRange);
    }

    let estate_key = estate.key();
    let bump = ctx.bumps.guard;
    ctx.accounts.guard.set_inner(Guard {
        estate: estate_key,
        objection_window_secs,
        succession_wait_secs,
        fallback_wait_secs,
        open_objections: 0,
        fallback: [Pubkey::default(); FALLBACK_COUNT],
        fallback_dead: 0,
        fallback_started_at: 0,
        fallback_done: false,
        bump,
    });

    emit!(GuardInitialized {
        estate: estate_key,
        objection_window_secs,
        succession_wait_secs,
        fallback_wait_secs,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== init_seat

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct InitSeat<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(
        init,
        payer = owner,
        space = 8 + Seat::INIT_SPACE,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump
    )]
    pub seat: Account<'info, Seat>,

    pub system_program: Program<'info, System>,
}

pub fn init_seat_handler(
    ctx: Context<InitSeat>,
    index: u8,
    backups: [Pubkey; 2],
    monitors: [Pubkey; 2],
) -> Result<()> {
    require!((index as usize) < VERIFIER_COUNT, HeirloomError::InvalidAmount);
    let estate = &ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);

    let holder = estate.verifiers[index as usize];
    let backups = validate_backups(estate, backups)?;
    let monitors = validate_monitors(&holder, monitors)?;

    let estate_key = estate.key();
    let bump = ctx.bumps.seat;
    ctx.accounts.seat.set_inner(Seat {
        estate: estate_key,
        index,
        holder,
        backups,
        monitors,
        generation: 0,
        vacant: !is_set(&holder),
        death_cert_hash: [0u8; 32],
        death_reported_by: Pubkey::default(),
        death_verdict: Verdict::Pending,
        death_confirmed_by: Pubkey::default(),
        death_pending_since: 0,
        bump,
    });
    emit_seat_configured(&ctx.accounts.seat)
}

// ====================================================================== set_seat_backups

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct SetSeatBackups<'info> {
    /// The owner (estate Active) or the seat's current holder.
    pub authority: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn set_seat_backups_handler(ctx: Context<SetSeatBackups>, _index: u8, backups: [Pubkey; 2]) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let estate = &ctx.accounts.estate;
    let seat = &mut ctx.accounts.seat;

    let is_owner = authority == estate.owner && estate.status == EstateStatus::Active;
    let is_holder = is_set(&seat.holder) && authority == seat.holder;
    require!(is_owner || is_holder, HeirloomError::NotOwner);
    let backups = validate_backups(estate, backups)?;
    if seat.succession_pending() {
        let ts = now()?;
        require!(seat.report_stale(estate, &authority, ts), HeirloomError::SuccessionPending);
        seat.clear_succession();
        emit!(SeatDeathReportCleared { estate: seat.estate, seat_index: seat.index, ts });
    }

    seat.backups = backups;
    emit_seat_configured(seat)
}

// ====================================================================== set_seat_monitors

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct SetSeatMonitors<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn set_seat_monitors_handler(ctx: Context<SetSeatMonitors>, _index: u8, monitors: [Pubkey; 2]) -> Result<()> {
    require!(
        ctx.accounts.estate.status == EstateStatus::Active,
        HeirloomError::BadStatus
    );
    let estate = &mut ctx.accounts.estate;
    let seat = &mut ctx.accounts.seat;
    let monitors = validate_monitors(&seat.holder, monitors)?;
    let ts = now()?;
    // Who watches changed, so a confirmation by someone who holds no seat (a monitor or a beneficiary) gives way.
    if monitors != seat.monitors && is_set(&seat.death_confirmed_by) && estate.verifier_index(&seat.death_confirmed_by).is_none() {
        seat.clear_succession();
        emit!(SeatDeathReportCleared { estate: seat.estate, seat_index: seat.index, ts });
    }
    seat.monitors = monitors;
    // Only the living owner can do this: votes on fallback objections by monitors it replaced are void (M1, M5).
    record_proof_of_life(estate.key(), estate, ts);
    emit_seat_configured(seat)
}

// ====================================================================== set_fallback

#[derive(Accounts)]
pub struct SetFallback<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Box<Account<'info, Estate>>,

    #[account(
        mut,
        seeds = [GUARD_SEED, estate.key().as_ref()],
        bump = guard.bump,
        has_one = estate
    )]
    pub guard: Box<Account<'info, Guard>>,

    /// CHECK: the ["fallbackreport", estate, [0]] PDA; may not exist. Every open report is void (L16).
    #[account(mut, seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[0u8]], bump)]
    pub fallback_report0: UncheckedAccount<'info>,
    /// CHECK: as fallback_report0, index 1.
    #[account(mut, seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[1u8]], bump)]
    pub fallback_report1: UncheckedAccount<'info>,
    /// CHECK: as fallback_report0, index 2.
    #[account(mut, seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[2u8]], bump)]
    pub fallback_report2: UncheckedAccount<'info>,
    /// CHECK: as fallback_report0, index 3.
    #[account(mut, seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[3u8]], bump)]
    pub fallback_report3: UncheckedAccount<'info>,
}

pub fn set_fallback_handler(ctx: Context<SetFallback>, recipients: [Pubkey; 4]) -> Result<()> {
    let estate = &mut ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    let guard = &mut ctx.accounts.guard;
    require!(!guard.fallback_done, HeirloomError::FallbackDone);

    for i in 0..FALLBACK_COUNT {
        if !is_set(&recipients[i]) {
            continue;
        }
        require!(recipients[i] != estate.owner && recipients[i] != estate.key(), HeirloomError::BadFallback);
        for j in (i + 1)..FALLBACK_COUNT {
            require!(recipients[i] != recipients[j], HeirloomError::BadFallback);
        }
    }

    guard.fallback = recipients;
    guard.fallback_dead = 0;
    // The owner is alive and changing the plan: any started countdown is void, and so is every open report of a
    // recipient's death: it names nobody until someone reports again.
    guard.fallback_started_at = 0;
    for info in [
        &ctx.accounts.fallback_report0,
        &ctx.accounts.fallback_report1,
        &ctx.accounts.fallback_report2,
        &ctx.accounts.fallback_report3,
    ] {
        let info = info.to_account_info();
        if account_exists(&info) {
            let mut report: FallbackReport = read_account(&info)?;
            report.recipient = Pubkey::default();
            write_account(&info, &report)?;
        }
    }
    let ts = now()?;
    record_proof_of_life(estate.key(), estate, ts);

    emit!(FallbackSet {
        estate: estate.key(),
        recipients,
        ts,
    });
    Ok(())
}

// ====================================================================== report_seat_death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ReportSeatDeath<'info> {
    /// A trusted person, the owner, this seat's backup or monitor, or an active beneficiary; never the holder.
    pub reporter: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,

    /// The reporter's Beneficiary PDA when a beneficiary reports; otherwise None.
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,

    /// CHECK: the ["objection", seat] PDA; may not exist. A challenge to the report this replaces is void (M7).
    #[account(mut, seeds = [OBJECTION_SEED, seat.key().as_ref()], bump)]
    pub objection: UncheckedAccount<'info>,
}

pub fn report_seat_death_handler(ctx: Context<ReportSeatDeath>, _index: u8, cert_hash: [u8; 32]) -> Result<()> {
    let reporter = ctx.accounts.reporter.key();
    let seat = &mut ctx.accounts.seat;
    require!(!seat.vacant && is_set(&seat.holder), HeirloomError::SeatVacant);
    require!(reporter != seat.holder, HeirloomError::BadStatus);
    require!(cert_hash != [0u8; 32], HeirloomError::NoDeathClaim);
    let estate = &ctx.accounts.estate;
    let beneficiary = ctx.accounts.beneficiary_account.as_deref().map(|b| &**b);
    require!(
        is_participant(estate, &reporter, Some(&**seat), beneficiary)
            || (reporter != estate.agent && (reporter == estate.owner || seat.backups.contains(&reporter))),
        HeirloomError::NotParticipant
    );
    let ts = now()?;
    require!(!seat.succession_pending() || seat.report_stale(estate, &reporter, ts), HeirloomError::SuccessionPending);
    void_objection(&ctx.accounts.objection.to_account_info())?;

    seat.death_cert_hash = cert_hash;
    seat.death_reported_by = reporter;
    seat.death_verdict = Verdict::Pending;
    seat.death_confirmed_by = Pubkey::default();
    seat.death_pending_since = ts;

    emit!(SeatDeathReported {
        estate: seat.estate,
        seat_index: seat.index,
        holder: seat.holder,
        reported_by: reporter,
        cert_hash,
        ts,
    });
    Ok(())
}

// ====================================================================== review_seat_death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ReviewSeatDeath<'info> {
    pub agent: Signer<'info>,

    #[account(has_one = agent @ HeirloomError::NotAgent)]
    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn review_seat_death_handler(
    ctx: Context<ReviewSeatDeath>,
    _index: u8,
    approve: bool,
    report_hash: [u8; 32],
    cert_hash: [u8; 32],
    holder: Pubkey,
) -> Result<()> {
    let seat = &mut ctx.accounts.seat;
    require!(seat.succession_pending(), HeirloomError::NoSuccessionPending);
    require!(seat.death_verdict == Verdict::Pending, HeirloomError::BadStatus);
    // The certificate and the person it was read for (L6): the same public hash can be reported for another holder.
    require!(seat.death_cert_hash == cert_hash && seat.holder == holder, HeirloomError::ReportChanged);
    require!(seat.death_reported_by != ctx.accounts.estate.agent, HeirloomError::OwnApproval);

    if approve {
        seat.death_verdict = Verdict::Approved;
    } else {
        seat.clear_succession();
    }

    emit!(SeatDeathReviewed {
        estate: seat.estate,
        seat_index: seat.index,
        approved: approve,
        report_hash,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== confirm_seat_death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ConfirmSeatDeath<'info> {
    /// Holder of another seat (a first backup too, once they hold one). If no other seat has a living holder, or
    /// the approved report has waited the recovery timeout: backups[1] or a monitor of this seat. An active
    /// beneficiary when nobody watches the seat and no other is held, or after the recovery timeout.
    pub confirmer: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,

    /// The confirmer's Beneficiary PDA when a beneficiary confirms; otherwise None.
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,
}

pub fn confirm_seat_death_handler(ctx: Context<ConfirmSeatDeath>, _index: u8) -> Result<()> {
    let confirmer = ctx.accounts.confirmer.key();
    let estate = &ctx.accounts.estate;
    let seat = &mut ctx.accounts.seat;

    require!(seat.succession_pending(), HeirloomError::NoSuccessionPending);
    require!(seat.death_verdict == Verdict::Approved, HeirloomError::AgentNotApproved);
    require!(!is_set(&seat.death_confirmed_by), HeirloomError::AlreadyApproved);
    let holds_a_seat = estate.verifier_index(&confirmer).is_some();
    // Nobody confirms a death they reported, their own death, or their own promotion (a first backup who already
    // holds another seat can't be promoted, H2); the agent only reviews.
    require!(
        confirmer != seat.death_reported_by
            && confirmer != seat.holder
            && (confirmer != seat.backups[0] || holds_a_seat)
            && confirmer != estate.agent,
        HeirloomError::NotConfirmer
    );

    let ts = now()?;
    let alone = estate.living_seats_except(&seat.holder) == 0;
    // An approved report nobody confirmed for the recovery timeout opens the route to those who watch the seat
    // and to beneficiaries (H3): trusted people who could have confirmed may all be dead too.
    let timed_out = ts >= seat.death_pending_since.saturating_add(estate.recovery_timeout());
    let watches = (is_set(&seat.backups[1]) && confirmer == seat.backups[1]) || seat.is_monitor(&confirmer);
    let beneficiary =
        is_active_beneficiary(&estate.key(), &confirmer, ctx.accounts.beneficiary_account.as_deref().map(|b| &**b));
    let allowed = holds_a_seat
        || ((alone || timed_out) && watches)
        || (beneficiary && (timed_out || beneficiary_may_confirm(estate, seat)));
    require!(allowed, HeirloomError::NotConfirmer);

    seat.death_confirmed_by = confirmer;
    seat.death_pending_since = ts;

    emit!(SeatDeathConfirmed {
        estate: seat.estate,
        seat_index: seat.index,
        confirmed_by: confirmer,
        ts,
    });
    Ok(())
}

// ====================================================================== veto_seat_death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct VetoSeatDeath<'info> {
    /// The seat holder: "I'm still here".
    pub holder: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,
}

pub fn veto_seat_death_handler(ctx: Context<VetoSeatDeath>, _index: u8) -> Result<()> {
    let holder = ctx.accounts.holder.key();
    let seat = &mut ctx.accounts.seat;
    require!(is_set(&seat.holder) && holder == seat.holder, HeirloomError::NotVerifier);
    require!(seat.succession_pending(), HeirloomError::NoSuccessionPending);

    seat.clear_succession();

    emit!(SeatDeathVetoed {
        estate: seat.estate,
        seat_index: seat.index,
        holder,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== finalize_succession

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct FinalizeSuccession<'info> {
    #[account(mut)]
    pub estate: Box<Account<'info, Estate>>,

    #[account(
        seeds = [GUARD_SEED, estate.key().as_ref()],
        bump = guard.bump,
        has_one = estate
    )]
    pub guard: Box<Account<'info, Guard>>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Box<Account<'info, Seat>>,

    /// CHECK: the ["objection", seat] PDA; may not exist. Blocks while Open.
    #[account(seeds = [OBJECTION_SEED, seat.key().as_ref()], bump)]
    pub objection: UncheckedAccount<'info>,

    /// Anyone (any wallet). A signer, so the call can be fee-sponsored (the sponsor is only the fee payer).
    pub caller: Signer<'info>,
}

pub fn finalize_succession_handler(ctx: Context<FinalizeSuccession>, _index: u8) -> Result<()> {
    let wait = ctx.accounts.guard.succession_wait();
    let objection_open = objection_is_open(&ctx.accounts.objection.to_account_info(), &ctx.accounts.estate)?;
    let estate = &mut ctx.accounts.estate;
    let seat = &mut ctx.accounts.seat;
    let idx = seat.index as usize;

    require!(seat.succession_pending(), HeirloomError::NoSuccessionPending);
    require!(seat.death_verdict == Verdict::Approved, HeirloomError::AgentNotApproved);
    require!(is_set(&seat.death_confirmed_by), HeirloomError::NotConfirmer);
    let ts = now()?;
    let ready_at = seat
        .death_pending_since
        .checked_add(wait)
        .ok_or(HeirloomError::MathOverflow)?;
    require!(ts >= ready_at, HeirloomError::WaitingPeriodNotOver);
    require!(!objection_open, HeirloomError::ObjectionOpen);

    // Whoever reported or confirmed it has since become the agent: it reviewed its own report, so it is cleared.
    // (The owner's changes that revoke a confirmation clear it when they are made, L15.)
    if seat.death_confirmed_by == estate.agent || seat.death_reported_by == estate.agent {
        seat.clear_succession();
        emit!(SeatDeathReportCleared { estate: seat.estate, seat_index: seat.index, ts });
        return Ok(());
    }

    // First backup that is still eligible: not the owner, the agent or already a holder, and not the
    // person who reported or confirmed this death (nobody promotes themselves).
    let mut conflicted: Option<usize> = None;
    let mut chosen: Option<usize> = None;
    for (i, b) in seat.backups.iter().enumerate() {
        if !is_set(b) || *b == estate.owner || *b == estate.agent || estate.verifier_index(b).is_some() {
            continue;
        }
        if *b == seat.death_confirmed_by || *b == seat.death_reported_by {
            conflicted = conflicted.or(Some(i));
            continue;
        }
        chosen = Some(i);
        break;
    }
    if chosen.is_none() {
        if let Some(i) = conflicted {
            if beneficiary_may_confirm(estate, seat) {
                // Nobody else could report or confirm (one backup, one beneficiary, nobody watching): after the
                // recovery timeout the backup who reported takes the seat rather than the report clearing for ever.
                let ready = seat.death_pending_since.saturating_add(estate.recovery_timeout());
                require!(ts >= ready, HeirloomError::WaitingPeriodNotOver);
                chosen = Some(i);
            } else {
                // Only held back by this report: clear it, so someone else can report and the backup can take the seat.
                seat.clear_succession();
                emit!(SeatDeathReportCleared { estate: seat.estate, seat_index: seat.index, ts });
                return Ok(());
            }
        }
    }

    let previous_holder = seat.holder;
    seat.generation = seat.generation.checked_add(1).ok_or(HeirloomError::MathOverflow)?;
    match chosen {
        Some(i) => {
            let new_holder = seat.backups[i];
            seat.holder = new_holder;
            // The other backup stays, also one who reported this death (L10).
            seat.backups = without(seat.backups, &new_holder);
            seat.monitors = without(seat.monitors, &new_holder);
            seat.vacant = false;
        }
        None => {
            // Every backup is the owner, the agent or the holder of another seat.
            seat.holder = Pubkey::default();
            seat.backups = [Pubkey::default(); 2];
            seat.vacant = true;
        }
    }
    seat.clear_succession();
    estate.verifiers[idx] = seat.holder;

    if seat.vacant {
        emit!(SeatVacated {
            estate: seat.estate,
            seat_index: seat.index,
            previous_holder,
            generation: seat.generation,
            ts,
        });
    } else {
        emit!(SuccessionFinalized {
            estate: seat.estate,
            seat_index: seat.index,
            previous_holder,
            new_holder: seat.holder,
            generation: seat.generation,
            ts,
        });
    }
    Ok(())
}

// ====================================================================== owner_replace_seat

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct OwnerReplaceSeat<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(
        mut,
        seeds = [SEAT_SEED, estate.key().as_ref(), &[index]],
        bump = seat.bump,
        has_one = estate
    )]
    pub seat: Account<'info, Seat>,

    /// CHECK: the Seat PDA at (index + 1) % 3; may not exist. Its confirmation by someone who holds no seat gives
    /// way (the owner just made a living trusted person available).
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[(index + 1) % 3]], bump)]
    pub next_seat: UncheckedAccount<'info>,

    /// CHECK: the Seat PDA at (index + 2) % 3; may not exist. As next_seat.
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[(index + 2) % 3]], bump)]
    pub last_seat: UncheckedAccount<'info>,
}

pub fn owner_replace_seat_handler(ctx: Context<OwnerReplaceSeat>, _index: u8, new_holder: Pubkey) -> Result<()> {
    let estate = &mut ctx.accounts.estate;
    let seat = &mut ctx.accounts.seat;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    require!(
        is_set(&new_holder) && new_holder != estate.owner && estate.verifier_index(&new_holder).is_none(),
        HeirloomError::DuplicateVerifier
    );
    require!(new_holder != estate.agent, HeirloomError::BadAgent);

    seat.holder = new_holder;
    seat.backups = without(seat.backups, &new_holder);
    seat.monitors = without(seat.monitors, &new_holder);
    seat.vacant = false;
    seat.generation = seat.generation.checked_add(1).ok_or(HeirloomError::MathOverflow)?;
    seat.clear_succession();
    estate.verifiers[seat.index as usize] = new_holder;
    // Only the living owner can do this, and it revokes what the replaced person attested.
    record_proof_of_life(estate.key(), estate, now()?);
    release_confirmations(
        estate,
        &[ctx.accounts.next_seat.to_account_info(), ctx.accounts.last_seat.to_account_info()],
        None,
    )?;
    emit_seat_configured(seat)
}

// ====================================================================== raise_objection

#[derive(Accounts)]
#[instruction(kind: TargetKind, target: Pubkey)]
pub struct RaiseObjection<'info> {
    /// A monitor (of `seat`), or for Fallback also an active beneficiary. Pays rent.
    #[account(mut)]
    pub objector: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    #[account(
        mut,
        seeds = [GUARD_SEED, estate.key().as_ref()],
        bump = guard.bump,
        has_one = estate
    )]
    pub guard: Box<Account<'info, Guard>>,

    /// The seat the objector monitors (required unless a beneficiary objects to the fallback).
    pub seat: Option<Box<Account<'info, Seat>>>,

    /// The objector's Beneficiary PDA (Fallback objections by a beneficiary only).
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,

    /// CHECK: the target account (Claim, Asset or Hardship); read and checked in the handler.
    /// Pass None for Unlock (target = estate), Succession (target = seat) and Fallback (target = guard).
    #[account(address = target)]
    pub target_account: Option<UncheckedAccount<'info>>,

    /// The hardship's Asset (Hardship objections only).
    pub asset: Option<Box<Account<'info, Asset>>>,

    #[account(
        init_if_needed,
        payer = objector,
        space = 8 + Objection::INIT_SPACE,
        seeds = [OBJECTION_SEED, target.as_ref()],
        bump
    )]
    pub objection: Box<Account<'info, Objection>>,

    pub system_program: Program<'info, System>,
}

pub fn raise_objection_handler(
    ctx: Context<RaiseObjection>,
    kind: TargetKind,
    target: Pubkey,
    seat_index: u8,
    reason_hash: [u8; 32],
) -> Result<()> {
    let objector = ctx.accounts.objector.key();
    let estate = &ctx.accounts.estate;
    let estate_key = estate.key();
    let guard_key = ctx.accounts.guard.key();

    // ---- who may object
    let seat = ctx.accounts.seat.as_ref();
    let seat_monitor = seat
        .map(|s| s.estate == estate_key && s.is_monitor(&objector))
        .unwrap_or(false);
    let stored_seat_index = match kind {
        TargetKind::Claim | TargetKind::Sale | TargetKind::Hardship | TargetKind::Succession => {
            require!(seat_monitor, HeirloomError::NotMonitor);
            require!(seat.unwrap().index == seat_index, HeirloomError::NotMonitor);
            seat_index
        }
        TargetKind::Unlock => {
            require!(seat_monitor, HeirloomError::NotMonitor);
            NO_SEAT
        }
        TargetKind::Fallback => {
            let beneficiary = ctx
                .accounts
                .beneficiary_account
                .as_ref()
                .map(|b| b.estate == estate_key && b.wallet == objector && b.active)
                .unwrap_or(false);
            require!(seat_monitor || beneficiary, HeirloomError::NotMonitor);
            NO_SEAT
        }
    };

    // ---- what may be objected to
    let target_info = ctx.accounts.target_account.as_ref().map(|a| a.to_account_info());
    match kind {
        TargetKind::Claim => {
            let info = target_info.clone().ok_or(HeirloomError::BadStatus)?;
            let claim: Claim = read_account(&info)?;
            require!(claim.estate == estate_key, HeirloomError::BadStatus);
            require!(claim.status == ClaimStatus::Open, HeirloomError::BadStatus);
            // Monitors object to approvals made by the holder they watch.
            require!(claim.approvals & (1u8 << seat_index) != 0, HeirloomError::BadStatus);
        }
        TargetKind::Unlock => {
            require_keys_eq!(target, estate_key, HeirloomError::BadStatus);
            require!(
                estate.status == EstateStatus::DeathPending
                    || (estate.status == EstateStatus::Active && estate.death_cert_hash != [0u8; 32]),
                HeirloomError::BadStatus
            );
        }
        TargetKind::Sale => {
            let info = target_info.clone().ok_or(HeirloomError::BadStatus)?;
            let asset: Asset = read_account(&info)?;
            require!(asset.estate == estate_key, HeirloomError::BadStatus);
            require!(asset.status == AssetStatus::Listed, HeirloomError::BadStatus);
        }
        TargetKind::Hardship => {
            let info = target_info.clone().ok_or(HeirloomError::BadStatus)?;
            let hardship: Hardship = read_account(&info)?;
            let asset = ctx.accounts.asset.as_ref().ok_or(HeirloomError::BadStatus)?;
            require_keys_eq!(asset.key(), hardship.asset, HeirloomError::BadStatus);
            require!(asset.estate == estate_key, HeirloomError::BadStatus);
            require!(asset.status != AssetStatus::Sold, HeirloomError::BadStatus);
            require!(
                hardship.status == HardshipStatus::Open || hardship.status == HardshipStatus::Approved,
                HeirloomError::BadStatus
            );
            require!(hardship.approvals & (1u8 << seat_index) != 0, HeirloomError::BadStatus);
        }
        TargetKind::Succession => {
            let s = seat.unwrap();
            require_keys_eq!(target, s.key(), HeirloomError::BadStatus);
            require!(s.succession_pending(), HeirloomError::NoSuccessionPending);
        }
        TargetKind::Fallback => {
            require_keys_eq!(target, guard_key, HeirloomError::BadStatus);
            let g = &ctx.accounts.guard;
            require!(!g.fallback_done, HeirloomError::FallbackDone);
            require!(countdown_valid(estate, g), HeirloomError::FallbackNotReady);
        }
    }

    // Otherwise whoever gains could use up the one objection and shut the others out.
    require!(
        objector != interested_party(kind, estate, &ctx.accounts.guard, target_info.as_ref())?,
        HeirloomError::OwnClaimDispute
    );

    // ---- one objection per target at a time; a resolved one may be re-raised (overwritten),
    // except a dismissed objection on a one-off claim or hardship.
    let ts = now()?;
    let objection = &mut ctx.accounts.objection;
    // A sale objection that was upheld keeps cutting off older offers after this one (P5); the flag carries on.
    let keep_cutoff = is_set(&objection.target) && kind == TargetKind::Sale && objection.sale_cutoff().is_some();
    if is_set(&objection.target) {
        let open = if kind == TargetKind::Fallback {
            objection.status == ObjectionStatus::Open
                && !fallback_objection_lapsed(objection, estate, &ctx.accounts.guard, ts)?
        } else {
            objection.is_effectively_open(estate, ts)
        };
        // Monitors may take over an unlock's dispute: one trusted person's dispute must not shut them out of the
        // whole wait (M3).
        require!(!open || (kind == TargetKind::Unlock && objection.is_dispute()), HeirloomError::ObjectionOpen);
        // Still Open here means it lapsed, which counts as dismissed.
        let was_dispute = objection.is_dispute();
        let prev = if objection.status == ObjectionStatus::Open {
            if !was_dispute {
                let guard = &mut ctx.accounts.guard;
                guard.open_objections = guard.open_objections.saturating_sub(1);
            }
            ObjectionStatus::Dismissed
        } else {
            objection.status
        };
        // A finished dispute never uses up the monitors' objection. A monitors' objection that was dismissed
        // does: once per claim, hardship and waiting period; with a cooldown for sales and successions.
        if prev == ObjectionStatus::Dismissed && !was_dispute {
            match kind {
                // One dismissed before this death challenged approvals that no longer count.
                TargetKind::Claim => require!(
                    estate.status == EstateStatus::Unlocked && objection.raised_at < estate.death_pending_since,
                    HeirloomError::BadStatus
                ),
                TargetKind::Hardship => return err!(HeirloomError::BadStatus),
                TargetKind::Unlock => require!(
                    objection.raised_at < estate.death_pending_since,
                    HeirloomError::BadStatus
                ),
                TargetKind::Sale | TargetKind::Succession => require!(
                    ts >= objection.reraise_at(estate),
                    HeirloomError::ObjectionCooldown
                ),
                TargetKind::Fallback => {}
            }
        }
        // One fallback objection per countdown: a dismissed or lapsed one can't be re-raised until the
        // countdown restarts (upheld objection, new recipient), or objections could delay it forever.
        require!(
            !(kind == TargetKind::Fallback
                && prev == ObjectionStatus::Dismissed
                && objection.raised_at >= ctx.accounts.guard.fallback_started_at),
            HeirloomError::BadStatus
        );
    }

    let bump = ctx.bumps.objection;
    objection.set_inner(Objection {
        estate: estate_key,
        target,
        kind,
        monitor: objector,
        seat_index: stored_seat_index,
        reason_hash,
        raised_at: ts,
        status: ObjectionStatus::Open,
        votes_uphold: if keep_cutoff { SALE_CUTOFF_KEPT } else { 0 },
        votes_dismiss: 0,
        bump,
    });
    let guard = &mut ctx.accounts.guard;
    guard.open_objections = guard
        .open_objections
        .checked_add(1)
        .ok_or(HeirloomError::MathOverflow)?;

    emit!(ObjectionRaised {
        estate: estate_key,
        objection: ctx.accounts.objection.key(),
        target,
        kind,
        monitor: objector,
        seat_index: stored_seat_index,
        reason_hash,
        ts,
    });
    Ok(())
}

// ====================================================================== vote_objection

#[derive(Accounts)]
pub struct VoteObjection<'info> {
    /// A seat holder other than the watched holder and the objector, or the owner while Active
    /// (decides alone). Fallback objections: a monitor other than the objector (one vote, however many seats
    /// they watch).
    pub voter: Signer<'info>,

    #[account(mut)]
    pub estate: Box<Account<'info, Estate>>,

    #[account(
        mut,
        seeds = [GUARD_SEED, estate.key().as_ref()],
        bump = guard.bump,
        has_one = estate
    )]
    pub guard: Box<Account<'info, Guard>>,

    #[account(
        mut,
        seeds = [OBJECTION_SEED, objection.target.as_ref()],
        bump = objection.bump,
        has_one = estate
    )]
    pub objection: Box<Account<'info, Objection>>,

    /// CHECK: == objection.target. Needed (writable) for Claim, Sale, Hardship and Succession;
    /// None for Unlock (the estate) and Fallback (the guard).
    #[account(mut, address = objection.target)]
    pub target_account: Option<UncheckedAccount<'info>>,

    /// The hardship's Asset (Hardship objections only; its hardship floor is withdrawn if upheld). Refused for
    /// any other kind, so it can't be the target passed twice and overwrite what was written (H1).
    #[account(mut)]
    pub asset: Option<Box<Account<'info, Asset>>>,
    // remaining_accounts (Fallback votes by a monitor): the three Seat PDAs, in index order.
}

/// Bitmap of every position (2i + j) at which `who` monitors. All three seats are needed, so that one wallet
/// watching several seats still has one vote.
fn monitor_positions(infos: &[AccountInfo], estate: &Pubkey, who: &Pubkey) -> Result<u8> {
    require!(infos.len() == VERIFIER_COUNT, HeirloomError::NotMonitor);
    let mut positions = 0u8;
    for (i, info) in infos.iter().enumerate() {
        let seat: Seat = read_account(info)?;
        let expected = Pubkey::create_program_address(&[SEAT_SEED, estate.as_ref(), &[i as u8], &[seat.bump]], &crate::ID)
            .map_err(|_| error!(HeirloomError::BadStatus))?;
        require_keys_eq!(info.key(), expected, HeirloomError::BadStatus);
        for (j, monitor) in seat.monitors.iter().enumerate() {
            if is_set(monitor) && monitor == who {
                positions |= 1u8 << (i * 2 + j);
            }
        }
    }
    Ok(positions)
}

pub fn vote_objection_handler<'info>(ctx: Context<'info, VoteObjection<'info>>, uphold: bool) -> Result<()> {
    let voter = ctx.accounts.voter.key();
    let estate_key = ctx.accounts.estate.key();
    let objection = &mut ctx.accounts.objection;
    require!(objection.status == ObjectionStatus::Open, HeirloomError::BadStatus);
    // Disputes are resolved by the verifiers with resolve_dispute.
    require!(!objection.is_dispute(), HeirloomError::BadStatus);
    let kind = objection.kind;
    require!(kind == TargetKind::Hardship || ctx.accounts.asset.is_none(), HeirloomError::BadStatus);
    require!(
        !fallback_objection_lapsed(objection, &ctx.accounts.estate, &ctx.accounts.guard, now()?)?,
        HeirloomError::ObjectionLapsed
    );

    require!(
        kind == TargetKind::Fallback || objection.is_effectively_open(&ctx.accounts.estate, now()?),
        HeirloomError::ObjectionLapsed
    );
    let estate = &ctx.accounts.estate;
    // The living owner decides alone, and that is proof of life (M1).
    let owner_decides = voter == estate.owner && estate.status != EstateStatus::Unlocked;
    let decision: Option<bool> = if owner_decides {
        Some(uphold)
    } else {
        require!(voter != objection.monitor, HeirloomError::NotVerifier);
        // `bit` is recorded; a vote at any of the voter's `positions` means they have voted.
        let (bit, positions) = if kind == TargetKind::Fallback {
            let positions = monitor_positions(ctx.remaining_accounts, &estate_key, &voter)?;
            require!(positions != 0, HeirloomError::NotMonitor);
            (1u8 << positions.trailing_zeros(), positions)
        } else {
            let idx = estate.verifier_index(&voter).ok_or(HeirloomError::NotVerifier)?;
            require!(objection.seat_index as usize != idx, HeirloomError::NotVerifier);
            (1u8 << idx, 1u8 << idx)
        };
        require!(
            (objection.votes_uphold | objection.votes_dismiss) & positions == 0,
            HeirloomError::AlreadyApproved
        );
        if uphold {
            objection.votes_uphold |= bit;
        } else {
            let info = ctx.accounts.target_account.as_ref().map(|a| a.to_account_info());
            require!(
                voter != interested_party(kind, estate, &ctx.accounts.guard, info.as_ref())?,
                HeirloomError::OwnApproval
            );
            objection.votes_dismiss |= bit;
        }
        // Monitors' bits are positions, not seats: the holders are all gone by then.
        let voting = if kind == TargetKind::Fallback { u8::MAX } else { estate.living_seats_except(&Pubkey::default()) };
        if count_bits(objection.votes_uphold & voting) >= 2 {
            Some(true)
        } else if count_bits(objection.votes_dismiss & voting) >= 2 {
            Some(false)
        } else {
            None
        }
    };

    let ts = now()?;
    let objection_key = objection.key();
    let target = objection.target;
    emit!(ObjectionVoted {
        objection: objection_key,
        voter,
        uphold,
        ts,
    });

    let Some(upheld) = decision else {
        return Ok(());
    };
    objection.status = if upheld {
        ObjectionStatus::Upheld
    } else {
        ObjectionStatus::Dismissed
    };
    // From now on raised_at is when it was resolved: offers older than an upheld sale objection can't be
    // accepted (M8), and the cooldown runs from the decision.
    objection.raised_at = ts;
    let guard = &mut ctx.accounts.guard;
    guard.open_objections = guard.open_objections.saturating_sub(1);

    if upheld {
        let target_info = ctx.accounts.target_account.as_ref().map(|a| a.to_account_info());
        match kind {
            TargetKind::Claim => uphold_on_claim(&target_info.ok_or(HeirloomError::BadStatus)?)?,
            TargetKind::Unlock => uphold_on_unlock(&mut ctx.accounts.estate),
            TargetKind::Sale => {
                // The listing is cancelled; offers can only be accepted after a fresh list_asset.
                let info = target_info.ok_or(HeirloomError::BadStatus)?;
                let mut asset: Asset = read_account(&info)?;
                if asset.status == AssetStatus::Listed {
                    asset.status = AssetStatus::Held;
                    write_account(&info, &asset)?;
                }
            }
            TargetKind::Hardship => {
                let info = target_info.ok_or(HeirloomError::BadStatus)?;
                let mut hardship: Hardship = read_account(&info)?;
                let asset = ctx.accounts.asset.as_mut().ok_or(HeirloomError::BadStatus)?;
                require_keys_eq!(asset.key(), hardship.asset, HeirloomError::BadStatus);
                if asset.hardship_beneficiary == Some(hardship.beneficiary) {
                    asset.hardship_beneficiary = None;
                }
                hardship.status = HardshipStatus::Rejected;
                write_account(&info, &hardship)?;
            }
            TargetKind::Succession => {
                let info = target_info.ok_or(HeirloomError::BadStatus)?;
                let mut seat: Seat = read_account(&info)?;
                seat.clear_succession();
                write_account(&info, &seat)?;
            }
            TargetKind::Fallback => {
                guard.fallback_started_at = 0;
            }
        }
    }
    if owner_decides {
        let key = ctx.accounts.estate.key();
        record_proof_of_life(key, &mut ctx.accounts.estate, ts);
    }

    emit!(ObjectionResolved {
        estate: estate_key,
        objection: objection_key,
        target,
        kind,
        upheld,
        ts,
    });
    Ok(())
}

// ====================================================================== set_asset_media

#[derive(Accounts)]
pub struct SetAssetMedia<'info> {
    /// The owner, estate Active. Pays rent the first time.
    #[account(mut)]
    pub authority: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(has_one = estate)]
    pub asset: Account<'info, Asset>,

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + AssetMedia::INIT_SPACE,
        seeds = [MEDIA_SEED, asset.key().as_ref()],
        bump
    )]
    pub media: Account<'info, AssetMedia>,

    pub system_program: Program<'info, System>,
}

pub fn set_asset_media_handler(
    ctx: Context<SetAssetMedia>,
    kind: AssetKind,
    photos_root: [u8; 32],
    photo_count: u8,
) -> Result<()> {
    let authority = ctx.accounts.authority.key();
    let estate = &ctx.accounts.estate;
    // Only the living owner decides what buyers see.
    require!(authority == estate.owner && estate.status == EstateStatus::Active, HeirloomError::NotOwner);
    require!(photo_count <= MAX_PHOTOS, HeirloomError::InvalidAmount);

    let ts = now()?;
    let asset = ctx.accounts.asset.key();
    let bump = ctx.bumps.media;
    ctx.accounts.media.set_inner(AssetMedia {
        asset,
        kind,
        photos_root,
        photo_count,
        updated_at: ts,
        bump,
    });

    emit!(AssetMediaSet {
        asset,
        kind,
        photos_root,
        photo_count,
        ts,
    });
    Ok(())
}

// ====================================================================== report / review fallback death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ReportFallbackDeath<'info> {
    /// A living trusted person, monitor, active beneficiary or listed recipient. Pays the report's rent.
    #[account(mut)]
    pub reporter: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    #[account(seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Box<Account<'info, Guard>>,

    #[account(
        init_if_needed,
        payer = reporter,
        space = 8 + FallbackReport::INIT_SPACE,
        seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[index]],
        bump
    )]
    pub fallback_report: Box<Account<'info, FallbackReport>>,

    /// A seat the reporter monitors; otherwise None.
    pub signer_seat: Option<Box<Account<'info, Seat>>>,

    /// The reporter's Beneficiary PDA; otherwise None.
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,

    pub system_program: Program<'info, System>,
}

pub fn report_fallback_death_handler(
    ctx: Context<ReportFallbackDeath>,
    index: u8,
    cert_hash: [u8; 32],
) -> Result<()> {
    let reporter = ctx.accounts.reporter.key();
    let estate = &ctx.accounts.estate;
    let guard = &ctx.accounts.guard;
    let i = index as usize;
    require!(i < FALLBACK_COUNT, HeirloomError::InvalidAmount);
    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    let recipient = guard.fallback[i];
    require!(is_set(&recipient), HeirloomError::NoFallbackRecipient);
    require!(guard.is_living_recipient(i), HeirloomError::BadStatus);
    require!(cert_hash != [0u8; 32], HeirloomError::NoDeathClaim);
    let seat = ctx.accounts.signer_seat.as_deref().map(|s| &**s);
    let beneficiary = ctx.accounts.beneficiary_account.as_deref().map(|b| &**b);
    require!(
        reporter != recipient && is_fallback_participant(estate, guard, &reporter, seat, beneficiary),
        HeirloomError::NotParticipant
    );

    let ts = now()?;
    let report = &mut ctx.accounts.fallback_report;
    if !is_set(&report.estate) {
        report.estate = estate.key();
        report.index = index;
        report.rent_payer = reporter;
        report.bump = ctx.bumps.fallback_report;
    } else if report.recipient == recipient {
        let hold = guard.refute_wait().saturating_mul(2);
        require!(
            // An unreviewed report keeps its place for at most half the refute wait, so a junk one can't outlast a
            // countdown (L12).
            estate.report_replaceable(
                report.verdict,
                report.reported_at,
                &report.reporter,
                &reporter,
                estate.report_grace().min(guard.refute_wait() / 2),
                hold,
                ts
            ),
            HeirloomError::BadStatus
        );
    }
    report.recipient = recipient;
    report.reporter = reporter;
    report.cert_hash = cert_hash;
    report.verdict = Verdict::Pending;
    report.reported_at = ts;

    emit!(FallbackDeathReported {
        estate: guard.estate,
        index,
        recipient,
        reported_by: reporter,
        cert_hash,
        ts,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ReviewFallbackDeath<'info> {
    pub agent: Signer<'info>,

    #[account(has_one = agent @ HeirloomError::NotAgent)]
    pub estate: Account<'info, Estate>,

    #[account(seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Account<'info, Guard>,

    #[account(
        mut,
        seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[index]],
        bump = fallback_report.bump,
        has_one = estate
    )]
    pub fallback_report: Account<'info, FallbackReport>,

    /// CHECK: == fallback_report.rent_payer; gets the rent back if the report is rejected.
    #[account(mut, address = fallback_report.rent_payer)]
    pub rent_to: UncheckedAccount<'info>,
}

/// The agent only sets the report's verdict; a rejection closes it.
pub fn review_fallback_death_handler(
    ctx: Context<ReviewFallbackDeath>,
    index: u8,
    approve: bool,
    report_hash: [u8; 32],
    cert_hash: [u8; 32],
    recipient: Pubkey,
) -> Result<()> {
    let guard = &ctx.accounts.guard;
    let i = index as usize;
    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    require!(guard.is_living_recipient(i), HeirloomError::BadStatus);
    let report = &mut ctx.accounts.fallback_report;
    require!(report.recipient == guard.fallback[i], HeirloomError::NoFallbackRecipient);
    require!(report.verdict == Verdict::Pending, HeirloomError::BadStatus);
    require!(report.cert_hash == cert_hash && report.recipient == recipient, HeirloomError::ReportChanged);
    require!(report.reporter != ctx.accounts.estate.agent, HeirloomError::OwnApproval);

    if approve {
        report.verdict = Verdict::Approved;
    } else {
        close_program_account(&report.to_account_info(), &ctx.accounts.rent_to.to_account_info())?;
    }

    emit!(FallbackDeathReviewed {
        estate: guard.estate,
        index,
        approved: approve,
        report_hash,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== resolve_fallback_death

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct ResolveFallbackDeath<'info> {
    /// `dead`: a second participant. Otherwise the reported recipient ("I'm alive").
    pub signer: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    #[account(mut, seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Box<Account<'info, Guard>>,

    #[account(
        mut,
        seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[index]],
        bump = fallback_report.bump,
        has_one = estate
    )]
    pub fallback_report: Box<Account<'info, FallbackReport>>,

    /// CHECK: == fallback_report.rent_payer; gets the report's rent back.
    #[account(mut, address = fallback_report.rent_payer)]
    pub rent_to: UncheckedAccount<'info>,

    /// A seat the signer monitors; otherwise None.
    pub signer_seat: Option<Box<Account<'info, Seat>>>,

    /// The signer's Beneficiary PDA; otherwise None.
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,
}

/// `dead`: a second person confirms, after the fallback wait from the report. Otherwise the recipient refutes,
/// at any time before that. Either way the report closes.
pub fn resolve_fallback_death_handler(ctx: Context<ResolveFallbackDeath>, index: u8, dead: bool) -> Result<()> {
    let signer = ctx.accounts.signer.key();
    let estate = &ctx.accounts.estate;
    let report = &ctx.accounts.fallback_report;
    let guard = &mut ctx.accounts.guard;
    let (estate_key, recipient, ts) = (estate.key(), report.recipient, now()?);

    if !dead {
        require!(signer == recipient, HeirloomError::NotParticipant);
        close_program_account(&report.to_account_info(), &ctx.accounts.rent_to.to_account_info())?;
        emit!(FallbackDeathRefuted { estate: estate_key, index, recipient, ts });
        return Ok(());
    }

    let i = index as usize;
    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    require!(guard.is_living_recipient(i), HeirloomError::BadStatus);
    require!(recipient == guard.fallback[i], HeirloomError::NoFallbackRecipient);
    require!(report.verdict == Verdict::Approved, HeirloomError::AgentNotApproved);
    let would_gain = guard.living_recipient_from(i + 1).map(|n| guard.fallback[n]).unwrap_or_default();
    let seat = ctx.accounts.signer_seat.as_deref().map(|s| &**s);
    let beneficiary = ctx.accounts.beneficiary_account.as_deref().map(|b| &**b);
    require!(
        signer != recipient
            && signer != report.reporter
            && signer != would_gain
            && is_fallback_participant(estate, guard, &signer, seat, beneficiary),
        HeirloomError::NotConfirmer
    );
    let confirmable_at = report.reported_at.saturating_add(guard.refute_wait());
    require!(ts >= confirmable_at, HeirloomError::WaitingPeriodNotOver);

    let running = countdown_valid(estate, guard);
    guard.fallback_dead |= 1u8 << i;
    // The recipient changed: restart a running countdown so family can object to the new one.
    if running {
        guard.fallback_started_at = ts;
    }
    close_program_account(&report.to_account_info(), &ctx.accounts.rent_to.to_account_info())?;

    emit!(FallbackDeathConfirmed { estate: estate_key, index, recipient, confirmed_by: signer, ts });
    Ok(())
}

// ====================================================================== start_fallback / execute_fallback

fn all_vacant(seats: [&Seat; 3]) -> bool {
    seats.iter().all(|s| s.vacant && !is_set(&s.holder))
}

#[derive(Accounts)]
pub struct StartFallback<'info> {
    pub estate: Box<Account<'info, Estate>>,

    #[account(mut, seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Box<Account<'info, Guard>>,

    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[0u8]], bump = seat0.bump)]
    pub seat0: Box<Account<'info, Seat>>,
    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[1u8]], bump = seat1.bump)]
    pub seat1: Box<Account<'info, Seat>>,
    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[2u8]], bump = seat2.bump)]
    pub seat2: Box<Account<'info, Seat>>,

    /// Anyone (any wallet). A signer, so the call can be fee-sponsored (the sponsor is only the fee payer).
    pub caller: Signer<'info>,
}

pub fn start_fallback_handler(ctx: Context<StartFallback>) -> Result<()> {
    let estate = &ctx.accounts.estate;
    let guard = &mut ctx.accounts.guard;
    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    // Not started, or a start the owner has since disproved, or one made for an earlier death claim.
    require!(!countdown_valid(estate, guard), HeirloomError::BadStatus);
    require!(
        all_vacant([&ctx.accounts.seat0, &ctx.accounts.seat1, &ctx.accounts.seat2]),
        HeirloomError::SeatsNotVacant
    );
    require!(owner_death_established(estate), HeirloomError::FallbackNotReady);
    require!(
        is_set(&guard.next_fallback_recipient()),
        HeirloomError::NoFallbackRecipient
    );

    let ts = now()?;
    guard.fallback_started_at = ts;
    let runs_at = fallback_runs_at(estate, guard);

    emit!(FallbackStarted {
        estate: estate.key(),
        runs_at,
        ts,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteFallback<'info> {
    /// Anyone; pays the recipient's ATA rent if missing.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub estate: Box<Account<'info, Estate>>,

    #[account(mut, seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Box<Account<'info, Guard>>,

    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[0u8]], bump = seat0.bump)]
    pub seat0: Box<Account<'info, Seat>>,
    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[1u8]], bump = seat1.bump)]
    pub seat1: Box<Account<'info, Seat>>,
    #[account(seeds = [SEAT_SEED, estate.key().as_ref(), &[2u8]], bump = seat2.bump)]
    pub seat2: Box<Account<'info, Seat>>,

    /// CHECK: the ["objection", guard] PDA; may not exist. Blocks while Open, unless it has lapsed
    /// (then it is marked Dismissed here, so it is writable).
    #[account(mut, seeds = [OBJECTION_SEED, guard.key().as_ref()], bump)]
    pub objection: UncheckedAccount<'info>,

    /// CHECK: must be the first fallback recipient not proven dead.
    #[account(constraint = recipient.key() == guard.next_fallback_recipient() @ HeirloomError::NoFallbackRecipient)]
    pub recipient: UncheckedAccount<'info>,

    #[account(address = estate.usdt_mint @ HeirloomError::WrongMint)]
    pub usdt_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = usdt_mint,
        associated_token::authority = estate,
        associated_token::token_program = token_program
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: the recipient's USD₮ ATA (created if missing), or another token account of the mint they own.
    #[account(mut)]
    pub recipient_usdt: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: the ["fallbackreport", estate, [index of the recipient]] PDA; may not exist. An agent-approved
    /// report made during the countdown holds the payment until it can be confirmed or refuted.
    #[account(seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[guard.next_fallback_index()]], bump)]
    pub fallback_report: UncheckedAccount<'info>,

    /// CHECK: the ["objection", estate] PDA; may not exist. An open challenge to the owner's death blocks (H6).
    #[account(seeds = [OBJECTION_SEED, estate.key().as_ref()], bump)]
    pub unlock_objection: UncheckedAccount<'info>,
}

pub fn execute_fallback_handler(ctx: Context<ExecuteFallback>) -> Result<()> {
    let ts = now()?;
    let obj_info = ctx.accounts.objection.to_account_info();
    let mut lapsed: Option<Objection> = None;
    let objection_open = if account_exists(&obj_info) {
        let mut o: Objection = read_account(&obj_info)?;
        if fallback_objection_lapsed(&o, &ctx.accounts.estate, &ctx.accounts.guard, ts)? {
            o.status = ObjectionStatus::Dismissed;
            write_account(&obj_info, &o)?;
            lapsed = Some(o);
            false
        } else {
            o.status == ObjectionStatus::Open
        }
    } else {
        false
    };
    if let Some(o) = lapsed {
        let guard = &mut ctx.accounts.guard;
        guard.open_objections = guard.open_objections.saturating_sub(1);
        emit!(ObjectionResolved {
            estate: o.estate,
            objection: obj_info.key(),
            target: o.target,
            kind: o.kind,
            upheld: false,
            ts,
        });
    }
    let estate = &ctx.accounts.estate;
    let guard = &ctx.accounts.guard;

    require!(!guard.fallback_done, HeirloomError::FallbackDone);
    // Not started, void after the owner's sign of life, or made for an earlier death claim.
    require!(countdown_valid(estate, guard), HeirloomError::FallbackNotReady);
    require!(owner_death_established(estate), HeirloomError::FallbackNotReady);
    require!(
        all_vacant([&ctx.accounts.seat0, &ctx.accounts.seat1, &ctx.accounts.seat2]),
        HeirloomError::SeatsNotVacant
    );
    let runs_at = fallback_runs_at(estate, guard);
    require!(ts >= runs_at, HeirloomError::WaitingPeriodNotOver);
    require!(!objection_open, HeirloomError::ObjectionOpen);
    if estate.status != EstateStatus::Unlocked {
        require!(
            !objection_is_open(&ctx.accounts.unlock_objection.to_account_info(), estate)?,
            HeirloomError::ObjectionOpen
        );
    }
    let recipient = guard.next_fallback_recipient();
    require!(is_set(&recipient), HeirloomError::NoFallbackRecipient);
    // Without this a death reported after the start could never be confirmed in time. Only reports from
    // before the countdown ended hold it, so the hold can't be renewed for ever.
    let report_info = ctx.accounts.fallback_report.to_account_info();
    if account_exists(&report_info) {
        let r: FallbackReport = read_account(&report_info)?;
        require!(
            !(r.reported_at < runs_at && r.holds_payment(guard, &recipient, ts)),
            HeirloomError::DeathReportOpen
        );
    }

    let amount = ctx.accounts.vault.amount;
    ready_token_account(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.recipient_usdt.to_account_info(),
        ctx.accounts.recipient.to_account_info(),
        ctx.accounts.usdt_mint.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.associated_token_program.to_account_info(),
    )?;
    if amount > 0 {
        let owner = estate.owner;
        let bump = [estate.bump];
        let seeds: &[&[u8]] = &[ESTATE_SEED, owner.as_ref(), &bump];
        transfer_checked_cpi(
            ctx.accounts.token_program.key(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.usdt_mint.to_account_info(),
            ctx.accounts.recipient_usdt.to_account_info(),
            ctx.accounts.estate.to_account_info(),
            amount,
            ctx.accounts.usdt_mint.decimals,
            &[seeds],
        )?;
    }

    ctx.accounts.guard.fallback_done = true;
    let estate = &mut ctx.accounts.estate;
    // From submission time to the time the death took effect.
    if estate.status == EstateStatus::Active {
        estate.death_pending_since = ts;
    }
    estate.status = EstateStatus::Unlocked;

    emit!(FallbackExecuted {
        estate: ctx.accounts.estate.key(),
        recipient,
        amount,
        ts,
    });
    Ok(())
}

// ====================================================================== lapse_objection

#[derive(Accounts)]
pub struct LapseObjection<'info> {
    pub estate: Account<'info, Estate>,

    #[account(mut, seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Account<'info, Guard>,

    #[account(
        mut,
        seeds = [OBJECTION_SEED, objection.target.as_ref()],
        bump = objection.bump,
        has_one = estate
    )]
    pub objection: Account<'info, Objection>,

    /// Anyone (any wallet). A signer, so the call can be fee-sponsored (the sponsor is only the fee payer).
    pub caller: Signer<'info>,
}

/// Anyone: marks a lapsed monitors' objection Dismissed. Fallback objections lapse after the fallback wait,
/// the others after two of the estate's waiting periods. The fallback countdown is not restarted (it kept running during the objection).
pub fn lapse_objection_handler(ctx: Context<LapseObjection>) -> Result<()> {
    let objection = &mut ctx.accounts.objection;
    require!(!objection.is_dispute(), HeirloomError::BadStatus);
    require!(objection.status == ObjectionStatus::Open, HeirloomError::BadStatus);
    let ts = now()?;
    let lapsed = if objection.kind == TargetKind::Fallback {
        fallback_objection_lapsed(objection, &ctx.accounts.estate, &ctx.accounts.guard, ts)?
    } else {
        !objection.is_effectively_open(&ctx.accounts.estate, ts)
    };
    require!(lapsed, HeirloomError::ObjectionNotLapsed);

    objection.status = ObjectionStatus::Dismissed;
    let guard = &mut ctx.accounts.guard;
    guard.open_objections = guard.open_objections.saturating_sub(1);

    emit!(ObjectionResolved {
        estate: objection.estate,
        objection: objection.key(),
        target: objection.target,
        kind: objection.kind,
        upheld: false,
        ts,
    });
    Ok(())
}
