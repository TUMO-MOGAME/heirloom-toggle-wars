//! Yearly caps (added 2026-11-15): an optional cap per 365-day period on a rule, on top of the
//! per-claim and lifetime caps (e.g. school fees up to N USD₮ a year). Stored in a new
//! `["yearcap", rule]` account, so no existing layout changes. Enforced in submit_claim,
//! execute_claim and execute_scheduled.
use anchor_lang::prelude::*;

use super::{account_exists, now, read_account, write_account};
use crate::errors::HeirloomError;
use crate::events::*;
use crate::state::*;

/// Checks that paying `amount` under the rule stays within its yearly cap, if the rule has one.
/// `info` is the `["yearcap", rule]` PDA (address checked by a seeds constraint); a missing account
/// means "no yearly cap". With `record`, the payment is added to the current period's spend.
pub(crate) fn check_year_cap(info: &AccountInfo, rule: &Pubkey, amount: u64, record: bool) -> Result<()> {
    if !account_exists(info) {
        return Ok(());
    }
    let mut yc: YearCap = read_account(info)?;
    require_keys_eq!(yc.rule, *rule, HeirloomError::BadStatus);
    let (start, spent) = yc.current(now()?);
    let new_spent = spent.checked_add(amount).ok_or(HeirloomError::MathOverflow)?;
    require!(new_spent <= yc.cap, HeirloomError::ExceedsYearlyCap);
    if record {
        yc.period_start = start;
        yc.period_spent = new_spent;
        write_account(info, &yc)?;
    }
    Ok(())
}

// ====================================================================== set_yearly_cap

#[derive(Accounts)]
pub struct SetYearlyCap<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    #[account(has_one = estate)]
    pub rule: Account<'info, Rule>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + YearCap::INIT_SPACE,
        seeds = [YEAR_CAP_SEED, rule.key().as_ref()],
        bump
    )]
    pub year_cap: Account<'info, YearCap>,

    pub system_program: Program<'info, System>,
}

/// Owner, estate Active. `cap` > 0, ≤ the lifetime cap and ≥ the scheduled amount (InvalidAmount).
/// `period_start` (unix secs, ≤ now) starts the first period, e.g. 1 January; 0 = now for a new cap
/// and "keep the current period" for an existing one. Spending already recorded is kept.
pub fn set_yearly_cap_handler(ctx: Context<SetYearlyCap>, cap: u64, period_start: i64) -> Result<()> {
    require!(
        ctx.accounts.estate.status == EstateStatus::Active,
        HeirloomError::BadStatus
    );
    let rule = &ctx.accounts.rule;
    require!(
        cap > 0 && cap <= rule.lifetime_cap && cap >= rule.recurring_amount,
        HeirloomError::InvalidAmount
    );
    let ts = now()?;
    require!(period_start >= 0 && period_start <= ts, HeirloomError::InvalidAmount);

    let rule_key = rule.key();
    let yc = &mut ctx.accounts.year_cap;
    let is_new = yc.rule == Pubkey::default();
    if is_new {
        yc.rule = rule_key;
        yc.period_spent = 0;
        yc.bump = ctx.bumps.year_cap;
        yc.period_start = if period_start == 0 { ts } else { period_start };
    } else if period_start != 0 {
        yc.period_start = period_start;
    }
    yc.cap = cap;

    emit!(YearlyCapSet {
        estate: ctx.accounts.estate.key(),
        rule: rule_key,
        cap,
        period_start: yc.period_start,
        ts,
    });
    Ok(())
}
