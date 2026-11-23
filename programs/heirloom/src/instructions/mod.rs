pub mod caps;
pub mod claims;
pub mod continuity;
pub mod death;
pub mod disputes;
pub mod guardians;
pub mod sale;
pub mod setup;

pub use caps::*;
pub use claims::*;
pub use continuity::*;
pub use death::*;
pub use disputes::*;
pub use guardians::*;
pub use sale::*;
pub use setup::*;

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, get_associated_token_address, Create};
use anchor_spl::token::{self, CloseAccount, TokenAccount, TransferChecked};

use crate::errors::HeirloomError;
use crate::events::DeathVetoed;
use crate::state::{Estate, EstateStatus, Objection};

/// A new report takes the place of the one a challenge was raised against (M7): the challenge, and any votes on
/// it, read as lapsed from now on. `info` is the `["objection", target]` PDA (address checked by the caller).
pub(crate) fn void_objection(info: &AccountInfo) -> Result<()> {
    if !account_exists(info) {
        return Ok(());
    }
    let mut o: Objection = read_account(info)?;
    if o.raised_at != 0 {
        o.raised_at = 0;
        write_account(info, &o)?;
    }
    Ok(())
}

pub(crate) fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// Number of set bits in an approval bitmap.
pub(crate) fn count_bits(bitmap: u8) -> u8 {
    bitmap.count_ones() as u8
}

/// The owner signed in person: they are alive, so any death claim is void and the estate is Active again.
pub(crate) fn record_proof_of_life(key: Pubkey, estate: &mut Estate, ts: i64) {
    estate.last_heartbeat = ts;
    if estate.death_cert_hash != [0u8; 32] || estate.status == EstateStatus::DeathPending {
        estate.clear_death_claim();
        estate.status = EstateStatus::Active;
        emit!(DeathVetoed { estate: key, ts });
    }
}

/// `transfer_checked` CPI. Pass `&[]` as `signer_seeds` when the authority signs the transaction.
pub(crate) fn transfer_checked_cpi<'info>(
    token_program: Pubkey,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let accounts = TransferChecked {
        from,
        mint,
        to,
        authority,
    };
    token::transfer_checked(
        CpiContext::new_with_signer(token_program, accounts, signer_seeds),
        amount,
        decimals,
    )
}

/// The token account a payment goes to: `authority`'s canonical ATA, created here if missing, or any existing
/// token account of `mint` that `authority` owns. A recipient who moved their ATA to someone else can't block a
/// payment that others are owed after them (L2): pass another account they own.
pub(crate) fn ready_token_account<'info>(
    payer: AccountInfo<'info>,
    account: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    ata_program: AccountInfo<'info>,
) -> Result<()> {
    if account.data_is_empty() {
        require_keys_eq!(account.key(), get_associated_token_address(authority.key, mint.key), HeirloomError::WrongMint);
        let accounts = Create {
            payer,
            associated_token: account,
            authority,
            mint,
            system_program,
            token_program,
        };
        return associated_token::create(CpiContext::new(ata_program.key(), accounts));
    }
    require_keys_eq!(*account.owner, token::ID, HeirloomError::WrongMint);
    let held = TokenAccount::try_deserialize(&mut &account.try_borrow_data()?[..])?;
    require!(held.mint == mint.key() && held.owner == authority.key(), HeirloomError::WrongMint);
    Ok(())
}

/// `close_account` CPI signed by a PDA; the rent goes to `destination`.
pub(crate) fn close_token_account_cpi<'info>(
    token_program: Pubkey,
    account: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let accounts = CloseAccount {
        account,
        destination,
        authority,
    };
    token::close_account(CpiContext::new_with_signer(token_program, accounts, signer_seeds))
}

/// Closes an account of this program: the rent goes to `destination`.
pub(crate) fn close_program_account(info: &AccountInfo, destination: &AccountInfo) -> Result<()> {
    let total = destination.lamports().checked_add(info.lamports()).ok_or(HeirloomError::MathOverflow)?;
    **destination.try_borrow_mut_lamports()? = total;
    **info.try_borrow_mut_lamports()? = 0;
    info.assign(&anchor_lang::system_program::ID);
    info.resize(0)?;
    Ok(())
}

/// True if `info` holds an initialised account of this program (used for PDAs passed unchecked,
/// e.g. the Guard, ApprovalStamp and Objection, which may not exist).
pub(crate) fn account_exists(info: &AccountInfo) -> bool {
    info.owner == &crate::ID && info.data_len() > 0 && info.lamports() > 0
}

/// Reads a program account passed as an UncheckedAccount (owner + discriminator checked).
pub(crate) fn read_account<T: AccountDeserialize>(info: &AccountInfo) -> Result<T> {
    require!(account_exists(info), HeirloomError::BadStatus);
    let data = info.try_borrow_data()?;
    T::try_deserialize(&mut &data[..])
}

/// Writes back a program account read with `read_account`.
pub(crate) fn write_account<T: AccountSerialize>(info: &AccountInfo, value: &T) -> Result<()> {
    require!(info.owner == &crate::ID && info.is_writable, HeirloomError::BadStatus);
    let mut data = info.try_borrow_mut_data()?;
    let mut writer: &mut [u8] = &mut data[..];
    value.try_serialize(&mut writer)
}

/// The `["objection", target]` PDA (address already checked by a seeds constraint) is Open and binding.
/// An account that does not exist yet counts as "no objection"; a dispute past its lapse time counts as
/// dismissed (disputes never lock funds forever).
pub(crate) fn objection_is_open(info: &AccountInfo, estate: &Estate) -> Result<bool> {
    if !account_exists(info) {
        return Ok(false);
    }
    let o: Objection = read_account(info)?;
    Ok(o.is_effectively_open(estate, now()?))
}
