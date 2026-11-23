//! Disputes (U9, added 2026-11-15): any beneficiary or verifier can freeze a pending claim payment or
//! a pending unlock (the death waiting period), with a short reason stored as a hash. Two of three
//! verifiers resolve it: uphold (the action is cancelled) or dismiss (it continues).
//!
//! Reuses the guardians' objection pattern rather than duplicating it: a dispute is an `Objection`
//! in the same `["objection", target]` PDA with `seat_index = DISPUTE_SEAT`, so every check that
//! already pauses on an open objection (execute_claim, finalize_unlock) pauses on a dispute too.
//! Unlike a monitor's objection, a dispute needs no Guard, and it lapses (counts as dismissed) after
//! max(estate.waiting_period_secs, 60 s), so a dispute can never lock funds forever.
use anchor_lang::prelude::*;

use super::guardians::{uphold_on_claim, uphold_on_unlock};
use super::{account_exists, count_bits, now, read_account, record_proof_of_life, write_account};
use crate::errors::HeirloomError;
use crate::events::*;
use crate::state::*;

// ====================================================================== raise_dispute

#[derive(Accounts)]
#[instruction(kind: TargetKind, target: Pubkey)]
pub struct RaiseDispute<'info> {
    /// An active beneficiary or one of the estate's verifiers. Pays the rent of a new Objection PDA.
    #[account(mut)]
    pub disputer: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    /// The disputer's Beneficiary PDA when a beneficiary disputes; None for a verifier.
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,

    /// CHECK: the Claim PDA for a Claim dispute (read in the handler); None for Unlock (target = estate).
    #[account(address = target)]
    pub target_account: Option<UncheckedAccount<'info>>,

    #[account(
        init_if_needed,
        payer = disputer,
        space = 8 + Objection::INIT_SPACE,
        seeds = [OBJECTION_SEED, target.as_ref()],
        bump
    )]
    pub objection: Box<Account<'info, Objection>>,

    pub system_program: Program<'info, System>,

    /// CHECK: the ["guard", estate] PDA; may not exist. Its open-objection count drops when a dispute takes the
    /// place of a monitors' objection that lapsed (L13).
    #[account(mut, seeds = [GUARD_SEED, estate.key().as_ref()], bump)]
    pub guard: UncheckedAccount<'info>,
}

pub fn raise_dispute_handler(
    ctx: Context<RaiseDispute>,
    kind: TargetKind,
    target: Pubkey,
    reason_hash: [u8; 32],
) -> Result<()> {
    let disputer = ctx.accounts.disputer.key();
    let estate = &ctx.accounts.estate;
    let estate_key = estate.key();

    // ---- who may dispute: a verifier, or an active beneficiary of this estate
    let is_verifier = estate.verifier_index(&disputer).is_some();
    let is_beneficiary = ctx
        .accounts
        .beneficiary_account
        .as_ref()
        .map(|b| b.estate == estate_key && b.wallet == disputer && b.active)
        .unwrap_or(false);
    require!(is_verifier || is_beneficiary, HeirloomError::NotDisputer);
    require!(reason_hash != [0u8; 32], HeirloomError::InvalidAmount);

    // ---- what may be disputed: a pending action during its waiting period
    match kind {
        TargetKind::Claim => {
            let info = ctx
                .accounts
                .target_account
                .as_ref()
                .ok_or(HeirloomError::BadStatus)?
                .to_account_info();
            let claim: Claim = read_account(&info)?;
            require!(claim.estate == estate_key, HeirloomError::BadStatus);
            require!(claim.status == ClaimStatus::Open, HeirloomError::BadStatus);
            // Otherwise a claimant could use the one challenge on their own claim and shut everyone else out.
            require!(claim.beneficiary != disputer, HeirloomError::OwnClaimDispute);
        }
        TargetKind::Unlock => {
            require_keys_eq!(target, estate_key, HeirloomError::BadStatus);
            require!(estate.status == EstateStatus::DeathPending, HeirloomError::BadStatus);
            require!(estate.death_submitted_by != disputer, HeirloomError::OwnClaimDispute);
        }
        // Sales, hardship, successions and the fallback plan are covered by monitors' objections.
        _ => return err!(HeirloomError::BadStatus),
    }

    // ---- one challenge at a time per target, and one per claim / per waiting period, so repeated
    // disputes can't extend a freeze forever.
    let ts = now()?;
    let objection = &mut ctx.accounts.objection;
    if objection.target != Pubkey::default() {
        require!(!objection.is_effectively_open(estate, ts), HeirloomError::ObjectionOpen);
        let upheld = objection.status == ObjectionStatus::Upheld;
        match kind {
            // An upheld challenge already cancelled the claim (caught above); any other one used its turn.
            TargetKind::Claim => return err!(HeirloomError::BadStatus),
            TargetKind::Unlock => require!(
                upheld || objection.raised_at < estate.death_pending_since,
                HeirloomError::BadStatus
            ),
            _ => {}
        }
    }

    if objection.status == ObjectionStatus::Open && !objection.is_dispute() && objection.target != Pubkey::default() {
        let info = ctx.accounts.guard.to_account_info();
        if account_exists(&info) {
            let mut guard: Guard = read_account(&info)?;
            guard.open_objections = guard.open_objections.saturating_sub(1);
            write_account(&info, &guard)?;
        }
    }

    let bump = ctx.bumps.objection;
    objection.set_inner(Objection {
        estate: estate_key,
        target,
        kind,
        monitor: disputer,
        seat_index: DISPUTE_SEAT,
        reason_hash,
        raised_at: ts,
        status: ObjectionStatus::Open,
        votes_uphold: 0,
        votes_dismiss: 0,
        bump,
    });
    let lapses_at = objection.lapses_at(estate);

    emit!(DisputeRaised {
        estate: estate_key,
        objection: objection.key(),
        target,
        kind,
        disputer,
        reason_hash,
        lapses_at,
        ts,
    });
    Ok(())
}

// ====================================================================== resolve_dispute

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    /// The owner while alive, who decides alone; otherwise a verifier other than the one who raised the dispute.
    pub verifier: Signer<'info>,

    #[account(mut)]
    pub estate: Box<Account<'info, Estate>>,

    #[account(
        mut,
        seeds = [OBJECTION_SEED, objection.target.as_ref()],
        bump = objection.bump,
        has_one = estate
    )]
    pub objection: Box<Account<'info, Objection>>,

    /// CHECK: == objection.target. The Claim (writable) for a Claim dispute; None for Unlock.
    #[account(mut, address = objection.target)]
    pub target_account: Option<UncheckedAccount<'info>>,
}

/// The living owner (estate Active or DeathPending) decides alone, and that is proof of life (M5). Otherwise
/// one vote per verifier; 2 uphold → Upheld (claim Rejected / death claim cleared, estate Active),
/// 2 dismiss → Dismissed (the action continues). Fails with DisputeLapsed once the dispute has lapsed.
pub fn resolve_dispute_handler(ctx: Context<ResolveDispute>, uphold: bool) -> Result<()> {
    let verifier = ctx.accounts.verifier.key();
    let ts = now()?;
    let objection = &mut ctx.accounts.objection;
    require!(objection.is_dispute(), HeirloomError::BadStatus);
    require!(objection.status == ObjectionStatus::Open, HeirloomError::BadStatus);
    require!(
        objection.is_effectively_open(&ctx.accounts.estate, ts),
        HeirloomError::DisputeLapsed
    );
    let estate = &ctx.accounts.estate;
    let owner_decides = verifier == estate.owner && estate.status != EstateStatus::Unlocked;
    let decision = if owner_decides {
        Some(uphold)
    } else {
        // While the owner lives, trusted people do not decide disputes on claims (only the owner pays them then).
        require!(
            objection.kind != TargetKind::Claim || estate.status == EstateStatus::Unlocked,
            HeirloomError::NotOwner
        );
        let idx = estate.verifier_index(&verifier).ok_or(HeirloomError::NotVerifier)?;
        require!(verifier != objection.monitor, HeirloomError::NotVerifier);

        let bit = 1u8 << idx;
        require!(
            (objection.votes_uphold | objection.votes_dismiss) & bit == 0,
            HeirloomError::AlreadyApproved
        );
        if uphold {
            objection.votes_uphold |= bit;
        } else {
            let claimant = if objection.kind == TargetKind::Claim {
                let info = ctx.accounts.target_account.as_ref().ok_or(HeirloomError::BadStatus)?.to_account_info();
                read_account::<Claim>(&info)?.beneficiary
            } else {
                estate.death_submitted_by
            };
            require!(verifier != claimant, HeirloomError::OwnApproval);
            objection.votes_dismiss |= bit;
        }
        let voting = estate.living_seats_except(&Pubkey::default());
        if count_bits(objection.votes_uphold & voting) >= 2 {
            Some(true)
        } else if count_bits(objection.votes_dismiss & voting) >= 2 {
            Some(false)
        } else {
            None
        }
    };
    let objection_key = objection.key();
    emit!(DisputeVoted {
        objection: objection_key,
        verifier,
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
    // From now on raised_at is when it was resolved: a claim's objection window runs from here (H5).
    objection.raised_at = ts;
    let kind = objection.kind;
    let target = objection.target;

    if upheld {
        match kind {
            TargetKind::Claim => {
                let info = ctx
                    .accounts
                    .target_account
                    .as_ref()
                    .ok_or(HeirloomError::BadStatus)?
                    .to_account_info();
                uphold_on_claim(&info)?;
            }
            TargetKind::Unlock => uphold_on_unlock(&mut ctx.accounts.estate),
            _ => return err!(HeirloomError::BadStatus),
        }
    }
    if owner_decides {
        let key = ctx.accounts.estate.key();
        record_proof_of_life(key, &mut ctx.accounts.estate, ts);
    }

    emit!(DisputeResolved {
        estate: ctx.accounts.estate.key(),
        objection: objection_key,
        target,
        kind,
        upheld,
        ts,
    });
    Ok(())
}
