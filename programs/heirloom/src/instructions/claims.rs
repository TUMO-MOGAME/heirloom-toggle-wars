//! Claims: after unlock, money leaves the vault only to an approved payee, within a rule's caps,
//! after the agent's review and claim_threshold verifier approvals.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::caps::check_year_cap;
use super::{account_exists, count_bits, now, objection_is_open, read_account, transfer_checked_cpi};
use crate::errors::HeirloomError;
use crate::events::*;
use crate::state::*;

/// Payments under `rule` may move: Unlocked always; Active only for a living plan (starts_now).
fn rule_open_for(estate: &Estate, rule: &Rule) -> bool {
    estate.status == EstateStatus::Unlocked
        || (estate.status == EstateStatus::Active && rule.starts_now)
}

/// The approvals stand: a quorum of the seats that decide now, none of it lost to a vacancy unless what is left
/// still reaches the full threshold (L8), and, when the claimant is the only trusted person left, given by them
/// through that route (H4).
fn approvals_stand(estate: &Estate, claim: &Claim) -> bool {
    let votes = claim.approvals;
    let eligible = estate.deciders(&claim.beneficiary, claim.agent_verdict);
    let needed = claim.agent_verdict.quorum(estate.claim_threshold);
    let lost = votes & 0b111 & !eligible != 0 && count_bits(votes & eligible) < needed;
    let alone = estate.living_seats_except(&claim.beneficiary) == 0;
    Estate::votes_meet(votes, eligible, needed) && !lost && (!alone || votes & DECIDED_ALONE != 0)
}

/// Every payout: the beneficiary is still in the plan and the payee is still one the rule allows (a removed
/// payee's account is closed, so it can't be passed at all).
fn check_parties(rule: &Rule, beneficiary: &Beneficiary, payee: &Payee) -> Result<()> {
    require!(beneficiary.active, HeirloomError::NotBeneficiary);
    require!(payee.kind == rule.allowed_payee_kind, HeirloomError::WrongPayeeKind);
    Ok(())
}

// ====================================================================== submit_claim

#[derive(Accounts)]
pub struct SubmitClaim<'info> {
    #[account(mut)]
    pub beneficiary: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    #[account(
        seeds = [BENEFICIARY_SEED, estate.key().as_ref(), beneficiary.key().as_ref()],
        bump = beneficiary_account.bump
    )]
    pub beneficiary_account: Box<Account<'info, Beneficiary>>,

    #[account(mut, has_one = estate)]
    pub rule: Box<Account<'info, Rule>>,

    /// The Payee PDA the money will go to.
    #[account(has_one = estate)]
    pub payee: Box<Account<'info, Payee>>,

    #[account(
        init,
        payer = beneficiary,
        space = 8 + Claim::INIT_SPACE,
        seeds = [CLAIM_SEED, rule.key().as_ref(), &rule.claim_count.to_le_bytes()],
        bump
    )]
    pub claim: Box<Account<'info, Claim>>,

    pub system_program: Program<'info, System>,

    /// CHECK: the ["yearcap", rule] PDA; may not exist (the rule has no yearly cap).
    #[account(seeds = [YEAR_CAP_SEED, rule.key().as_ref()], bump)]
    pub year_cap: UncheckedAccount<'info>,
}

pub fn submit_claim_handler(ctx: Context<SubmitClaim>, amount: u64, evidence_hash: [u8; 32]) -> Result<()> {
    let signer = ctx.accounts.beneficiary.key();
    require!(ctx.accounts.beneficiary_account.active, HeirloomError::NotBeneficiary);
    let rule = &ctx.accounts.rule;
    require!(
        rule_open_for(&ctx.accounts.estate, rule),
        HeirloomError::BadStatus
    );

    require_keys_eq!(rule.beneficiary, signer, HeirloomError::NotBeneficiary);
    require!(amount > 0, HeirloomError::InvalidAmount);
    require!(
        ctx.accounts.payee.kind == rule.allowed_payee_kind,
        HeirloomError::WrongPayeeKind
    );
    require!(amount <= rule.max_per_claim, HeirloomError::ExceedsPerClaimCap);
    let new_total = rule
        .spent_total
        .checked_add(amount)
        .ok_or(HeirloomError::MathOverflow)?;
    require!(new_total <= rule.lifetime_cap, HeirloomError::ExceedsLifetimeCap);

    let ts = now()?;
    require!(ts <= rule.valid_until, HeirloomError::RuleExpired);
    // Yearly cap: checked now (so a claim that can't be paid this year is refused early), recorded at execution.
    check_year_cap(&ctx.accounts.year_cap.to_account_info(), &rule.key(), amount, false)?;

    let id = rule.claim_count;
    let next_count = rule.next_claim_count().ok_or(HeirloomError::MathOverflow)?;
    let estate = ctx.accounts.estate.key();
    let rule_key = rule.key();
    let payee = ctx.accounts.payee.wallet;
    let bump = ctx.bumps.claim;

    ctx.accounts.claim.set_inner(Claim {
        estate,
        rule: rule_key,
        id,
        beneficiary: signer,
        payee,
        amount,
        evidence_hash,
        agent_verdict: Verdict::Pending,
        agent_report_hash: [0u8; 32],
        approvals: 0,
        status: ClaimStatus::Open,
        created_at: ts,
        owner_approved: false,
        bump,
    });
    ctx.accounts.rule.claim_count = next_count;

    emit!(ClaimSubmitted {
        estate,
        rule: rule_key,
        claim: ctx.accounts.claim.key(),
        beneficiary: signer,
        payee,
        amount,
        ts,
    });
    Ok(())
}

// ====================================================================== review_claim

#[derive(Accounts)]
pub struct ReviewClaim<'info> {
    pub agent: Signer<'info>,

    #[account(has_one = agent @ HeirloomError::NotAgent)]
    pub estate: Account<'info, Estate>,

    #[account(mut, has_one = estate)]
    pub claim: Account<'info, Claim>,
}

pub fn review_claim_handler(ctx: Context<ReviewClaim>, outcome: ReviewOutcome, report_hash: [u8; 32]) -> Result<()> {
    let claim = &mut ctx.accounts.claim;
    require!(
        claim.status == ClaimStatus::Open && claim.agent_verdict == Verdict::Pending,
        HeirloomError::BadStatus
    );
    require!(claim.beneficiary != ctx.accounts.agent.key(), HeirloomError::OwnApproval);

    claim.agent_report_hash = report_hash;
    let ts = now()?;
    match outcome {
        ReviewOutcome::Approve => claim.agent_verdict = Verdict::Approved,
        ReviewOutcome::Reject => {
            claim.agent_verdict = Verdict::Rejected;
            claim.status = ClaimStatus::Rejected;
        }
        ReviewOutcome::Refer => {
            claim.agent_verdict = Verdict::Referred;
            emit!(ReviewReferred { estate: claim.estate, target: claim.key(), kind: TargetKind::Claim, report_hash, ts });
            return Ok(());
        }
    }

    emit!(ClaimReviewed {
        claim: claim.key(),
        approved: outcome == ReviewOutcome::Approve,
        report_hash,
        ts,
    });
    Ok(())
}

// ====================================================================== approve_claim

#[derive(Accounts)]
pub struct ApproveClaim<'info> {
    pub verifier: Signer<'info>,

    pub estate: Account<'info, Estate>,

    #[account(mut, has_one = estate)]
    pub claim: Account<'info, Claim>,

    /// Pays the ApprovalStamp rent (the verifier or a sponsor).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// ["stamp", claim]: records when the approval threshold was reached (objection window).
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ApprovalStamp::INIT_SPACE,
        seeds = [STAMP_SEED, claim.key().as_ref()],
        bump
    )]
    pub approval_stamp: Account<'info, ApprovalStamp>,

    pub system_program: Program<'info, System>,
}

pub fn approve_claim_handler(ctx: Context<ApproveClaim>) -> Result<()> {
    let verifier = ctx.accounts.verifier.key();
    let idx = ctx
        .accounts
        .estate
        .verifier_index(&verifier)
        .ok_or(HeirloomError::NotVerifier)?;

    let estate = &ctx.accounts.estate;
    let claim = &mut ctx.accounts.claim;
    // While the owner is alive only the owner approves; trusted people decide after the unlock.
    require!(estate.status == EstateStatus::Unlocked, HeirloomError::BadStatus);
    require!(claim.status == ClaimStatus::Open, HeirloomError::BadStatus);
    require!(claim.agent_verdict.open_to_people(), HeirloomError::AgentNotApproved);
    let claimant = claim.beneficiary;
    let bit = 1u8 << idx;
    let eligible = estate.deciders(&claimant, claim.agent_verdict);
    require!(verifier != claimant || eligible & bit != 0, HeirloomError::OwnApproval);

    let claim_key = claim.key();
    let estate_key = estate.key();
    let stamp = &mut ctx.accounts.approval_stamp;
    let new_stamp = stamp.target == Pubkey::default();
    if !ApprovalStamp::votes_count((!new_stamp).then_some(&**stamp), claim, estate) {
        claim.approvals = 0;
        stamp.approved_at = 0;
    }
    if new_stamp {
        stamp.target = claim_key;
        stamp.bump = ctx.bumps.approval_stamp;
    }

    let was_met = approvals_stand(estate, claim);
    let first_time = claim.approvals & bit == 0;
    // Votes of seats that no longer decide are dropped, so whoever is left can restore a lost quorum (L8).
    claim.approvals &= eligible | DECIDED_ALONE;
    claim.approvals |= bit;
    if verifier == claimant {
        claim.approvals |= DECIDED_ALONE;
    }
    // The approval that reaches the quorum starts the objection window, again if the quorum had been lost.
    // Signing again only completes a quorum that has dropped since.
    let starts = approvals_stand(estate, claim) && (stamp.approved_at == 0 || !was_met);
    require!(first_time || starts, HeirloomError::AlreadyApproved);

    let ts = now()?;
    let count = count_bits(claim.approvals & eligible);
    if starts {
        stamp.seat_index = idx as u8;
        stamp.approver = verifier;
        stamp.approved_at = ts;
    } else if stamp.approved_at == 0 {
        stamp.seat_index = NO_SEAT;
        stamp.approver = verifier;
    }

    emit!(ClaimApproved {
        claim: claim_key,
        verifier,
        count,
        ts,
    });
    emit!(SeatApproval {
        estate: estate_key,
        seat_index: idx as u8,
        approver: verifier,
        kind: TargetKind::Claim,
        target: claim_key,
        ts,
    });
    Ok(())
}

// ====================================================================== execute_claim

#[derive(Accounts)]
pub struct ExecuteClaim<'info> {
    /// Anyone; pays the payee ATA rent if it doesn't exist yet.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    #[account(mut, has_one = estate)]
    pub rule: Box<Account<'info, Rule>>,

    #[account(mut, has_one = estate, has_one = rule)]
    pub claim: Box<Account<'info, Claim>>,

    /// CHECK: must equal claim.payee (the payee's wallet).
    #[account(address = claim.payee)]
    pub payee_wallet: UncheckedAccount<'info>,

    #[account(address = estate.usdt_mint @ HeirloomError::WrongMint)]
    pub usdt_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = usdt_mint,
        associated_token::authority = estate,
        associated_token::token_program = token_program
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdt_mint,
        associated_token::authority = payee_wallet,
        associated_token::token_program = token_program
    )]
    pub payee_usdt: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: the ["guard", estate] PDA; may not exist (then no window and no objections apply).
    #[account(seeds = [GUARD_SEED, estate.key().as_ref()], bump)]
    pub guard: UncheckedAccount<'info>,

    /// CHECK: the ["stamp", claim] PDA; may not exist. When the approvals were given (and, with a Guard, the window).
    #[account(seeds = [STAMP_SEED, claim.key().as_ref()], bump)]
    pub approval_stamp: UncheckedAccount<'info>,

    /// CHECK: the ["objection", claim] PDA; may not exist. Blocks while Open.
    #[account(seeds = [OBJECTION_SEED, claim.key().as_ref()], bump)]
    pub objection: UncheckedAccount<'info>,

    /// CHECK: the ["yearcap", rule] PDA; may not exist (the rule has no yearly cap). Updated when it does.
    #[account(mut, seeds = [YEAR_CAP_SEED, rule.key().as_ref()], bump)]
    pub year_cap: UncheckedAccount<'info>,

    /// The claimant's Beneficiary PDA; must still be active.
    #[account(
        has_one = estate @ HeirloomError::NotBeneficiary,
        constraint = beneficiary_account.wallet == claim.beneficiary @ HeirloomError::NotBeneficiary
    )]
    pub beneficiary_account: Box<Account<'info, Beneficiary>>,

    /// The Payee PDA of claim.payee; gone once removed.
    #[account(has_one = estate, constraint = payee_account.wallet == claim.payee @ HeirloomError::BadStatus)]
    pub payee_account: Box<Account<'info, Payee>>,
}

pub fn execute_claim_handler(ctx: Context<ExecuteClaim>) -> Result<()> {
    let estate = &ctx.accounts.estate;
    let rule = &ctx.accounts.rule;
    let claim = &ctx.accounts.claim;

    require!(rule_open_for(estate, rule), HeirloomError::BadStatus);
    require!(claim.status == ClaimStatus::Open, HeirloomError::BadStatus);
    require!(rule.is_current_claim(claim.id), HeirloomError::ClaimFromEndedRule);
    check_parties(rule, &ctx.accounts.beneficiary_account, &ctx.accounts.payee_account)?;
    require!(claim.agent_verdict.open_to_people(), HeirloomError::AgentNotApproved);
    // While the owner is alive (Active) only the owner can approve; after unlock the owner's
    // earlier approval or the verifier quorum counts.
    let stamp_info = ctx.accounts.approval_stamp.to_account_info();
    let stamp: Option<ApprovalStamp> = if account_exists(&stamp_info) { Some(read_account(&stamp_info)?) } else { None };
    let approved = claim.owner_approved
        || (estate.status == EstateStatus::Unlocked
            && ApprovalStamp::votes_count(stamp.as_ref(), claim, estate)
            && approvals_stand(estate, claim));
    require!(approved, HeirloomError::InsufficientApprovals);

    // Guardians: a monitor's open objection pauses the payment; with a Guard, a quorum approval
    // waits out the objection window (an owner approval while alive needs no window).
    require!(
        !objection_is_open(&ctx.accounts.objection.to_account_info(), &ctx.accounts.estate)?,
        HeirloomError::ObjectionOpen
    );
    let guard_info = ctx.accounts.guard.to_account_info();
    if account_exists(&guard_info) && !claim.owner_approved {
        let guard: Guard = read_account(&guard_info)?;
        let stamp = stamp.ok_or(HeirloomError::ObjectionWindowOpen)?;
        require!(stamp.approved_at > 0, HeirloomError::ObjectionWindowOpen);
        // A quorum the claimant reached alone gets twice the window.
        let times = if claim.approvals & DECIDED_ALONE != 0 { 2 } else { 1 };
        let window = guard.objection_window().saturating_mul(times);
        let mut open_until = stamp
            .approved_at
            .checked_add(window)
            .ok_or(HeirloomError::MathOverflow)?;
        // A dispute held the objection PDA, so the monitors get their window after it: after it lapsed, or after it
        // was resolved (a resolved dispute's raised_at is when it was resolved, H5).
        let objection_info = ctx.accounts.objection.to_account_info();
        if account_exists(&objection_info) {
            let o: Objection = read_account(&objection_info)?;
            if o.is_dispute() {
                let ended = if o.status == ObjectionStatus::Open { o.lapses_at(&ctx.accounts.estate) } else { o.raised_at };
                open_until = open_until.max(ended.saturating_add(window));
            }
        }
        require!(now()? >= open_until, HeirloomError::ObjectionWindowOpen);
    }

    // Re-check: other claims on this rule may have been paid since this one was submitted.
    let amount = claim.amount;
    let new_total = rule
        .spent_total
        .checked_add(amount)
        .ok_or(HeirloomError::MathOverflow)?;
    require!(new_total <= rule.lifetime_cap, HeirloomError::ExceedsLifetimeCap);
    let ts = now()?;
    require!(ts <= rule.valid_until, HeirloomError::RuleExpired);
    // Yearly cap: counted in the period the payment is made, and recorded.
    check_year_cap(&ctx.accounts.year_cap.to_account_info(), &rule.key(), amount, true)?;

    let owner = estate.owner;
    let bump = [estate.bump];
    let seeds: &[&[u8]] = &[ESTATE_SEED, owner.as_ref(), &bump];

    transfer_checked_cpi(
        ctx.accounts.token_program.key(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.usdt_mint.to_account_info(),
        ctx.accounts.payee_usdt.to_account_info(),
        ctx.accounts.estate.to_account_info(),
        amount,
        ctx.accounts.usdt_mint.decimals,
        &[seeds],
    )?;

    let estate_key = ctx.accounts.estate.key();
    let rule_key = ctx.accounts.rule.key();
    let claim_key = ctx.accounts.claim.key();
    let payee = ctx.accounts.claim.payee;

    ctx.accounts.rule.spent_total = new_total;
    ctx.accounts.claim.status = ClaimStatus::Paid;

    emit!(ClaimPaid {
        estate: estate_key,
        rule: rule_key,
        claim: claim_key,
        payee,
        amount,
        ts,
    });
    Ok(())
}

// ====================================================================== owner_approve_claim

#[derive(Accounts)]
pub struct OwnerApproveClaim<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(has_one = estate)]
    pub rule: Account<'info, Rule>,

    #[account(mut, has_one = estate, has_one = rule)]
    pub claim: Account<'info, Claim>,
}

/// Living plans: while alive, the owner approves claims on `starts_now` rules himself.
pub fn owner_approve_claim_handler(ctx: Context<OwnerApproveClaim>) -> Result<()> {
    require!(
        ctx.accounts.estate.status == EstateStatus::Active,
        HeirloomError::BadStatus
    );
    require!(ctx.accounts.rule.starts_now, HeirloomError::BadStatus);

    let claim = &mut ctx.accounts.claim;
    require!(claim.status == ClaimStatus::Open, HeirloomError::BadStatus);
    require!(claim.agent_verdict.open_to_people(), HeirloomError::AgentNotApproved);
    require!(ctx.accounts.rule.is_current_claim(claim.id), HeirloomError::ClaimFromEndedRule);
    require!(!claim.owner_approved, HeirloomError::AlreadyApproved);
    claim.owner_approved = true;

    emit!(ClaimOwnerApproved {
        claim: claim.key(),
        owner: ctx.accounts.owner.key(),
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== execute_scheduled

#[derive(Accounts)]
pub struct ExecuteScheduled<'info> {
    /// Anyone (a keeper/cron); pays the payee ATA rent if it doesn't exist yet.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub estate: Box<Account<'info, Estate>>,

    #[account(mut, has_one = estate)]
    pub rule: Box<Account<'info, Rule>>,

    /// CHECK: must equal rule.fixed_payee.
    #[account(address = rule.fixed_payee)]
    pub payee_wallet: UncheckedAccount<'info>,

    #[account(address = estate.usdt_mint @ HeirloomError::WrongMint)]
    pub usdt_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = usdt_mint,
        associated_token::authority = estate,
        associated_token::token_program = token_program
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdt_mint,
        associated_token::authority = payee_wallet,
        associated_token::token_program = token_program
    )]
    pub payee_usdt: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// CHECK: the ["yearcap", rule] PDA; may not exist (the rule has no yearly cap). Updated when it does.
    #[account(mut, seeds = [YEAR_CAP_SEED, rule.key().as_ref()], bump)]
    pub year_cap: UncheckedAccount<'info>,

    /// The rule's Beneficiary PDA; must still be active.
    #[account(
        has_one = estate @ HeirloomError::NotBeneficiary,
        constraint = beneficiary_account.wallet == rule.beneficiary @ HeirloomError::NotBeneficiary
    )]
    pub beneficiary_account: Box<Account<'info, Beneficiary>>,

    /// The Payee PDA of rule.fixed_payee; gone once removed.
    #[account(has_one = estate, constraint = payee_account.wallet == rule.fixed_payee @ HeirloomError::BadStatus)]
    pub payee_account: Box<Account<'info, Payee>>,
}

/// Pays one instalment of a recurring rule to its fixed payee once it is due.
pub fn execute_scheduled_handler(ctx: Context<ExecuteScheduled>) -> Result<()> {
    let estate = &ctx.accounts.estate;
    let rule = &ctx.accounts.rule;

    require!(rule.recurring_amount > 0, HeirloomError::BadStatus);
    require!(rule_open_for(estate, rule), HeirloomError::BadStatus);
    check_parties(rule, &ctx.accounts.beneficiary_account, &ctx.accounts.payee_account)?;
    let ts = now()?;
    require!(ts >= rule.next_due, HeirloomError::NotDue);
    require!(ts <= rule.valid_until, HeirloomError::RuleExpired);

    let amount = rule.recurring_amount;
    let new_total = rule
        .spent_total
        .checked_add(amount)
        .ok_or(HeirloomError::MathOverflow)?;
    require!(new_total <= rule.lifetime_cap, HeirloomError::ExceedsLifetimeCap);
    // Yearly cap: an instalment over it waits (next_due unchanged) until the next period.
    check_year_cap(&ctx.accounts.year_cap.to_account_info(), &rule.key(), amount, true)?;
    // One instalment, then the next date on the schedule after now: missed dates never pay out together
    // (that money stays inside the lifetime cap for later dates).
    let periods = ts
        .checked_sub(rule.next_due)
        .and_then(|late| late.checked_div(rule.interval_secs))
        .and_then(|n| n.checked_add(1))
        .ok_or(HeirloomError::MathOverflow)?;
    let next_due = periods
        .checked_mul(rule.interval_secs)
        .and_then(|d| rule.next_due.checked_add(d))
        .ok_or(HeirloomError::MathOverflow)?;

    let owner = estate.owner;
    let bump = [estate.bump];
    let seeds: &[&[u8]] = &[ESTATE_SEED, owner.as_ref(), &bump];

    transfer_checked_cpi(
        ctx.accounts.token_program.key(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.usdt_mint.to_account_info(),
        ctx.accounts.payee_usdt.to_account_info(),
        ctx.accounts.estate.to_account_info(),
        amount,
        ctx.accounts.usdt_mint.decimals,
        &[seeds],
    )?;

    let estate_key = ctx.accounts.estate.key();
    let rule_key = ctx.accounts.rule.key();
    let payee = ctx.accounts.payee_wallet.key();
    let rule = &mut ctx.accounts.rule;
    rule.spent_total = new_total;
    rule.next_due = next_due;

    emit!(ScheduledPaid {
        estate: estate_key,
        rule: rule_key,
        payee,
        amount,
        next_due,
        ts,
    });
    Ok(())
}
