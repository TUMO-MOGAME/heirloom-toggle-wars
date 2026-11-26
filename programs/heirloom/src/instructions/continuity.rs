//! Continuity (added 2026-11-22): end a rule, pay out what no rule needs any more, replace the agent's key.
//! Without these a living plan could not change, a surplus stayed in the vault forever and a lost agent key
//! froze every review.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::guardians::{check_not_a_backup, clear_agent_reviews};
use super::{account_exists, now, read_account, ready_token_account, record_proof_of_life, transfer_checked_cpi};
use crate::errors::HeirloomError;
use crate::events::*;
use crate::state::*;

// ====================================================================== end_rule

#[derive(Accounts)]
pub struct EndRule<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(mut, has_one = estate)]
    pub rule: Account<'info, Rule>,
}

/// Owner, estate Active: the rule expires now. Open claims and scheduled payments under it can no longer pay.
pub fn end_rule_handler(ctx: Context<EndRule>) -> Result<()> {
    require!(ctx.accounts.estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    let ts = now()?;
    let rule = &mut ctx.accounts.rule;
    require!(ts <= rule.valid_until, HeirloomError::RuleExpired);
    rule.valid_until = ts.saturating_sub(1);

    emit!(RuleEnded { estate: rule.estate, rule: rule.key(), ts });
    Ok(())
}

// ====================================================================== end_orphan_rule

#[derive(Accounts)]
pub struct EndOrphanRule<'info> {
    /// Anyone (any wallet). A signer, so the call can be fee-sponsored (the sponsor is only the fee payer).
    pub caller: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(mut, has_one = estate)]
    pub rule: Account<'info, Rule>,

    /// The rule's Beneficiary PDA.
    #[account(seeds = [BENEFICIARY_SEED, estate.key().as_ref(), rule.beneficiary.as_ref()], bump = beneficiary_account.bump)]
    pub beneficiary_account: Account<'info, Beneficiary>,
}

/// Anyone, estate Unlocked: ends a rule whose beneficiary the owner removed (P3). Nothing it could pay is payable
/// (every payout checks the beneficiary is active, and nobody can add one back after the unlock), so its reserve
/// goes to sweep_residual. No money moves here.
pub fn end_orphan_rule_handler(ctx: Context<EndOrphanRule>) -> Result<()> {
    require!(ctx.accounts.estate.status == EstateStatus::Unlocked, HeirloomError::BadStatus);
    require!(!ctx.accounts.beneficiary_account.active, HeirloomError::BeneficiaryStillActive);
    let ts = now()?;
    let rule = &mut ctx.accounts.rule;
    require!(ts <= rule.valid_until, HeirloomError::RuleExpired);
    rule.valid_until = ts.saturating_sub(1);

    emit!(RuleEnded { estate: rule.estate, rule: rule.key(), ts });
    Ok(())
}

// ====================================================================== set_residual

#[derive(Accounts)]
pub struct SetResidual<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Residual::INIT_SPACE,
        seeds = [RESIDUAL_SEED, estate.key().as_ref()],
        bump
    )]
    pub residual: Account<'info, Residual>,

    pub system_program: Program<'info, System>,
}

/// Owner, estate Active: names who receives what is left.
pub fn set_residual_handler(ctx: Context<SetResidual>, recipient: Pubkey) -> Result<()> {
    let estate = &ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    require!(
        recipient != Pubkey::default() && recipient != estate.owner && recipient != estate.key(),
        HeirloomError::NoResidualRecipient
    );

    let estate_key = estate.key();
    let bump = ctx.bumps.residual;
    ctx.accounts.residual.set_inner(Residual { estate: estate_key, recipient, bump });

    emit!(ResidualSet { estate: estate_key, recipient, ts: now()? });
    Ok(())
}

// ====================================================================== sweep_residual

#[derive(Accounts)]
pub struct SweepResidual<'info> {
    /// Anyone; pays the recipient's ATA rent if missing.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    /// CHECK: the ["residual", estate] PDA; may not exist.
    #[account(seeds = [RESIDUAL_SEED, estate.key().as_ref()], bump)]
    pub residual: UncheckedAccount<'info>,

    /// CHECK: the ["guard", estate] PDA; may not exist. Read only when no residual recipient was named.
    #[account(seeds = [GUARD_SEED, estate.key().as_ref()], bump)]
    pub guard: UncheckedAccount<'info>,

    /// CHECK: the residual recipient, else the first living fallback recipient (checked in the handler).
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

    /// CHECK: the ["fallbackreport", estate, [the Guard's first living index, else 255]] PDA; may not exist.
    /// Read only when paying by the fallback list: an agent-approved report on that recipient holds the sweep.
    #[account(seeds = [FALLBACK_REPORT_SEED, estate.key().as_ref(), &[next_index_of(&guard)]], bump)]
    pub fallback_report: UncheckedAccount<'info>,
    // remaining_accounts: every Rule of the estate, in id order.
}

/// The fallback list's next index; NO_SEAT when there is no Guard.
fn next_index_of(guard: &AccountInfo) -> u8 {
    if !account_exists(guard) {
        return NO_SEAT;
    }
    read_account::<Guard>(guard).map_or(NO_SEAT, |g| g.next_fallback_index())
}

/// Anyone, estate Unlocked: pays the vault minus what live rules can still claim. Callable again later
/// (a rule expired, sale proceeds arrived).
pub fn sweep_residual_handler<'info>(ctx: Context<'info, SweepResidual<'info>>) -> Result<()> {
    let estate = &ctx.accounts.estate;
    require!(estate.status == EstateStatus::Unlocked, HeirloomError::BadStatus);

    let residual_info = ctx.accounts.residual.to_account_info();
    let guard_info = ctx.accounts.guard.to_account_info();
    let mut by_list: Option<Guard> = None;
    let expected = if account_exists(&residual_info) {
        read_account::<Residual>(&residual_info)?.recipient
    } else if account_exists(&guard_info) {
        let guard: Guard = read_account(&guard_info)?;
        let next = guard.next_fallback_recipient();
        by_list = Some(guard);
        next
    } else {
        Pubkey::default()
    };
    require!(
        expected != Pubkey::default() && expected == ctx.accounts.recipient.key(),
        HeirloomError::NoResidualRecipient
    );
    let ts = now()?;
    let report_info = ctx.accounts.fallback_report.to_account_info();
    if let Some(guard) = by_list.filter(|_| account_exists(&report_info)) {
        let report: FallbackReport = read_account(&report_info)?;
        require!(!report.holds_payment(&guard, &expected, ts), HeirloomError::DeathReportOpen);
    }

    let infos = ctx.remaining_accounts;
    require!(infos.len() == estate.rule_count as usize, HeirloomError::RulesIncomplete);
    let estate_key = estate.key();
    // After the fallback ran no trusted person is left to approve a claim, so no rule reserves anything (M9).
    let fallback_done = account_exists(&guard_info) && read_account::<Guard>(&guard_info)?.fallback_done;
    let mut reserved: u64 = 0;
    for (i, info) in infos.iter().enumerate() {
        let rule: Rule = read_account(info)?;
        // Only this program creates Rules, one per (estate, id), so id == position means none is missing or repeated.
        require!(rule.estate == estate_key && rule.id as usize == i, HeirloomError::RulesIncomplete);
        if ts <= rule.valid_until && !fallback_done {
            let left = rule.lifetime_cap.saturating_sub(rule.spent_total);
            reserved = reserved.saturating_add(left);
        }
    }

    let amount = ctx.accounts.vault.amount.saturating_sub(reserved);
    require!(amount > 0, HeirloomError::NothingToSweep);
    ready_token_account(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.recipient_usdt.to_account_info(),
        ctx.accounts.recipient.to_account_info(),
        ctx.accounts.usdt_mint.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.associated_token_program.to_account_info(),
    )?;

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

    emit!(ResidualSwept { estate: estate_key, recipient: expected, amount, reserved, ts });
    Ok(())
}

// ====================================================================== set_agent / vote_agent

/// The three Seat and four FallbackReport accounts of set_agent and vote_agent.
macro_rules! agent_accounts {
    ($ctx:ident) => {{
        let a = &$ctx.accounts;
        (
            [a.seat0.to_account_info(), a.seat1.to_account_info(), a.seat2.to_account_info()],
            [
                a.fallback_report0.to_account_info(),
                a.fallback_report1.to_account_info(),
                a.fallback_report2.to_account_info(),
                a.fallback_report3.to_account_info(),
            ],
        )
    }};
}

/// The voter gains from deciding alone: the open death claim is theirs, or they are an active beneficiary. The
/// voter's Beneficiary PDA comes first in remaining_accounts; without it the voter counts as one (fails closed).
fn gains(estate: &Account<Estate>, voter: &Pubkey, claim_open: bool, infos: &[AccountInfo]) -> bool {
    if claim_open && estate.death_submitted_by == *voter {
        return true;
    }
    let key = estate.key();
    let pda = Pubkey::find_program_address(&[BENEFICIARY_SEED, key.as_ref(), voter.as_ref()], &crate::ID).0;
    match infos.first().filter(|i| i.key() == pda) {
        None => true,
        Some(info) if !account_exists(info) => false,
        Some(info) => read_account::<Beneficiary>(info).map_or(true, |b| b.active),
    }
}

/// After the unlock: when the voter's own open claim (second in remaining_accounts) was made, while the agent has
/// not approved it. None without such a claim.
fn stuck_claim_since(estate: &Pubkey, voter: &Pubkey, info: Option<&AccountInfo>) -> Option<i64> {
    let claim: Claim = read_account(info?).ok()?;
    (claim.estate == *estate
        && claim.beneficiary == *voter
        && claim.status == ClaimStatus::Open
        && claim.agent_verdict != Verdict::Approved)
        .then_some(claim.created_at)
}

fn check_candidate(estate: &Estate, candidate: &Pubkey) -> Result<()> {
    require!(
        *candidate != Pubkey::default()
            && *candidate != estate.agent
            && *candidate != estate.owner
            && estate.verifier_index(candidate).is_none(),
        HeirloomError::BadAgent
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SetAgent<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Box<Account<'info, Estate>>,

    /// CHECK: the Seat PDA ["seat", estate, [0]]; may not exist. Reviews by the old agent are set back (M6), and a
    /// candidate must not be a backup (L9).
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[0u8]], bump)]
    pub seat0: UncheckedAccount<'info>,
    /// CHECK: as seat0, index 1.
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[1u8]], bump)]
    pub seat1: UncheckedAccount<'info>,
    /// CHECK: as seat0, index 2.
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[2u8]], bump)]
    pub seat2: UncheckedAccount<'info>,
    /// CHECK: the ["fallbackreport", estate, [0]] PDA; may not exist. Its verdict by the old agent is set back.
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

/// Owner, estate Active: replaces the agent. Proof of life, which also voids the old agent's death review; what
/// it reviewed of seats and fallback recipients goes back to Pending.
pub fn set_agent_handler(ctx: Context<SetAgent>, agent: Pubkey) -> Result<()> {
    let (seats, reports) = agent_accounts!(ctx);
    let estate = &mut ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    check_candidate(estate, &agent)?;
    check_not_a_backup(&seats, &agent)?;
    let previous = estate.agent;
    estate.agent = agent;

    let (key, ts) = (estate.key(), now()?);
    record_proof_of_life(key, estate, ts);
    clear_agent_reviews(&key, &seats, &reports, ts)?;
    emit!(AgentChanged { estate: key, previous, agent, ts });
    Ok(())
}

#[derive(Accounts)]
#[instruction(candidate: Pubkey)]
pub struct VoteAgent<'info> {
    #[account(mut)]
    pub verifier: Signer<'info>,

    #[account(mut)]
    pub estate: Box<Account<'info, Estate>>,

    #[account(
        init_if_needed,
        payer = verifier,
        space = 8 + AgentVote::INIT_SPACE,
        seeds = [AGENT_VOTE_SEED, estate.key().as_ref(), candidate.as_ref()],
        bump
    )]
    pub agent_vote: Box<Account<'info, AgentVote>>,

    pub system_program: Program<'info, System>,

    /// CHECK: the Seat PDA ["seat", estate, [0]]; may not exist. Reviews by the old agent are set back (M6), and a
    /// candidate must not be a backup (L9).
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[0u8]], bump)]
    pub seat0: UncheckedAccount<'info>,
    /// CHECK: as seat0, index 1.
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[1u8]], bump)]
    pub seat1: UncheckedAccount<'info>,
    /// CHECK: as seat0, index 2.
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[2u8]], bump)]
    pub seat2: UncheckedAccount<'info>,
    /// CHECK: the ["fallbackreport", estate, [0]] PDA; may not exist. Its verdict by the old agent is set back.
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

/// Trusted people replace the agent. Before the unlock it takes every one of them (at least two): the owner may
/// already have died with the agent's key lost. Afterwards it takes two, or the only one left; so it does before
/// the unlock once a death claim has stood unreviewed for the recovery timeout with no sign of life from the owner
/// for as long (H7). The old agent's reviews go back to Pending (M6).
pub fn vote_agent_handler<'info>(ctx: Context<'info, VoteAgent<'info>>, candidate: Pubkey) -> Result<()> {
    let (seat_infos, reports) = agent_accounts!(ctx);
    let verifier = ctx.accounts.verifier.key();
    let estate = &mut ctx.accounts.estate;
    let idx = estate.verifier_index(&verifier).ok_or(HeirloomError::NotVerifier)?;
    check_candidate(estate, &candidate)?;
    check_not_a_backup(&seat_infos, &candidate)?;

    let vote = &mut ctx.accounts.agent_vote;
    if vote.replaces != estate.agent {
        vote.estate = estate.key();
        vote.candidate = candidate;
        vote.replaces = estate.agent;
        vote.voters = [Pubkey::default(); VERIFIER_COUNT];
        vote.bump = ctx.bumps.agent_vote;
    }
    let first_time = vote.voters[idx] != verifier;
    vote.voters[idx] = verifier;

    let (mut seats, mut count) = (0u8, 0u8);
    for (holder, voter) in estate.verifiers.iter().zip(vote.voters.iter()) {
        if *holder == Pubkey::default() {
            continue;
        }
        seats += 1;
        // A vote counts only while the voter still holds that seat.
        if voter == holder {
            count += 1;
        }
    }
    let ts = now()?;
    let claim_open = estate.death_cert_hash != [0u8; 32] && !estate.death_disproved();
    // The death claim has stood unreviewed for RT (an unreviewed claim can't be replaced, so this is this death's
    // first claim) and the owner has shown no life for RT (N1).
    let recovery = claim_open
        && estate.death_verdict == Verdict::Pending
        && ts >= estate.last_heartbeat.saturating_add(estate.recovery_timeout())
        && ts >= estate.death_pending_since.saturating_add(estate.recovery_timeout());
    let needed = if estate.status == EstateStatus::Unlocked || recovery { seats.min(2) } else { seats.max(2) };
    // N2: a voter who would decide alone and who gains waits 2 x RT before their vote alone replaces the agent.
    if needed == 1 && count == 1 && gains(estate, &verifier, claim_open, ctx.remaining_accounts) {
        let late = estate.recovery_timeout().saturating_mul(2);
        let since = if estate.status == EstateStatus::Unlocked {
            stuck_claim_since(&estate.key(), &verifier, ctx.remaining_accounts.get(1))
        } else {
            Some(estate.last_heartbeat.max(estate.death_pending_since))
        };
        require!(since.is_some_and(|s| ts >= s.saturating_add(late)), HeirloomError::WaitingPeriodNotOver);
    }

    // Voting again only completes a quorum that has dropped since.
    require!(first_time || count >= needed, HeirloomError::AlreadyApproved);

    let estate_key = estate.key();
    emit!(AgentVoted { estate: estate_key, candidate, verifier, count, ts });
    if count >= needed {
        let previous = estate.agent;
        estate.agent = candidate;
        vote.voters = [Pubkey::default(); VERIFIER_COUNT];
        // The death claim's review was the old agent's: the new one reviews it again, and the wait starts over.
        if claim_open && estate.status != EstateStatus::Unlocked && estate.death_verdict != Verdict::Pending {
            estate.death_verdict = Verdict::Pending;
            estate.death_attestations = 0;
            estate.death_pending_since = ts;
            estate.status = EstateStatus::Active;
            emit!(AgentReviewCleared { estate: estate_key, target: estate_key, ts });
        }
        clear_agent_reviews(&estate_key, &seat_infos, &reports, ts)?;
        emit!(AgentChanged { estate: estate_key, previous, agent: candidate, ts });
    }
    Ok(())
}
