//! Setup phase: the owner creates and configures the estate while alive.
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::{
    account_exists, close_program_account, close_token_account_cpi, now, record_proof_of_life, transfer_checked_cpi,
};
use crate::errors::HeirloomError;
use crate::events::*;
use crate::state::*;

// ====================================================================== create_estate

#[derive(Accounts)]
pub struct CreateEstate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + Estate::INIT_SPACE,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump
    )]
    pub estate: Box<Account<'info, Estate>>,

    pub usdt_mint: Box<Account<'info, Mint>>,

    /// USD₮ vault = ATA(usdt_mint, estate). init_if_needed so a pre-created ATA can't block setup.
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = usdt_mint,
        associated_token::authority = estate,
        associated_token::token_program = token_program
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_estate_handler(
    ctx: Context<CreateEstate>,
    agent: Pubkey,
    verifiers: [Pubkey; 3],
    death_threshold: u8,
    claim_threshold: u8,
    hardship_threshold: u8,
    waiting_period_secs: i64,
) -> Result<()> {
    let owner = ctx.accounts.owner.key();

    for t in [death_threshold, claim_threshold, hardship_threshold] {
        require!((1..=3).contains(&t), HeirloomError::InvalidThreshold);
    }
    require!(
        (MIN_WAITING_SECS..=MAX_WAITING_SECS).contains(&waiting_period_secs),
        HeirloomError::TimeOutOfRange
    );
    Estate::check_death_settings(death_threshold, waiting_period_secs)?;

    for i in 0..VERIFIER_COUNT {
        require!(verifiers[i] != Pubkey::default(), HeirloomError::InvalidWallet);
        require!(verifiers[i] != owner, HeirloomError::DuplicateVerifier);
        for j in (i + 1)..VERIFIER_COUNT {
            require!(verifiers[i] != verifiers[j], HeirloomError::DuplicateVerifier);
        }
    }
    require!(
        agent != Pubkey::default() && agent != owner && !verifiers.contains(&agent),
        HeirloomError::BadAgent
    );

    let ts = now()?;
    let usdt_mint = ctx.accounts.usdt_mint.key();
    let bump = ctx.bumps.estate;

    ctx.accounts.estate.set_inner(Estate {
        owner,
        agent,
        usdt_mint,
        verifiers,
        death_threshold,
        claim_threshold,
        hardship_threshold,
        waiting_period_secs,
        status: EstateStatus::Active,
        will_hash: [0u8; 32],
        will_uri: String::new(),
        death_cert_hash: [0u8; 32],
        death_submitted_by: Pubkey::default(),
        death_verdict: Verdict::Pending,
        death_attestations: 0,
        death_pending_since: 0,
        last_heartbeat: ts,
        rule_count: 0,
        bump,
    });

    emit!(EstateCreated {
        estate: ctx.accounts.estate.key(),
        owner,
        agent,
        usdt_mint,
        ts,
    });
    Ok(())
}

// ====================================================================== set_will

#[derive(Accounts)]
pub struct SetWill<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,
}

pub fn set_will_handler(ctx: Context<SetWill>, will_hash: [u8; 32], will_uri: String) -> Result<()> {
    require!(will_uri.len() <= MAX_WILL_URI_LEN, HeirloomError::StringTooLong);
    let estate = &mut ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);

    estate.will_hash = will_hash;
    estate.will_uri = will_uri;

    emit!(WillSet {
        estate: estate.key(),
        will_hash,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== add_beneficiary

#[derive(Accounts)]
pub struct AddBeneficiary<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    /// CHECK: any wallet; only its key is stored.
    pub wallet: UncheckedAccount<'info>,

    /// New, or one the owner removed and now adds again.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Beneficiary::INIT_SPACE,
        seeds = [BENEFICIARY_SEED, estate.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub beneficiary: Account<'info, Beneficiary>,

    pub system_program: Program<'info, System>,
}

pub fn add_beneficiary_handler(ctx: Context<AddBeneficiary>, label: String) -> Result<()> {
    require!(label.len() <= MAX_LABEL_LEN, HeirloomError::StringTooLong);
    require!(
        ctx.accounts.estate.status == EstateStatus::Active,
        HeirloomError::BadStatus
    );

    let existing = &ctx.accounts.beneficiary;
    require!(existing.estate == Pubkey::default() || !existing.active, HeirloomError::BadStatus);

    let estate = ctx.accounts.estate.key();
    let wallet = ctx.accounts.wallet.key();
    let bump = ctx.bumps.beneficiary;
    ctx.accounts.beneficiary.set_inner(Beneficiary {
        estate,
        wallet,
        label,
        active: true,
        bump,
    });
    Ok(())
}

// ====================================================================== add_payee

#[derive(Accounts)]
pub struct AddPayee<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,

    /// CHECK: the institution's wallet; only its key is stored.
    pub wallet: UncheckedAccount<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + Payee::INIT_SPACE,
        seeds = [PAYEE_SEED, estate.key().as_ref(), wallet.key().as_ref()],
        bump
    )]
    pub payee: Account<'info, Payee>,

    pub system_program: Program<'info, System>,
}

pub fn add_payee_handler(ctx: Context<AddPayee>, kind: PayeeKind, name: String) -> Result<()> {
    require!(name.len() <= MAX_PAYEE_NAME_LEN, HeirloomError::StringTooLong);
    require!(
        ctx.accounts.estate.status == EstateStatus::Active,
        HeirloomError::BadStatus
    );

    let estate = ctx.accounts.estate.key();
    let wallet = ctx.accounts.wallet.key();
    let bump = ctx.bumps.payee;
    ctx.accounts.payee.set_inner(Payee {
        estate,
        wallet,
        kind,
        name,
        bump,
    });
    Ok(())
}

// ====================================================================== add_rule

#[derive(Accounts)]
#[instruction(rule_id: u16)]
pub struct AddRule<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Box<Account<'info, Estate>>,

    /// The Beneficiary PDA the rule is for.
    #[account(has_one = estate @ HeirloomError::NotBeneficiary)]
    pub beneficiary: Box<Account<'info, Beneficiary>>,

    /// `rule_id` = estate.rule_count for a new slot, or the id of an ended rule whose slot is reused.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Rule::INIT_SPACE,
        seeds = [RULE_SEED, estate.key().as_ref(), &rule_id.to_le_bytes()],
        bump
    )]
    pub rule: Box<Account<'info, Rule>>,

    /// Payee PDA for a recurring rule (scheduled payments go to its wallet). Optional: pass the
    /// program id (Anchor's "None") when `recurring_amount == 0`.
    #[account(has_one = estate)]
    pub payee: Option<Box<Account<'info, Payee>>>,

    pub system_program: Program<'info, System>,

    /// CHECK: the ["yearcap", rule] PDA; may not exist. The ended rule's is closed to the owner on reuse.
    #[account(mut, seeds = [YEAR_CAP_SEED, rule.key().as_ref()], bump)]
    pub year_cap: UncheckedAccount<'info>,
}

pub fn add_rule_handler(
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
    require!(
        ctx.accounts.estate.status == EstateStatus::Active,
        HeirloomError::BadStatus
    );
    require!(ctx.accounts.beneficiary.active, HeirloomError::NotBeneficiary);
    let ts = now()?;
    let slot = &ctx.accounts.rule;
    let new_slot = slot.estate == Pubkey::default();
    let first_claim_id = if new_slot {
        let count = ctx.accounts.estate.rule_count;
        require!(rule_id == count, HeirloomError::BadStatus);
        require!(count < MAX_RULES, HeirloomError::TooManyRules);
        0
    } else {
        // Only an ended rule gives up its slot: a live one's cap still matters.
        require!(ts > slot.valid_until, HeirloomError::BadStatus);
        slot.next_generation_start().ok_or(HeirloomError::MathOverflow)?
    };
    require!(
        max_per_claim > 0 && lifetime_cap > 0 && max_per_claim <= lifetime_cap,
        HeirloomError::InvalidAmount
    );

    require!(valid_until > ts, HeirloomError::TimeOutOfRange);

    let (interval_secs, next_due, fixed_payee) = if recurring_amount > 0 {
        require!(interval_secs > 0, HeirloomError::InvalidAmount);
        require!(
            interval_secs <= MAX_INTERVAL_SECS && first_due >= 0,
            HeirloomError::TimeOutOfRange
        );
        require!(recurring_amount <= max_per_claim, HeirloomError::ExceedsPerClaimCap);
        let payee = ctx
            .accounts
            .payee
            .as_ref()
            .ok_or(HeirloomError::PayeeRequired)?;
        require!(payee.kind == allowed_payee_kind, HeirloomError::WrongPayeeKind);
        (interval_secs, first_due, payee.wallet)
    } else {
        (0, 0, Pubkey::default())
    };

    let estate_key = ctx.accounts.estate.key();
    let beneficiary = ctx.accounts.beneficiary.wallet;
    let bump = ctx.bumps.rule;

    ctx.accounts.rule.set_inner(Rule {
        estate: estate_key,
        id: rule_id,
        beneficiary,
        category,
        allowed_payee_kind,
        max_per_claim,
        lifetime_cap,
        spent_total: 0,
        valid_until,
        claim_count: first_claim_id,
        starts_now,
        recurring_amount,
        interval_secs,
        next_due,
        fixed_payee,
        bump,
    });

    if new_slot {
        ctx.accounts.estate.rule_count = rule_id.checked_add(1).ok_or(HeirloomError::MathOverflow)?;
    } else {
        let year_cap = ctx.accounts.year_cap.to_account_info();
        if account_exists(&year_cap) {
            close_program_account(&year_cap, &ctx.accounts.owner.to_account_info())?;
        }
        emit!(RuleReused { estate: estate_key, rule: ctx.accounts.rule.key(), first_claim_id, ts });
    }
    Ok(())
}

// ====================================================================== deposit

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Box<Account<'info, Estate>>,

    #[account(address = estate.usdt_mint @ HeirloomError::WrongMint)]
    pub usdt_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = owner_usdt.mint == estate.usdt_mint @ HeirloomError::WrongMint,
        constraint = owner_usdt.owner == owner.key() @ HeirloomError::NotOwner
    )]
    pub owner_usdt: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdt_mint,
        associated_token::authority = estate,
        associated_token::token_program = token_program
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

pub fn deposit_handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, HeirloomError::InvalidAmount);
    require!(
        ctx.accounts.estate.status == EstateStatus::Active,
        HeirloomError::BadStatus
    );

    transfer_checked_cpi(
        ctx.accounts.token_program.key(),
        ctx.accounts.owner_usdt.to_account_info(),
        ctx.accounts.usdt_mint.to_account_info(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        amount,
        ctx.accounts.usdt_mint.decimals,
        &[],
    )
}

// ====================================================================== withdraw

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,

    /// Writable: a withdrawal is proof of life (P2).
    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Box<Account<'info, Estate>>,

    #[account(address = estate.usdt_mint @ HeirloomError::WrongMint)]
    pub usdt_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = owner_usdt.mint == estate.usdt_mint @ HeirloomError::WrongMint,
        constraint = owner_usdt.owner == owner.key() @ HeirloomError::NotOwner
    )]
    pub owner_usdt: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdt_mint,
        associated_token::authority = estate,
        associated_token::token_program = token_program
    )]
    pub vault: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Owner, estate Active or DeathPending: takes USD₮ back. Only the living owner can sign it, so like heartbeat it is
/// proof of life: it records the check-in and voids a pending death claim (P2).
pub fn withdraw_handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, HeirloomError::InvalidAmount);
    let estate = &mut ctx.accounts.estate;
    require!(
        estate.status == EstateStatus::Active || estate.status == EstateStatus::DeathPending,
        HeirloomError::BadStatus
    );
    record_proof_of_life(estate.key(), estate, now()?);

    let owner = estate.owner;
    let bump = [estate.bump];
    let seeds: &[&[u8]] = &[ESTATE_SEED, owner.as_ref(), &bump];

    transfer_checked_cpi(
        ctx.accounts.token_program.key(),
        ctx.accounts.vault.to_account_info(),
        ctx.accounts.usdt_mint.to_account_info(),
        ctx.accounts.owner_usdt.to_account_info(),
        ctx.accounts.estate.to_account_info(),
        amount,
        ctx.accounts.usdt_mint.decimals,
        &[seeds],
    )
}

// ====================================================================== heartbeat

#[derive(Accounts)]
pub struct Heartbeat<'info> {
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Account<'info, Estate>,
}

pub fn heartbeat_handler(ctx: Context<Heartbeat>) -> Result<()> {
    let estate = &mut ctx.accounts.estate;
    require!(
        estate.status == EstateStatus::Active || estate.status == EstateStatus::DeathPending,
        HeirloomError::BadStatus
    );
    record_proof_of_life(estate.key(), estate, now()?);
    Ok(())
}

// ====================================================================== register_asset

#[derive(Accounts)]
pub struct RegisterAsset<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Box<Account<'info, Estate>>,

    /// A title: one of a kind, and nobody can mint another or freeze it.
    #[account(constraint = nft_mint.decimals == 0
        && nft_mint.supply == 1
        && nft_mint.mint_authority.is_none()
        && nft_mint.freeze_authority.is_none() @ HeirloomError::InvalidNft)]
    pub nft_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        constraint = owner_nft.mint == nft_mint.key() @ HeirloomError::InvalidNft,
        constraint = owner_nft.owner == owner.key() @ HeirloomError::NotOwner
    )]
    pub owner_nft: Box<Account<'info, TokenAccount>>,

    /// NFT escrow = ATA(nft_mint, estate).
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = nft_mint,
        associated_token::authority = estate,
        associated_token::token_program = token_program
    )]
    pub nft_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = owner,
        space = 8 + Asset::INIT_SPACE,
        seeds = [ASSET_SEED, estate.key().as_ref(), nft_mint.key().as_ref()],
        bump
    )]
    pub asset: Box<Account<'info, Asset>>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn register_asset_handler(
    ctx: Context<RegisterAsset>,
    floor_price: u64,
    hardship_floor: u64,
    asking_price: u64,
    proceeds_to: Pubkey,
    doc_hash: [u8; 32],
) -> Result<()> {
    require!(
        ctx.accounts.estate.status == EstateStatus::Active,
        HeirloomError::BadStatus
    );
    require!(
        hardship_floor > 0 && floor_price >= hardship_floor && asking_price >= floor_price,
        HeirloomError::InvalidAmount
    );
    // The estate itself is a real destination: the sale then pays into the vault.
    require!(proceeds_to != Pubkey::default(), HeirloomError::InvalidWallet);

    transfer_checked_cpi(
        ctx.accounts.token_program.key(),
        ctx.accounts.owner_nft.to_account_info(),
        ctx.accounts.nft_mint.to_account_info(),
        ctx.accounts.nft_escrow.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        1,
        0,
        &[],
    )?;

    let estate = ctx.accounts.estate.key();
    let nft_mint = ctx.accounts.nft_mint.key();
    let bump = ctx.bumps.asset;
    ctx.accounts.asset.set_inner(Asset {
        estate,
        nft_mint,
        floor_price,
        hardship_floor,
        asking_price,
        proceeds_to,
        status: AssetStatus::Held,
        listing_ends: 0,
        doc_hash,
        hardship_beneficiary: None,
        bump,
    });

    emit!(AssetRegistered {
        estate,
        asset: ctx.accounts.asset.key(),
        nft_mint,
        floor_price,
        hardship_floor,
        asking_price,
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== release_asset

#[derive(Accounts)]
pub struct ReleaseAsset<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Box<Account<'info, Estate>>,

    /// Closed to the owner, so the same title can be registered again.
    #[account(mut, has_one = estate, has_one = nft_mint @ HeirloomError::InvalidNft, close = owner)]
    pub asset: Box<Account<'info, Asset>>,

    pub nft_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = estate,
        associated_token::token_program = token_program
    )]
    pub nft_escrow: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = owner_nft.mint == nft_mint.key() @ HeirloomError::InvalidNft,
        constraint = owner_nft.owner == owner.key() @ HeirloomError::NotOwner
    )]
    pub owner_nft: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

/// Owner, estate Active, asset Held: the living owner takes the title back.
pub fn release_asset_handler(ctx: Context<ReleaseAsset>) -> Result<()> {
    let estate = &ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    require!(ctx.accounts.asset.status == AssetStatus::Held, HeirloomError::BadStatus);

    let (owner, bump) = (estate.owner, [estate.bump]);
    let seeds: &[&[u8]] = &[ESTATE_SEED, owner.as_ref(), &bump];
    let token_program = ctx.accounts.token_program.key();
    // Everything in the escrow, so the close can't fail.
    transfer_checked_cpi(
        token_program,
        ctx.accounts.nft_escrow.to_account_info(),
        ctx.accounts.nft_mint.to_account_info(),
        ctx.accounts.owner_nft.to_account_info(),
        ctx.accounts.estate.to_account_info(),
        ctx.accounts.nft_escrow.amount,
        ctx.accounts.nft_mint.decimals,
        &[seeds],
    )?;
    close_token_account_cpi(
        token_program,
        ctx.accounts.nft_escrow.to_account_info(),
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.estate.to_account_info(),
        &[seeds],
    )?;

    emit!(AssetReleased {
        estate: ctx.accounts.estate.key(),
        asset: ctx.accounts.asset.key(),
        nft_mint: ctx.accounts.nft_mint.key(),
        ts: now()?,
    });
    Ok(())
}

// ====================================================================== remove_member

#[derive(Accounts)]
pub struct RemoveMember<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ESTATE_SEED, owner.key().as_ref()],
        bump = estate.bump,
        has_one = owner @ HeirloomError::NotOwner
    )]
    pub estate: Box<Account<'info, Estate>>,

    /// The Beneficiary to remove (marked inactive; add_beneficiary brings them back), or None.
    #[account(mut, has_one = estate @ HeirloomError::NotBeneficiary)]
    pub beneficiary_account: Option<Box<Account<'info, Beneficiary>>>,

    /// The Payee to remove (closed to the owner; add_payee brings it back), or None.
    #[account(mut, has_one = estate, close = owner)]
    pub payee_account: Option<Box<Account<'info, Payee>>>,

    /// CHECK: the Seat PDA ["seat", estate, [0]]; may not exist. A seat death confirmed by the removed beneficiary
    /// gives way.
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[0u8]], bump)]
    pub seat0: UncheckedAccount<'info>,
    /// CHECK: as seat0, index 1.
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[1u8]], bump)]
    pub seat1: UncheckedAccount<'info>,
    /// CHECK: as seat0, index 2.
    #[account(mut, seeds = [SEAT_SEED, estate.key().as_ref(), &[2u8]], bump)]
    pub seat2: UncheckedAccount<'info>,
}

/// Owner, estate Active: removes a beneficiary, a payee or both. Every payout checks both, so their open claims
/// and schedules stop. Like replacing a trusted person it is proof of life: it clears a death claim.
pub fn remove_member_handler(ctx: Context<RemoveMember>) -> Result<()> {
    let estate = &mut ctx.accounts.estate;
    require!(estate.status == EstateStatus::Active, HeirloomError::BadStatus);
    let (estate_key, ts) = (estate.key(), now()?);
    require!(
        ctx.accounts.beneficiary_account.is_some() || ctx.accounts.payee_account.is_some(),
        HeirloomError::BadStatus
    );
    if let Some(beneficiary) = ctx.accounts.beneficiary_account.as_mut() {
        require!(beneficiary.active, HeirloomError::NotBeneficiary);
        beneficiary.active = false;
        emit!(MemberRemoved { estate: estate_key, wallet: beneficiary.wallet, payee: false, ts });
        let seats = [
            ctx.accounts.seat0.to_account_info(),
            ctx.accounts.seat1.to_account_info(),
            ctx.accounts.seat2.to_account_info(),
        ];
        super::guardians::release_confirmations(estate, &seats, Some(&beneficiary.wallet))?;
    }
    if let Some(payee) = ctx.accounts.payee_account.as_ref() {
        emit!(MemberRemoved { estate: estate_key, wallet: payee.wallet, payee: true, ts });
    }
    record_proof_of_life(estate_key, estate, ts);
    Ok(())
}
