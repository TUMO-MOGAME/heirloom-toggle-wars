//! Death flow: someone in the plan submits a certificate hash -> agent reviews -> verifiers attest
//! (death_threshold) -> waiting period (owner can veto) -> anyone finalises the unlock.
use anchor_lang::prelude::*;

use super::{count_bits, now, objection_is_open, void_objection};
use crate::errors::HeirloomError;
use crate::events::*;
use crate::state::*;

// ====================================================================== submit_death_claim

#[derive(Accounts)]
pub struct SubmitDeathClaim<'info> {
    /// An active beneficiary, a living trusted person or a living listed fallback recipient (M10); never the agent.
    pub beneficiary: Signer<'info>,

    #[account(mut)]
    pub estate: Box<Account<'info, Estate>>,

    /// The signer's Beneficiary PDA when a beneficiary submits; otherwise None.
    #[account(
        seeds = [BENEFICIARY_SEED, estate.key().as_ref(), beneficiary.key().as_ref()],
        bump = beneficiary_account.bump
    )]
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,

    /// The Guard when a listed fallback recipient submits; otherwise None.
    #[account(seeds = [GUARD_SEED, estate.key().as_ref()], bump = guard.bump, has_one = estate)]
    pub guard: Option<Box<Account<'info, Guard>>>,

    /// CHECK: the ["objection", estate] PDA; may not exist. A challenge to the claim this replaces is void.
    #[account(mut, seeds = [OBJECTION_SEED, estate.key().as_ref()], bump)]
    pub objection: UncheckedAccount<'info>,
}

pub fn submit_death_claim_handler(ctx: Context<SubmitDeathClaim>, cert_hash: [u8; 32]) -> Result<()> {
    require!(cert_hash != [0u8; 32], HeirloomError::NoDeathClaim);
    let submitted_by = ctx.accounts.beneficiary.key();
    let estate = &ctx.accounts.estate;
    require!(submitted_by != estate.agent, HeirloomError::NotParticipant);
    let beneficiary = ctx.accounts.beneficiary_account.as_ref().is_some_and(|b| b.active);
    let listed = ctx.accounts.guard.as_ref().is_some_and(|g| g.is_living_listed(&submitted_by));
    require!(
        beneficiary || listed || estate.verifier_index(&submitted_by).is_some(),
        HeirloomError::NotBeneficiary
    );

    let estate = &mut ctx.accounts.estate;
    let disproved = estate.death_disproved();
    require!(
        estate.status == EstateStatus::Active || (estate.status == EstateStatus::DeathPending && disproved),
        HeirloomError::BadStatus
    );
    let ts = now()?;
    // One open death claim at a time, so a second submission can't reset attestations. A reviewed claim gives way
    // once stale. An unreviewed one never does (the agent reviews it, or a lost agent is replaced after it has
    // stood RT), so its time stays when this death's first claim was made: replacing it can't restart the
    // recovery clock (N4). With no trusted people left a reviewed claim is the fallback plan's proof and stays.
    if estate.death_cert_hash != [0u8; 32] && !disproved {
        require!(
            estate.death_verdict != Verdict::Pending
                && estate.has_living_seat()
                && estate.report_replaceable(
                    estate.death_verdict,
                    estate.death_pending_since,
                    &estate.death_submitted_by,
                    &submitted_by,
                    estate.report_grace(),
                    estate.reviewed_hold(),
                    ts,
                ),
            HeirloomError::BadStatus
        );
    }
    void_objection(&ctx.accounts.objection.to_account_info())?;

    estate.death_cert_hash = cert_hash;
    estate.death_submitted_by = submitted_by;
    estate.death_verdict = Verdict::Pending;
    estate.death_attestations = 0;
    estate.death_pending_since = ts;
    estate.status = EstateStatus::Active;

    emit!(DeathClaimSubmitted {
        estate: estate.key(),
        submitted_by,
        cert_hash,
        ts,
    });
    Ok(())
}

// ====================================================================== review_death

#[derive(Accounts)]
pub struct ReviewDeath<'info> {
    pub agent: Signer<'info>,

    #[account(mut, has_one = agent @ HeirloomError::NotAgent)]
    pub estate: Account<'info, Estate>,
}

/// `cert_hash` is the certificate the agent read: a claim that replaced it is not reviewed by mistake.
pub fn review_death_handler(
    ctx: Context<ReviewDeath>,
    outcome: ReviewOutcome,
    report_hash: [u8; 32],
    cert_hash: [u8; 32],
) -> Result<()> {
    let estate = &mut ctx.accounts.estate;
    require!(estate.death_cert_hash != [0u8; 32], HeirloomError::NoDeathClaim);
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    require!(estate.death_verdict == Verdict::Pending, HeirloomError::BadStatus);
    require!(!estate.death_disproved(), HeirloomError::DeathDisproved);
    require!(estate.death_cert_hash == cert_hash, HeirloomError::ReportChanged);
    // Nobody reviews a death they reported themselves (an agent who became one after submitting).
    require!(estate.death_submitted_by != estate.agent, HeirloomError::OwnApproval);

    let (key, ts) = (estate.key(), now()?);
    match outcome {
        ReviewOutcome::Approve => estate.death_verdict = Verdict::Approved,
        ReviewOutcome::Reject => estate.clear_death_claim(),
        ReviewOutcome::Refer => {
            estate.death_verdict = Verdict::Referred;
            emit!(ReviewReferred { estate: key, target: key, kind: TargetKind::Unlock, report_hash, ts });
            return Ok(());
        }
    }

    emit!(DeathReviewed {
        estate: key,
        approved: outcome == ReviewOutcome::Approve,
        report_hash,
        ts,
    });
    Ok(())
}

// ====================================================================== attest_death

#[derive(Accounts)]
pub struct AttestDeath<'info> {
    pub verifier: Signer<'info>,

    #[account(mut)]
    pub estate: Account<'info, Estate>,
}

pub fn attest_death_handler(ctx: Context<AttestDeath>) -> Result<()> {
    let verifier = ctx.accounts.verifier.key();
    let estate = &mut ctx.accounts.estate;
    let idx = estate
        .verifier_index(&verifier)
        .ok_or(HeirloomError::NotVerifier)?;

    require!(estate.death_cert_hash != [0u8; 32], HeirloomError::NoDeathClaim);
    require!(
        estate.status == EstateStatus::Active || estate.status == EstateStatus::DeathPending,
        HeirloomError::BadStatus
    );
    require!(!estate.death_disproved(), HeirloomError::DeathDisproved);
    require!(estate.death_verdict.open_to_people(), HeirloomError::AgentNotApproved);
    let submitter = estate.death_submitted_by;
    let bit = 1u8 << idx;
    let eligible = estate.deciders(&submitter, estate.death_verdict);
    require!(verifier != submitter || eligible & bit != 0, HeirloomError::OwnApproval);

    let first_time = estate.death_attestations & bit == 0;
    estate.death_attestations |= bit;

    let ts = now()?;
    let count = count_bits(estate.death_attestations & eligible);
    let needed = estate.death_verdict.quorum(estate.death_threshold);
    let starts =
        estate.status == EstateStatus::Active && Estate::votes_meet(estate.death_attestations, eligible, needed);
    // Signing again only completes a quorum that has dropped since.
    require!(first_time || starts, HeirloomError::AlreadyApproved);
    // Only the attestation that reaches the threshold starts the timer; later ones don't reset it.
    if starts {
        estate.status = EstateStatus::DeathPending;
        estate.death_pending_since = ts;
        if verifier == submitter {
            estate.death_attestations |= DECIDED_ALONE;
        }
    }

    emit!(DeathAttested {
        estate: estate.key(),
        verifier,
        count,
        pending: estate.status == EstateStatus::DeathPending,
        ts,
    });
    emit!(SeatApproval {
        estate: estate.key(),
        seat_index: idx as u8,
        approver: verifier,
        kind: TargetKind::Unlock,
        target: estate.key(),
        ts,
    });
    Ok(())
}

// ====================================================================== veto_death

#[derive(Accounts)]
pub struct VetoDeath<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,
}

pub fn veto_death_handler(ctx: Context<VetoDeath>) -> Result<()> {
    let estate = &mut ctx.accounts.estate;
    require!(
        estate.status == EstateStatus::Active || estate.status == EstateStatus::DeathPending,
        HeirloomError::BadStatus
    );

    let ts = now()?;
    estate.clear_death_claim();
    estate.status = EstateStatus::Active;
    estate.last_heartbeat = ts;

    emit!(DeathVetoed {
        estate: estate.key(),
        ts,
    });
    Ok(())
}

// ====================================================================== finalize_unlock

#[derive(Accounts)]
pub struct FinalizeUnlock<'info> {
    #[account(mut)]
    pub estate: Account<'info, Estate>,

    /// CHECK: the ["objection", estate] PDA; may not exist. Blocks while Open.
    #[account(seeds = [OBJECTION_SEED, estate.key().as_ref()], bump)]
    pub objection: UncheckedAccount<'info>,

    /// Anyone (any wallet). A signer, so the call can be fee-sponsored (the sponsor is only the fee payer).
    pub caller: Signer<'info>,
}

pub fn finalize_unlock_handler(ctx: Context<FinalizeUnlock>) -> Result<()> {
    let objection_open = objection_is_open(&ctx.accounts.objection.to_account_info(), &ctx.accounts.estate)?;
    let estate = &mut ctx.accounts.estate;
    require!(estate.status == EstateStatus::DeathPending, HeirloomError::BadStatus);
    require!(!estate.death_disproved(), HeirloomError::DeathDisproved);

    let ts = now()?;
    let unlock_at = estate
        .death_pending_since
        .checked_add(estate.unlock_delay())
        .ok_or(HeirloomError::MathOverflow)?;
    require!(ts >= unlock_at, HeirloomError::WaitingPeriodNotOver);
    require!(!objection_open, HeirloomError::ObjectionOpen);

    estate.status = EstateStatus::Unlocked;

    emit!(EstateUnlocked {
        estate: estate.key(),
        ts,
    });
    Ok(())
}
