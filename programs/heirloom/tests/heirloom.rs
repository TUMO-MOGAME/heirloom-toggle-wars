//! LiteSVM tests for the Heirloom program. Run `anchor build` first (loads target/deploy/heirloom.so),
//! then `cargo test -p heirloom`.
//!
//! SPL mint and token accounts are written straight into the SVM with `set_account` (hand-packed
//! SPL Token layouts), so the tests don't depend on spl-token client crates.

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::instruction::Instruction,
    AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas,
};
use heirloom::{
    AssetStatus, ClaimStatus, Estate, EstateStatus, HeirloomError, PayeeKind, Category, Rule, Claim,
    Asset, AssetKind, AssetMedia, ApprovalStamp, Guard, HardshipStatus, Hardship, Objection,
    ObjectionStatus, ReviewOutcome, Seat, TargetKind, Verdict, YearCap, FallbackReport, Beneficiary, Payee,
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use anchor_lang::solana_program::instruction::AccountMeta;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const USDT: u64 = 1_000_000; // 6 decimals
const WAITING: i64 = 120; // demo waiting period (2 minutes)
const DAY: i64 = 86_400;
/// A realistic clock: LiteSVM starts at 0, which would read as "never" in the stored times.
const GENESIS: i64 = 1_790_000_000;

thread_local! {
    /// Compute units of the last successful `send` of this test.
    static LAST_CU: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn last_cu() -> u64 {
    LAST_CU.with(|c| c.get())
}

// ---------------------------------------------------------------- program ids

fn token_program() -> Pubkey {
    anchor_spl::token::ID
}
fn ata_program() -> Pubkey {
    anchor_spl::associated_token::ID
}
fn system_program() -> Pubkey {
    anchor_lang::system_program::ID
}

// ---------------------------------------------------------------- PDAs

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &heirloom::id()).0
}
fn estate_pda(owner: &Pubkey) -> Pubkey {
    pda(&[b"estate", owner.as_ref()])
}
fn beneficiary_pda(estate: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[b"beneficiary", estate.as_ref(), wallet.as_ref()])
}
fn payee_pda(estate: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[b"payee", estate.as_ref(), wallet.as_ref()])
}
fn rule_pda(estate: &Pubkey, id: u16) -> Pubkey {
    pda(&[b"rule", estate.as_ref(), &id.to_le_bytes()])
}
fn claim_pda(rule: &Pubkey, id: u32) -> Pubkey {
    pda(&[b"claim", rule.as_ref(), &id.to_le_bytes()])
}
fn asset_pda(estate: &Pubkey, nft_mint: &Pubkey) -> Pubkey {
    pda(&[b"asset", estate.as_ref(), nft_mint.as_ref()])
}
fn offer_pda(asset: &Pubkey, buyer: &Pubkey) -> Pubkey {
    pda(&[b"offer", asset.as_ref(), buyer.as_ref()])
}
fn hardship_pda(asset: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[b"hardship", asset.as_ref(), wallet.as_ref()])
}
fn guard_pda(estate: &Pubkey) -> Pubkey {
    pda(&[b"guard", estate.as_ref()])
}
fn seat_pda(estate: &Pubkey, index: u8) -> Pubkey {
    pda(&[b"seat", estate.as_ref(), &[index]])
}
fn stamp_pda(target: &Pubkey) -> Pubkey {
    pda(&[b"stamp", target.as_ref()])
}
fn objection_pda(target: &Pubkey) -> Pubkey {
    pda(&[b"objection", target.as_ref()])
}
fn media_pda(asset: &Pubkey) -> Pubkey {
    pda(&[b"media", asset.as_ref()])
}
fn fallback_report_pda(estate: &Pubkey, index: u8) -> Pubkey {
    pda(&[b"fallbackreport", estate.as_ref(), &[index]])
}
fn year_cap_pda(rule: &Pubkey) -> Pubkey {
    pda(&[b"yearcap", rule.as_ref()])
}
fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program().as_ref(), mint.as_ref()],
        &ata_program(),
    )
    .0
}

// ---------------------------------------------------------------- raw SPL Token state

fn pack_mint(authority: &Pubkey, supply: u64, decimals: u8) -> Vec<u8> {
    let mut d = Vec::with_capacity(82);
    d.extend_from_slice(&1u32.to_le_bytes()); // mint_authority: Some
    d.extend_from_slice(authority.as_ref());
    d.extend_from_slice(&supply.to_le_bytes());
    d.push(decimals);
    d.push(1); // is_initialized
    d.extend_from_slice(&0u32.to_le_bytes()); // freeze_authority: None
    d.extend_from_slice(&[0u8; 32]);
    assert_eq!(d.len(), 82);
    d
}

fn pack_token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(165);
    d.extend_from_slice(mint.as_ref());
    d.extend_from_slice(owner.as_ref());
    d.extend_from_slice(&amount.to_le_bytes());
    d.extend_from_slice(&0u32.to_le_bytes()); // delegate: None
    d.extend_from_slice(&[0u8; 32]);
    d.push(1); // state: Initialized
    d.extend_from_slice(&0u32.to_le_bytes()); // is_native: None
    d.extend_from_slice(&0u64.to_le_bytes());
    d.extend_from_slice(&0u64.to_le_bytes()); // delegated_amount
    d.extend_from_slice(&0u32.to_le_bytes()); // close_authority: None
    d.extend_from_slice(&[0u8; 32]);
    assert_eq!(d.len(), 165);
    d
}

fn set_token_state(svm: &mut LiteSVM, address: Pubkey, data: Vec<u8>) {
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
        address,
        Account {
            lamports,
            data,
            owner: token_program(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

/// A digital title: one of a kind, with no mint or freeze authority.
fn create_title(svm: &mut LiteSVM) -> Pubkey {
    let mint = Keypair::new().pubkey();
    let mut d = pack_mint(&Pubkey::default(), 1, 0);
    d[..4].copy_from_slice(&0u32.to_le_bytes()); // mint_authority: None
    set_token_state(svm, mint, d);
    mint
}

fn create_mint(svm: &mut LiteSVM, authority: &Pubkey, supply: u64, decimals: u8) -> Pubkey {
    let mint = Keypair::new().pubkey();
    set_token_state(svm, mint, pack_mint(authority, supply, decimals));
    mint
}

/// Creates (or overwrites) `owner`'s ATA for `mint` holding `amount`.
fn fund_ata(svm: &mut LiteSVM, owner: &Pubkey, mint: &Pubkey, amount: u64) -> Pubkey {
    let address = ata(owner, mint);
    set_token_state(svm, address, pack_token_account(mint, owner, amount));
    address
}

fn balance(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    match svm.get_account(token_account) {
        Some(acc) if acc.data.len() >= 72 => u64::from_le_bytes(acc.data[64..72].try_into().unwrap()),
        _ => 0,
    }
}

fn is_closed(svm: &LiteSVM, address: &Pubkey) -> bool {
    svm.get_account(address).map_or(true, |a| a.lamports == 0)
}

fn fetch<T: AccountDeserialize>(svm: &LiteSVM, address: &Pubkey) -> T {
    let acc = svm.get_account(address).expect("account missing");
    T::try_deserialize(&mut acc.data.as_slice()).expect("deserialize")
}

// ---------------------------------------------------------------- tx helpers

fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(heirloom::id(), &data.data(), accounts.to_account_metas(None))
}

/// Serialised size of a legacy transaction.
fn tx_size(ixs: &[Instruction], fee_payer: &Pubkey) -> usize {
    fn short(n: usize) -> usize { if n < 128 { 1 } else { 2 } }
    let m = Message::new(ixs, Some(fee_payer));
    let sigs = m.header.num_required_signatures as usize;
    let body: usize = m
        .instructions
        .iter()
        .map(|c| 1 + short(c.accounts.len()) + c.accounts.len() + short(c.data.len()) + c.data.len())
        .sum();
    short(sigs) + 64 * sigs + 3 + short(m.account_keys.len()) + 32 * m.account_keys.len() + 32 + short(m.instructions.len()) + body
}

/// A compute-unit limit and price, as the hosted app adds them.
fn budget_ixs() -> Vec<Instruction> {
    let id: Pubkey = "ComputeBudget111111111111111111111111111111".parse().unwrap();
    let mut limit = vec![2u8];
    limit.extend_from_slice(&1_400_000u32.to_le_bytes());
    let mut price = vec![3u8];
    price.extend_from_slice(&1_000u64.to_le_bytes());
    vec![Instruction::new_with_bytes(id, &limit, vec![]), Instruction::new_with_bytes(id, &price, vec![])]
}

/// Sends one instruction; `signers[0]` pays the fee. Returns the debug form of the error on failure. Every
/// instruction sent must also fit with a fee sponsor and the compute-budget instructions added.
fn send(svm: &mut LiteSVM, instruction: Instruction, signers: &[&Keypair]) -> Result<(), String> {
    let mut sponsored = budget_ixs();
    sponsored.push(instruction.clone());
    let size = tx_size(&sponsored, &Pubkey::new_unique());
    assert!(size <= 1232, "a sponsored transaction would be {size} bytes");
    let payer = signers[0].pubkey();
    let msg = Message::new_with_blockhash(&[instruction], Some(&payer), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    let res = svm.send_transaction(tx);
    svm.expire_blockhash();
    res.map(|meta| LAST_CU.with(|c| c.set(meta.compute_units_consumed))).map_err(|e| format!("{:?}", e.err))
}

fn expect_err<T>(res: Result<T, String>, err: HeirloomError) {
    let code = 6000 + err as u32;
    match res {
        Ok(_) => panic!("expected error {code}, but the transaction succeeded"),
        Err(e) => assert!(
            e.contains(&format!("Custom({code})")),
            "expected Custom({code}), got {e}"
        ),
    }
}

fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

fn warp(svm: &mut LiteSVM, secs: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp += secs;
    clock.slot += 1;
    svm.set_sysvar::<Clock>(&clock);
}

// ---------------------------------------------------------------- test environment

struct Env {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    verifiers: [Keypair; 3],
    kid1: Keypair,
    kid2: Keypair,
    university: Keypair,
    landlord: Keypair,
    executor: Keypair,
    buyer1: Keypair,
    buyer2: Keypair,
    stranger: Keypair,
    usdt_mint: Pubkey,
    estate: Pubkey,
}

impl Env {
    /// The owner just acted (proof of life), so the death claim is made and approved again.
    fn claim_again(&mut self) {
        warp(&mut self.svm, 1);
        self.submit_death_claim(1).unwrap();
        self.review_death(true).unwrap();
    }

    /// `who`'s Beneficiary PDA when there is one (a removed beneficiary's still exists), otherwise None.
    fn member_account(&self, who: &Pubkey) -> Option<Pubkey> {
        let address = beneficiary_pda(&self.estate, who);
        self.svm.get_account(&address).filter(|a| !a.data.is_empty()).map(|_| address)
    }

    /// Program loaded, wallets funded with SOL, USD₮ mint created, owner holds 100k USD₮.
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/heirloom.so"));
        svm.add_program(heirloom::id(), bytes).unwrap();
        warp(&mut svm, GENESIS);

        let owner = Keypair::new();
        let env_keys: Vec<Keypair> = (0..11).map(|_| Keypair::new()).collect();
        let mut it = env_keys.into_iter();
        let mut next = || it.next().unwrap();
        let agent = next();
        let verifiers = [next(), next(), next()];
        let kid1 = next();
        let kid2 = next();
        let university = next();
        let landlord = next();
        let executor = next();
        let buyer1 = next();
        let buyer2 = next();
        let stranger = Keypair::new();

        for kp in [&owner, &agent, &verifiers[0], &verifiers[1], &verifiers[2], &kid1, &kid2, &buyer1, &buyer2, &stranger] {
            svm.airdrop(&kp.pubkey(), 10_000_000_000).unwrap();
        }

        let usdt_mint = create_mint(&mut svm, &owner.pubkey(), 1_000_000 * USDT, 6);
        fund_ata(&mut svm, &owner.pubkey(), &usdt_mint, 100_000 * USDT);
        let estate = estate_pda(&owner.pubkey());

        Env {
            svm,
            owner,
            agent,
            verifiers,
            kid1,
            kid2,
            university,
            landlord,
            executor,
            buyer1,
            buyer2,
            stranger,
            usdt_mint,
            estate,
        }
    }

    fn vault(&self) -> Pubkey {
        ata(&self.estate, &self.usdt_mint)
    }

    fn verifier_keys(&self) -> [Pubkey; 3] {
        [self.verifiers[0].pubkey(), self.verifiers[1].pubkey(), self.verifiers[2].pubkey()]
    }

    fn create_estate_ix(&self, verifiers: [Pubkey; 3], death: u8, claim: u8, hardship: u8, waiting: i64) -> Instruction {
        ix(
            heirloom::accounts::CreateEstate {
                owner: self.owner.pubkey(),
                estate: self.estate,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
            },
            heirloom::instruction::CreateEstate {
                agent: self.agent.pubkey(),
                verifiers,
                death_threshold: death,
                claim_threshold: claim,
                hardship_threshold: hardship,
                waiting_period_secs: waiting,
            },
        )
    }

    fn create_estate(&mut self) {
        let i = self.create_estate_ix(self.verifier_keys(), 2, 1, 2, WAITING);
        send(&mut self.svm, i, &[&self.owner]).unwrap();
    }

    fn add_beneficiary(&mut self, wallet: Pubkey, label: &str) {
        let i = ix(
            heirloom::accounts::AddBeneficiary {
                owner: self.owner.pubkey(),
                estate: self.estate,
                wallet,
                beneficiary: beneficiary_pda(&self.estate, &wallet),
                system_program: system_program(),
            },
            heirloom::instruction::AddBeneficiary { label: label.to_string() },
        );
        send(&mut self.svm, i, &[&self.owner]).unwrap();
    }

    fn add_payee(&mut self, wallet: Pubkey, kind: PayeeKind, name: &str) {
        let i = ix(
            heirloom::accounts::AddPayee {
                owner: self.owner.pubkey(),
                estate: self.estate,
                wallet,
                payee: payee_pda(&self.estate, &wallet),
                system_program: system_program(),
            },
            heirloom::instruction::AddPayee { kind, name: name.to_string() },
        );
        send(&mut self.svm, i, &[&self.owner]).unwrap();
    }

    fn add_rule(&mut self, id: u16, wallet: Pubkey, kind: PayeeKind, max_per_claim: u64, lifetime_cap: u64, valid_until: i64) -> Pubkey {
        let i = self.add_rule_ix(id, wallet, kind, max_per_claim, lifetime_cap, valid_until, false, 0, 0, 0, None);
        send(&mut self.svm, i, &[&self.owner]).unwrap();
        rule_pda(&self.estate, id)
    }

    /// Full add_rule: living plan (`starts_now`) and/or a scheduled payment to `payee_wallet`.
    fn add_rule_ix(
        &self,
        id: u16,
        wallet: Pubkey,
        kind: PayeeKind,
        max_per_claim: u64,
        lifetime_cap: u64,
        valid_until: i64,
        starts_now: bool,
        recurring_amount: u64,
        interval_secs: i64,
        first_due: i64,
        payee_wallet: Option<Pubkey>,
    ) -> Instruction {
        ix(
            heirloom::accounts::AddRule {
                owner: self.owner.pubkey(),
                estate: self.estate,
                beneficiary: beneficiary_pda(&self.estate, &wallet),
                rule: rule_pda(&self.estate, id),
                payee: payee_wallet.map(|w| payee_pda(&self.estate, &w)),
                system_program: system_program(),
                year_cap: year_cap_pda(&rule_pda(&self.estate, id)),
            },
            heirloom::instruction::AddRuleV2 {
                rule_id: id,
                category: Category::Tuition,
                allowed_payee_kind: kind,
                max_per_claim,
                lifetime_cap,
                valid_until,
                starts_now,
                recurring_amount,
                interval_secs,
                first_due,
            },
        )
    }

    fn owner_approve_claim(&mut self, rule: Pubkey, claim: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::OwnerApproveClaim { owner: self.owner.pubkey(), estate: self.estate, rule, claim },
            heirloom::instruction::OwnerApproveClaim {},
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn execute_scheduled(&mut self, rule: Pubkey) -> Result<(), String> {
        let r: Rule = fetch(&self.svm, &rule);
        let i = ix(
            heirloom::accounts::ExecuteScheduled {
                payer: self.stranger.pubkey(),
                estate: self.estate,
                rule,
                payee_wallet: r.fixed_payee,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                payee_usdt: ata(&r.fixed_payee, &self.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                year_cap: year_cap_pda(&rule),
                beneficiary_account: beneficiary_pda(&self.estate, &r.beneficiary),
                payee_account: payee_pda(&self.estate, &r.fixed_payee),
            },
            heirloom::instruction::ExecuteScheduled {},
        );
        send(&mut self.svm, i, &[&self.stranger])
    }

    fn deposit_ix(&self, owner_usdt: Pubkey, amount: u64) -> Instruction {
        ix(
            heirloom::accounts::Deposit {
                owner: self.owner.pubkey(),
                estate: self.estate,
                usdt_mint: self.usdt_mint,
                owner_usdt,
                vault: self.vault(),
                token_program: token_program(),
            },
            heirloom::instruction::Deposit { amount },
        )
    }

    fn submit_death_claim(&mut self, who: usize) -> Result<(), String> {
        let kid = if who == 1 { &self.kid1 } else { &self.kid2 };
        let i = ix(
            heirloom::accounts::SubmitDeathClaim {
                beneficiary: kid.pubkey(),
                estate: self.estate,
                beneficiary_account: self.member_account(&kid.pubkey()),
                guard: None,
                objection: objection_pda(&self.estate),
            },
            heirloom::instruction::SubmitDeathClaim { cert_hash: [7u8; 32] },
        );
        send(&mut self.svm, i, &[kid])
    }

    fn review_death(&mut self, approve: bool) -> Result<(), String> {
        self.review_death_as(if approve { ReviewOutcome::Approve } else { ReviewOutcome::Reject }, None)
    }

    /// `read` = the certificate the agent read; None = the one on-chain.
    fn review_death_as(&mut self, outcome: ReviewOutcome, read: Option<[u8; 32]>) -> Result<(), String> {
        let cert_hash = read.unwrap_or_else(|| self.estate_state().death_cert_hash);
        let i = ix(
            heirloom::accounts::ReviewDeath { agent: self.agent.pubkey(), estate: self.estate },
            heirloom::instruction::ReviewDeath { outcome, report_hash: [9u8; 32], cert_hash },
        );
        send(&mut self.svm, i, &[&self.agent])
    }

    fn attest_death_by(&mut self, signer: &Keypair) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::AttestDeath { verifier: signer.pubkey(), estate: self.estate },
            heirloom::instruction::AttestDeath {},
        );
        send(&mut self.svm, i, &[signer])
    }

    fn attest_death(&mut self, v: usize) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::AttestDeath { verifier: self.verifiers[v].pubkey(), estate: self.estate },
            heirloom::instruction::AttestDeath {},
        );
        send(&mut self.svm, i, &[&self.verifiers[v]])
    }

    fn veto_death(&mut self) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::VetoDeath { owner: self.owner.pubkey(), estate: self.estate },
            heirloom::instruction::VetoDeath {},
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn finalize_unlock(&mut self) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::FinalizeUnlock { estate: self.estate, objection: objection_pda(&self.estate), caller: self.stranger.pubkey() },
            heirloom::instruction::FinalizeUnlock {},
        );
        send(&mut self.svm, i, &[&self.stranger])
    }

    fn estate_state(&self) -> Estate {
        fetch(&self.svm, &self.estate)
    }

    /// Runs the full death flow through to Unlocked.
    fn unlock(&mut self) {
        self.submit_death_claim(1).unwrap();
        self.review_death(true).unwrap();
        self.attest_death(0).unwrap();
        self.attest_death(1).unwrap();
        warp(&mut self.svm, WAITING);
        self.finalize_unlock().unwrap();
        assert_eq!(self.estate_state().status, EstateStatus::Unlocked);
    }

    /// Estate with kid1 + kid2, a university and a landlord payee, and 5,000 USD₮ in the vault.
    fn configured() -> Self {
        let mut env = Env::new();
        env.create_estate();
        let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
        env.add_beneficiary(k1, "Child 1");
        env.add_beneficiary(k2, "Child 2");
        let (uni, ll) = (env.university.pubkey(), env.landlord.pubkey());
        env.add_payee(uni, PayeeKind::University, "University of Cape Town");
        env.add_payee(ll, PayeeKind::Landlord, "Res Landlord");
        let owner_usdt = ata(&env.owner.pubkey(), &env.usdt_mint);
        let i = env.deposit_ix(owner_usdt, 5_000 * USDT);
        send(&mut env.svm, i, &[&env.owner]).unwrap();
        env
    }

    // ---------------- claims

    fn submit_claim(&mut self, signer_is_kid1: bool, rule: Pubkey, payee_wallet: Pubkey, amount: u64) -> Result<Pubkey, String> {
        let kid = if signer_is_kid1 { &self.kid1 } else { &self.kid2 };
        let r: Rule = fetch(&self.svm, &rule);
        let claim = claim_pda(&rule, r.claim_count);
        let i = ix(
            heirloom::accounts::SubmitClaim {
                beneficiary: kid.pubkey(),
                estate: self.estate,
                beneficiary_account: beneficiary_pda(&self.estate, &kid.pubkey()),
                rule,
                payee: payee_pda(&self.estate, &payee_wallet),
                claim,
                system_program: system_program(),
                year_cap: year_cap_pda(&rule),
            },
            heirloom::instruction::SubmitClaim { amount, evidence_hash: [1u8; 32] },
        );
        send(&mut self.svm, i, &[kid]).map(|_| claim)
    }

    fn review_claim(&mut self, claim: Pubkey, approve: bool) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReviewClaim { agent: self.agent.pubkey(), estate: self.estate, claim },
            heirloom::instruction::ReviewClaim { outcome: if approve { ReviewOutcome::Approve } else { ReviewOutcome::Reject }, report_hash: [2u8; 32] },
        );
        send(&mut self.svm, i, &[&self.agent])
    }

    fn approve_claim(&mut self, claim: Pubkey, v: usize) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ApproveClaim {
                verifier: self.verifiers[v].pubkey(),
                estate: self.estate,
                claim,
                payer: self.verifiers[v].pubkey(),
                approval_stamp: stamp_pda(&claim),
                system_program: system_program(),
            },
            heirloom::instruction::ApproveClaim {},
        );
        send(&mut self.svm, i, &[&self.verifiers[v]])
    }

    fn execute_claim(&mut self, rule: Pubkey, claim: Pubkey) -> Result<(), String> {
        let c: Claim = fetch(&self.svm, &claim);
        let i = ix(
            heirloom::accounts::ExecuteClaim {
                payer: self.stranger.pubkey(),
                estate: self.estate,
                rule,
                claim,
                payee_wallet: c.payee,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                payee_usdt: ata(&c.payee, &self.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                guard: guard_pda(&self.estate),
                approval_stamp: stamp_pda(&claim),
                objection: objection_pda(&claim),
                year_cap: year_cap_pda(&rule),
                beneficiary_account: beneficiary_pda(&self.estate, &c.beneficiary),
                payee_account: payee_pda(&self.estate, &c.payee),
            },
            heirloom::instruction::ExecuteClaim {},
        );
        send(&mut self.svm, i, &[&self.stranger])
    }

    /// Submit -> agent approves -> verifier 0 approves -> execute.
    fn pay_claim(&mut self, rule: Pubkey, payee_wallet: Pubkey, amount: u64) {
        let claim = self.submit_claim(true, rule, payee_wallet, amount).unwrap();
        self.review_claim(claim, true).unwrap();
        self.approve_claim(claim, 0).unwrap();
        self.execute_claim(rule, claim).unwrap();
    }
}

// ---------------------------------------------------------------- sale environment

struct Sale {
    env: Env,
    nft_mint: Pubkey,
    asset: Pubkey,
    /// Backups and monitors when built with a Guard (`Sale::build(true)`).
    people: Option<People>,
}

const FLOOR: u64 = 9_000 * USDT;
const HARDSHIP_FLOOR: u64 = 7_000 * USDT;
const ASKING: u64 = 10_000 * USDT;

impl Sale {
    /// Configured estate + registered car NFT, unlocked, listed for 3 days; buyers hold 20k USD₮.
    fn new() -> Self {
        Sale::build(false)
    }

    /// As `new`; with `guarded`, a Guard and 3 Seats are set up before the unlock.
    fn build(guarded_estate: bool) -> Self {
        let mut env = Env::configured();
        let people = if guarded_estate { Some(guarded(&mut env)) } else { None };
        let owner = env.owner.pubkey();
        let nft_mint = create_title(&mut env.svm);
        let owner_nft = fund_ata(&mut env.svm, &owner, &nft_mint, 1);
        let asset = asset_pda(&env.estate, &nft_mint);

        let i = ix(
            heirloom::accounts::RegisterAsset {
                owner,
                estate: env.estate,
                nft_mint,
                owner_nft,
                nft_escrow: ata(&env.estate, &nft_mint),
                asset,
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
            },
            heirloom::instruction::RegisterAsset {
                floor_price: FLOOR,
                hardship_floor: HARDSHIP_FLOOR,
                asking_price: ASKING,
                proceeds_to: env.executor.pubkey(),
                doc_hash: [3u8; 32],
            },
        );
        send(&mut env.svm, i, &[&env.owner]).unwrap();
        assert_eq!(balance(&env.svm, &ata(&env.estate, &nft_mint)), 1);
        assert_eq!(balance(&env.svm, &owner_nft), 0);

        env.unlock();

        let i = ix(
            heirloom::accounts::ListAsset { authority: env.agent.pubkey(), estate: env.estate, asset },
            heirloom::instruction::ListAsset { duration_secs: 3 * DAY },
        );
        send(&mut env.svm, i, &[&env.agent]).unwrap();

        let mint = env.usdt_mint;
        let (b1, b2) = (env.buyer1.pubkey(), env.buyer2.pubkey());
        fund_ata(&mut env.svm, &b1, &mint, 20_000 * USDT);
        fund_ata(&mut env.svm, &b2, &mint, 20_000 * USDT);

        Sale { env, nft_mint, asset, people }
    }

    fn buyer(&self, n: usize) -> &Keypair {
        if n == 1 { &self.env.buyer1 } else { &self.env.buyer2 }
    }

    fn place_offer(&mut self, n: usize, amount: u64) -> Result<(), String> {
        let buyer = self.buyer(n).pubkey();
        let offer = offer_pda(&self.asset, &buyer);
        let i = ix(
            heirloom::accounts::PlaceOffer {
                buyer,
                estate: self.env.estate,
                asset: self.asset,
                usdt_mint: self.env.usdt_mint,
                buyer_usdt: ata(&buyer, &self.env.usdt_mint),
                offer,
                offer_escrow: ata(&offer, &self.env.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
            },
            heirloom::instruction::PlaceOffer { amount },
        );
        let kp = if n == 1 { &self.env.buyer1 } else { &self.env.buyer2 };
        send(&mut self.env.svm, i, &[kp])
    }

    fn withdraw_offer(&mut self, n: usize) -> Result<(), String> {
        let buyer = self.buyer(n).pubkey();
        let offer = offer_pda(&self.asset, &buyer);
        let i = ix(
            heirloom::accounts::WithdrawOffer {
                buyer,
                estate: self.env.estate,
                asset: self.asset,
                usdt_mint: self.env.usdt_mint,
                buyer_usdt: ata(&buyer, &self.env.usdt_mint),
                offer,
                offer_escrow: ata(&offer, &self.env.usdt_mint),
                token_program: token_program(),
            },
            heirloom::instruction::WithdrawOffer {},
        );
        let kp = if n == 1 { &self.env.buyer1 } else { &self.env.buyer2 };
        send(&mut self.env.svm, i, &[kp])
    }

    /// Accepted by the agent with verifier 1's co-signature.
    fn accept_offer(&mut self, n: usize) -> Result<(), String> {
        let co = self.env.verifiers[1].insecure_clone();
        self.accept_offer_with(n, Some(&co))
    }

    fn accept_offer_with(&mut self, n: usize, co_signer: Option<&Keypair>) -> Result<(), String> {
        let offer = offer_pda(&self.asset, &self.buyer(n).pubkey());
        // A withdrawn offer has no account: the program refuses it before it reads the amount.
        let amount = if is_closed(&self.env.svm, &offer) { 0 } else { fetch::<heirloom::Offer>(&self.env.svm, &offer).amount };
        self.accept_offer_expecting(n, co_signer, amount)
    }

    fn accept_offer_expecting(&mut self, n: usize, co_signer: Option<&Keypair>, expected_amount: u64) -> Result<(), String> {
        let buyer = self.buyer(n).pubkey();
        let offer = offer_pda(&self.asset, &buyer);
        let a: Asset = fetch(&self.env.svm, &self.asset);
        let recipient = a.hardship_beneficiary.unwrap_or(a.proceeds_to);
        let i = ix(
            heirloom::accounts::AcceptOffer {
                agent: self.env.agent.pubkey(),
                estate: self.env.estate,
                asset: self.asset,
                offer,
                buyer,
                recipient,
                usdt_mint: self.env.usdt_mint,
                offer_escrow: ata(&offer, &self.env.usdt_mint),
                recipient_usdt: ata(&recipient, &self.env.usdt_mint),
                nft_mint: self.nft_mint,
                nft_escrow: ata(&self.env.estate, &self.nft_mint),
                buyer_nft: ata(&buyer, &self.nft_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                objection: objection_pda(&self.asset),
                hardship_objection: a
                    .hardship_beneficiary
                    .map(|b| objection_pda(&hardship_pda(&self.asset, &b)))
                    .unwrap_or_else(system_program),
                co_signer: co_signer.map(|k| k.pubkey()),
                guard: guard_pda(&self.env.estate),
                hardship_stamp: a
                    .hardship_beneficiary
                    .map(|b| stamp_pda(&hardship_pda(&self.asset, &b)))
                    .unwrap_or_else(system_program),
            },
            heirloom::instruction::AcceptOffer { expected_amount },
        );
        let mut signers = vec![&self.env.agent];
        signers.extend(co_signer.filter(|k| k.pubkey() != self.env.agent.pubkey()));
        send(&mut self.env.svm, i, &signers)
    }

    fn submit_hardship(&mut self) -> Result<Pubkey, String> {
        let kid = self.env.kid2.pubkey();
        let hardship = hardship_pda(&self.asset, &kid);
        let i = ix(
            heirloom::accounts::SubmitHardship {
                beneficiary: kid,
                estate: self.env.estate,
                beneficiary_account: beneficiary_pda(&self.env.estate, &kid),
                asset: self.asset,
                hardship,
                system_program: system_program(),
            },
            heirloom::instruction::SubmitHardship { evidence_hash: [4u8; 32] },
        );
        send(&mut self.env.svm, i, &[&self.env.kid2]).map(|_| hardship)
    }

    fn review_hardship(&mut self, hardship: Pubkey, approve: bool) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReviewHardship {
                agent: self.env.agent.pubkey(),
                estate: self.env.estate,
                asset: self.asset,
                hardship,
            },
            heirloom::instruction::ReviewHardship { outcome: if approve { ReviewOutcome::Approve } else { ReviewOutcome::Reject }, report_hash: [5u8; 32] },
        );
        send(&mut self.env.svm, i, &[&self.env.agent])
    }

    fn approve_hardship(&mut self, hardship: Pubkey, v: usize) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ApproveHardship {
                verifier: self.env.verifiers[v].pubkey(),
                estate: self.env.estate,
                asset: self.asset,
                hardship,
                payer: self.env.verifiers[v].pubkey(),
                approval_stamp: stamp_pda(&hardship),
                system_program: system_program(),
            },
            heirloom::instruction::ApproveHardship {},
        );
        send(&mut self.env.svm, i, &[&self.env.verifiers[v]])
    }

    /// kid2's hardship: submitted, agent-approved, and approved by 2 of 3 verifiers.
    fn approved_hardship(&mut self) {
        let h = self.submit_hardship().unwrap();
        self.review_hardship(h, true).unwrap();
        self.approve_hardship(h, 0).unwrap();
        self.approve_hardship(h, 2).unwrap();
        let a: Asset = fetch(&self.env.svm, &self.asset);
        assert_eq!(a.hardship_beneficiary, Some(self.env.kid2.pubkey()));
    }
}

// =================================================================== tests: setup

#[test]
fn create_estate_validation() {
    let mut env = Env::new();
    let v = env.verifier_keys();
    let owner = env.owner.pubkey();

    let i = env.create_estate_ix(v, 0, 1, 2, WAITING);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidThreshold);

    let i = env.create_estate_ix(v, 2, 4, 2, WAITING);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidThreshold);

    let i = env.create_estate_ix(v, 2, 1, 2, -1);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::TimeOutOfRange);

    let i = env.create_estate_ix([v[0], v[0], v[2]], 2, 1, 2, WAITING);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::DuplicateVerifier);

    let i = env.create_estate_ix([v[0], owner, v[2]], 2, 1, 2, WAITING);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::DuplicateVerifier);

    env.create_estate();
    let e = env.estate_state();
    assert_eq!(e.owner, owner);
    assert_eq!(e.agent, env.agent.pubkey());
    assert_eq!(e.usdt_mint, env.usdt_mint);
    assert_eq!(e.verifiers, v);
    assert_eq!((e.death_threshold, e.claim_threshold, e.hardship_threshold), (2, 1, 2));
    assert_eq!(e.status, EstateStatus::Active);
    assert_eq!(e.last_heartbeat, now(&env.svm));
    assert!(env.svm.get_account(&env.vault()).is_some(), "vault ATA created");
}

#[test]
fn deposit_and_withdraw_respect_mint_and_status() {
    let mut env = Env::configured();
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);

    // A token account of another mint is rejected.
    let fake_mint = create_mint(&mut env.svm, &env.owner.pubkey(), 1_000 * USDT, 6);
    let owner = env.owner.pubkey();
    let fake_ata = fund_ata(&mut env.svm, &owner, &fake_mint, 1_000 * USDT);
    let i = env.deposit_ix(fake_ata, 10 * USDT);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::WrongMint);

    // Owner can withdraw while Active.
    let owner_usdt = ata(&owner, &env.usdt_mint);
    let withdraw = |env: &Env, amount: u64| {
        ix(
            heirloom::accounts::Withdraw {
                owner: env.owner.pubkey(),
                estate: env.estate,
                usdt_mint: env.usdt_mint,
                owner_usdt,
                vault: env.vault(),
                token_program: token_program(),
            },
            heirloom::instruction::Withdraw { amount },
        )
    };
    let i = withdraw(&env, 1_000 * USDT);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    assert_eq!(balance(&env.svm, &env.vault()), 4_000 * USDT);

    // ...but not after unlock.
    env.unlock();
    let i = withdraw(&env, 1 * USDT);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::BadStatus);
}

// =================================================================== tests: death flow

#[test]
fn death_flow_unlocks_after_quorum_and_waiting_period() {
    let mut env = Env::configured();

    env.submit_death_claim(1).unwrap();
    // A second claim can't reset the open one.
    expect_err(env.submit_death_claim(2), HeirloomError::BadStatus);
    // Verifiers can't attest before the agent approves.
    expect_err(env.attest_death(0), HeirloomError::AgentNotApproved);

    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    expect_err(env.attest_death(0), HeirloomError::AlreadyApproved);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    expect_err(env.attest_death_by(&stranger), HeirloomError::NotVerifier);
    assert_eq!(env.estate_state().status, EstateStatus::Active);

    env.attest_death(1).unwrap();
    let e = env.estate_state();
    assert_eq!(e.status, EstateStatus::DeathPending);
    assert_eq!(e.death_attestations, 0b011);
    let since = e.death_pending_since;

    // Unlock before the waiting period fails.
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, WAITING - 10);
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);

    // A third attestation doesn't restart the timer.
    env.attest_death(2).unwrap();
    assert_eq!(env.estate_state().death_pending_since, since);

    warp(&mut env.svm, 10);
    env.finalize_unlock().unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::Unlocked);

    // Owner can't veto after unlock.
    expect_err(env.veto_death(), HeirloomError::BadStatus);
}

#[test]
fn veto_resets_death_claim() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    env.attest_death(1).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);

    warp(&mut env.svm, 30);
    env.veto_death().unwrap();
    let e = env.estate_state();
    assert_eq!(e.status, EstateStatus::Active);
    assert_eq!(e.death_cert_hash, [0u8; 32]);
    assert_eq!(e.death_attestations, 0);
    assert_eq!(e.last_heartbeat, now(&env.svm));

    warp(&mut env.svm, WAITING);
    expect_err(env.finalize_unlock(), HeirloomError::BadStatus);

    // A fresh claim starts again from zero.
    env.submit_death_claim(2).unwrap();
    expect_err(env.attest_death(0), HeirloomError::AgentNotApproved);
}

#[test]
fn agent_rejection_clears_death_claim() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(false).unwrap();
    let e = env.estate_state();
    assert_eq!(e.death_cert_hash, [0u8; 32]);
    expect_err(env.attest_death(0), HeirloomError::NoDeathClaim);
}

// =================================================================== tests: claims

fn claims_env() -> (Env, Pubkey) {
    let mut env = Env::configured();
    let valid_until = now(&env.svm) + 365 * DAY;
    let kid1 = env.kid1.pubkey();
    // Tuition for kid1, paid to a University: 600 per claim, 1,000 lifetime.
    let rule = env.add_rule(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until);
    (env, rule)
}

#[test]
fn claim_before_unlock_fails() {
    let (mut env, rule) = claims_env();
    let uni = env.university.pubkey();
    expect_err(env.submit_claim(true, rule, uni, 100 * USDT), HeirloomError::BadStatus);
}

#[test]
fn claim_within_caps_pays_the_payee() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();

    let claim = env.submit_claim(true, rule, uni, 500 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    expect_err(env.approve_claim(claim, 0), HeirloomError::AlreadyApproved);
    env.execute_claim(rule, claim).unwrap();

    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 500 * USDT);
    assert_eq!(balance(&env.svm, &env.vault()), 4_500 * USDT);
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!(r.spent_total, 500 * USDT);
    assert_eq!(r.claim_count, 1);
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.status, ClaimStatus::Paid);

    // Can't be paid twice.
    expect_err(env.execute_claim(rule, claim), HeirloomError::BadStatus);
}

#[test]
fn claim_over_per_claim_cap_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    expect_err(env.submit_claim(true, rule, uni, 601 * USDT), HeirloomError::ExceedsPerClaimCap);
}

#[test]
fn claim_over_lifetime_cap_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    env.pay_claim(rule, uni, 600 * USDT);
    expect_err(env.submit_claim(true, rule, uni, 500 * USDT), HeirloomError::ExceedsLifetimeCap);
    // Exactly up to the cap is fine.
    env.pay_claim(rule, uni, 400 * USDT);
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 1_000 * USDT);
}

#[test]
fn lifetime_cap_rechecked_at_execution() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    // Two open claims that together exceed the lifetime cap.
    let c1 = env.submit_claim(true, rule, uni, 600 * USDT).unwrap();
    let c2 = env.submit_claim(true, rule, uni, 600 * USDT).unwrap();
    for c in [c1, c2] {
        env.review_claim(c, true).unwrap();
        env.approve_claim(c, 1).unwrap();
    }
    env.execute_claim(rule, c1).unwrap();
    expect_err(env.execute_claim(rule, c2), HeirloomError::ExceedsLifetimeCap);
}

#[test]
fn claim_to_wrong_payee_kind_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let landlord = env.landlord.pubkey();
    expect_err(env.submit_claim(true, rule, landlord, 100 * USDT), HeirloomError::WrongPayeeKind);
}

#[test]
fn claim_by_other_beneficiary_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    expect_err(env.submit_claim(false, rule, uni, 100 * USDT), HeirloomError::NotBeneficiary);
}

#[test]
fn claim_after_rule_expiry_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    warp(&mut env.svm, 366 * DAY);
    let uni = env.university.pubkey();
    expect_err(env.submit_claim(true, rule, uni, 100 * USDT), HeirloomError::RuleExpired);
}

#[test]
fn claim_with_insufficient_approvals_fails() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();

    // Verifiers can't approve before the agent.
    expect_err(env.approve_claim(claim, 0), HeirloomError::AgentNotApproved);
    expect_err(env.execute_claim(rule, claim), HeirloomError::AgentNotApproved);

    env.review_claim(claim, true).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

#[test]
fn agent_rejected_claim_cannot_be_paid() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, false).unwrap();
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.status, ClaimStatus::Rejected);
    expect_err(env.approve_claim(claim, 0), HeirloomError::BadStatus);
    expect_err(env.execute_claim(rule, claim), HeirloomError::BadStatus);
}

// =================================================================== tests: asset sale

#[test]
fn offer_below_floor_rejected_and_best_offer_settles_atomically() {
    let mut s = Sale::new();
    let usdt = s.env.usdt_mint;
    let (b1, b2) = (s.env.buyer1.pubkey(), s.env.buyer2.pubkey());
    let executor = s.env.executor.pubkey();

    s.place_offer(1, 8_000 * USDT).unwrap();
    s.place_offer(2, 9_500 * USDT).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&b1, &usdt)), 12_000 * USDT);

    expect_err(s.accept_offer(1), HeirloomError::BelowFloor);

    s.accept_offer(2).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&executor, &usdt)), 9_500 * USDT);
    assert_eq!(balance(&s.env.svm, &ata(&b2, &s.nft_mint)), 1);
    assert_eq!(balance(&s.env.svm, &ata(&s.env.estate, &s.nft_mint)), 0);
    let a: Asset = fetch(&s.env.svm, &s.asset);
    assert_eq!(a.status, AssetStatus::Sold);
    let offer2 = offer_pda(&s.asset, &b2);
    assert!(is_closed(&s.env.svm, &offer2));
    assert!(is_closed(&s.env.svm, &ata(&offer2, &usdt)));

    // The losing buyer gets the full refund after the sale.
    s.withdraw_offer(1).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&b1, &usdt)), 20_000 * USDT);

    // Nothing more can be sold or offered.
    expect_err(s.place_offer(1, 9_999 * USDT), HeirloomError::BadStatus);
}

#[test]
fn hardship_approved_allows_hardship_floor_and_pays_hardship_beneficiary() {
    let mut s = Sale::new();
    let usdt = s.env.usdt_mint;
    let kid2 = s.env.kid2.pubkey();
    let b1 = s.env.buyer1.pubkey();

    s.place_offer(1, 7_500 * USDT).unwrap();
    expect_err(s.accept_offer(1), HeirloomError::BelowFloor);

    let h = s.submit_hardship().unwrap();
    expect_err(s.approve_hardship(h, 0), HeirloomError::AgentNotApproved);
    s.review_hardship(h, true).unwrap();
    s.approve_hardship(h, 0).unwrap();
    expect_err(s.approve_hardship(h, 0), HeirloomError::AlreadyApproved);
    // One approval is below the hardship quorum (2): still bound by the normal floor.
    expect_err(s.accept_offer(1), HeirloomError::BelowFloor);
    s.approve_hardship(h, 1).unwrap();

    s.accept_offer(1).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&kid2, &usdt)), 7_500 * USDT);
    assert_eq!(balance(&s.env.svm, &ata(&s.env.executor.pubkey(), &usdt)), 0);
    assert_eq!(balance(&s.env.svm, &ata(&b1, &s.nft_mint)), 1);
}

#[test]
fn offer_below_hardship_floor_rejected() {
    let mut s = Sale::new();
    s.approved_hardship();
    s.place_offer(1, 6_999 * USDT).unwrap();
    expect_err(s.accept_offer(1), HeirloomError::BelowHardshipFloor);
    let a: Asset = fetch(&s.env.svm, &s.asset);
    assert_eq!(a.status, AssetStatus::Listed);
}

#[test]
fn withdraw_offer_refunds_buyer() {
    let mut s = Sale::new();
    let usdt = s.env.usdt_mint;
    let b1 = s.env.buyer1.pubkey();
    let offer = offer_pda(&s.asset, &b1);

    s.place_offer(1, 9_000 * USDT).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&b1, &usdt)), 11_000 * USDT);
    assert_eq!(balance(&s.env.svm, &ata(&offer, &usdt)), 9_000 * USDT);

    s.withdraw_offer(1).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&b1, &usdt)), 20_000 * USDT);
    assert!(is_closed(&s.env.svm, &offer));
    assert!(is_closed(&s.env.svm, &ata(&offer, &usdt)));

    // The offer is gone, so it can't be accepted.
    assert!(s.accept_offer(1).is_err());
}

#[test]
fn offers_after_listing_end_rejected() {
    let mut s = Sale::new();
    warp(&mut s.env.svm, 3 * DAY);
    expect_err(s.place_offer(1, 9_500 * USDT), HeirloomError::ListingClosed);
}

// =================================================================== tests: living plans + scheduled payments

const MINUTE: i64 = 60;

#[test]
fn scheduled_payment_pays_when_due_and_stops_at_lifetime_cap() {
    let mut env = Env::configured();
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let first_due = now(&env.svm) + MINUTE;
    // Living plan: 400 every minute to the university, 1,000 lifetime.
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 400 * USDT, MINUTE, first_due, Some(uni));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!((r.fixed_payee, r.next_due, r.interval_secs), (uni, first_due, MINUTE));

    // Estate is Active (owner alive) and the rule starts now.
    expect_err(env.execute_scheduled(rule), HeirloomError::NotDue);
    warp(&mut env.svm, MINUTE);
    env.execute_scheduled(rule).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 400 * USDT);
    expect_err(env.execute_scheduled(rule), HeirloomError::NotDue);

    warp(&mut env.svm, MINUTE);
    env.execute_scheduled(rule).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 800 * USDT);
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!(r.spent_total, 800 * USDT);
    assert_eq!(r.next_due, first_due + 2 * MINUTE);

    warp(&mut env.svm, MINUTE);
    expect_err(env.execute_scheduled(rule), HeirloomError::ExceedsLifetimeCap);
    assert_eq!(balance(&env.svm, &env.vault()), 4_200 * USDT);
}

#[test]
fn scheduled_payment_waits_for_unlock_unless_starts_now() {
    let mut env = Env::configured();
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let first_due = now(&env.svm);
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, false, 100 * USDT, MINUTE, first_due, Some(uni));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);

    expect_err(env.execute_scheduled(rule), HeirloomError::BadStatus);
    env.unlock();
    env.execute_scheduled(rule).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 100 * USDT);
}

#[test]
fn recurring_rule_needs_a_payee_of_the_allowed_kind() {
    let mut env = Env::configured();
    let (kid1, ll) = (env.kid1.pubkey(), env.landlord.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let t = now(&env.svm);

    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 100 * USDT, MINUTE, t, None);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::PayeeRequired);

    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 100 * USDT, MINUTE, t, Some(ll));
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::WrongPayeeKind);

    let i = env.add_rule_ix(0, kid1, PayeeKind::Landlord, 600 * USDT, 1_000 * USDT, valid_until, true, 100 * USDT, 0, t, Some(ll));
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidAmount);

    let i = env.add_rule_ix(0, kid1, PayeeKind::Landlord, 600 * USDT, 1_000 * USDT, valid_until, true, 700 * USDT, MINUTE, t, Some(ll));
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::ExceedsPerClaimCap);

    let i = env.add_rule_ix(0, kid1, PayeeKind::Landlord, 600 * USDT, 1_000 * USDT, valid_until, true, 100 * USDT, MINUTE, t, Some(ll));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
}

#[test]
fn living_plan_claim_needs_owner_approval_while_active() {
    let mut env = Env::configured();
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);

    // Estate Active: a starts_now rule accepts claims.
    let claim = env.submit_claim(true, rule, uni, 300 * USDT).unwrap();
    expect_err(env.owner_approve_claim(rule, claim), HeirloomError::AgentNotApproved);
    env.review_claim(claim, true).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    // Verifiers can't approve while the owner is alive, so they can't release money either.
    expect_err(env.approve_claim(claim, 0), HeirloomError::BadStatus);
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);

    env.owner_approve_claim(rule, claim).unwrap();
    expect_err(env.owner_approve_claim(rule, claim), HeirloomError::AlreadyApproved);
    env.execute_claim(rule, claim).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 300 * USDT);
    let c: Claim = fetch(&env.svm, &claim);
    assert!(c.owner_approved);
    assert_eq!(c.status, ClaimStatus::Paid);
}

#[test]
fn owner_cannot_approve_after_unlock() {
    let mut env = Env::configured();
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    env.unlock();
    let claim = env.submit_claim(true, rule, uni, 300 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    expect_err(env.owner_approve_claim(rule, claim), HeirloomError::BadStatus);
    env.approve_claim(claim, 0).unwrap();
    env.execute_claim(rule, claim).unwrap();
}

// =================================================================== guardians (2026-11-14)
// Seats with backups and monitors, objections, succession, the fallback plan and asset photos.
// Spec: docs/guardians-spec.md §2.

const WINDOW: i64 = 60; // objection window for claims
const SUCCESSION_WAIT: i64 = 60;
const FALLBACK_WAIT: i64 = 120;

fn d() -> Pubkey {
    Pubkey::default()
}

fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    k
}

/// Backups (2 per seat) and one monitor per seat.
struct People {
    backups: [[Keypair; 2]; 3],
    monitors: [Keypair; 3],
}

impl People {
    fn new(svm: &mut LiteSVM) -> Self {
        let mut b = || [funded(svm), funded(svm)];
        let backups = [b(), b(), b()];
        let monitors = [funded(svm), funded(svm), funded(svm)];
        People { backups, monitors }
    }
}

impl Env {
    fn kp(&self, k: &Keypair) -> Keypair {
        k.insecure_clone()
    }

    fn v(&self, i: usize) -> Keypair {
        self.verifiers[i].insecure_clone()
    }

    fn seat(&self, index: u8) -> Seat {
        fetch(&self.svm, &seat_pda(&self.estate, index))
    }

    fn guard(&self) -> Guard {
        fetch(&self.svm, &guard_pda(&self.estate))
    }

    fn init_guard(&mut self) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::InitGuard {
                authority: self.owner.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                system_program: system_program(),
            },
            heirloom::instruction::InitGuard {
                objection_window_secs: WINDOW,
                succession_wait_secs: SUCCESSION_WAIT,
                fallback_wait_secs: FALLBACK_WAIT,
            },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn init_seat(&mut self, index: u8, backups: [Pubkey; 2], monitors: [Pubkey; 2]) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::InitSeat {
                owner: self.owner.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
                system_program: system_program(),
            },
            heirloom::instruction::InitSeat { index, backups, monitors },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn set_seat_backups(&mut self, signer: &Keypair, index: u8, backups: [Pubkey; 2]) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetSeatBackups {
                authority: signer.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
            },
            heirloom::instruction::SetSeatBackups { index, backups },
        );
        send(&mut self.svm, i, &[signer])
    }

    fn set_seat_monitors(&mut self, index: u8, monitors: [Pubkey; 2]) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetSeatMonitors {
                owner: self.owner.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
            },
            heirloom::instruction::SetSeatMonitors { index, monitors },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn report_seat_death(&mut self, reporter: &Keypair, index: u8) -> Result<(), String> {
        let who = beneficiary_pda(&self.estate, &reporter.pubkey());
        let beneficiary_account = self.svm.get_account(&who).map(|_| who);
        let i = ix(
            heirloom::accounts::ReportSeatDeath {
                reporter: reporter.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
                beneficiary_account,
                objection: objection_pda(&seat_pda(&self.estate, index)),
            },
            heirloom::instruction::ReportSeatDeath { index, cert_hash: [8u8; 32] },
        );
        send(&mut self.svm, i, &[reporter])
    }

    fn review_seat_death(&mut self, index: u8, approve: bool) -> Result<(), String> {
        let (cert_hash, holder) = (self.seat(index).death_cert_hash, self.seat(index).holder);
        let i = ix(
            heirloom::accounts::ReviewSeatDeath {
                agent: self.agent.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
            },
            heirloom::instruction::ReviewSeatDeath { index, approve, report_hash: [9u8; 32], cert_hash, holder },
        );
        send(&mut self.svm, i, &[&self.agent])
    }

    fn confirm_seat_death(&mut self, confirmer: &Keypair, index: u8) -> Result<(), String> {
        let who = beneficiary_pda(&self.estate, &confirmer.pubkey());
        let beneficiary_account = self.svm.get_account(&who).map(|_| who);
        self.confirm_seat_death_with(confirmer, index, beneficiary_account)
    }

    fn confirm_seat_death_with(&mut self, confirmer: &Keypair, index: u8, beneficiary_account: Option<Pubkey>) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ConfirmSeatDeath {
                confirmer: confirmer.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
                beneficiary_account,
            },
            heirloom::instruction::ConfirmSeatDeath { index },
        );
        send(&mut self.svm, i, &[confirmer])
    }

    fn veto_seat_death(&mut self, holder: &Keypair, index: u8) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::VetoSeatDeath {
                holder: holder.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
            },
            heirloom::instruction::VetoSeatDeath { index },
        );
        send(&mut self.svm, i, &[holder])
    }

    fn finalize_succession(&mut self, index: u8) -> Result<(), String> {
        self.finalize_succession_with(index, None)
    }

    /// `confirmer_account`: the confirmer's Beneficiary PDA, as a remaining account.
    fn finalize_succession_with(&mut self, index: u8, confirmer_account: Option<Pubkey>) -> Result<(), String> {
        let seat = seat_pda(&self.estate, index);
        let mut i = ix(
            heirloom::accounts::FinalizeSuccession {
                estate: self.estate,
                guard: guard_pda(&self.estate),
                seat,
                objection: objection_pda(&seat),
                caller: self.stranger.pubkey(),
            },
            heirloom::instruction::FinalizeSuccession { index },
        );
        if let Some(account) = confirmer_account {
            i.accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(account, false));
        }
        let payer = self.stranger.insecure_clone();
        send(&mut self.svm, i, &[&payer])
    }

    /// Report (by kid1) -> agent approves -> `confirmer` confirms -> wait -> finalize.
    fn succeed(&mut self, index: u8, confirmer: &Keypair) {
        let kid1 = self.kid1.insecure_clone();
        self.report_seat_death(&kid1, index).unwrap();
        self.review_seat_death(index, true).unwrap();
        self.confirm_seat_death(confirmer, index).unwrap();
        warp(&mut self.svm, SUCCESSION_WAIT);
        self.finalize_succession(index).unwrap();
    }

    fn raise_objection(
        &mut self,
        objector: &Keypair,
        kind: TargetKind,
        target: Pubkey,
        seat_index: u8,
        seat: Option<Pubkey>,
        as_beneficiary: bool,
        target_account: Option<Pubkey>,
        asset: Option<Pubkey>,
    ) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::RaiseObjection {
                objector: objector.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                seat,
                beneficiary_account: as_beneficiary.then(|| beneficiary_pda(&self.estate, &objector.pubkey())),
                target_account,
                asset,
                objection: objection_pda(&target),
                system_program: system_program(),
            },
            heirloom::instruction::RaiseObjection { kind, target, seat_index, reason_hash: [6u8; 32] },
        );
        send(&mut self.svm, i, &[objector])
    }

    /// Objection raised by the monitor of `seat_index` (one per seat in these tests).
    fn object(&mut self, people: &People, kind: TargetKind, target: Pubkey, seat_index: u8, target_account: Option<Pubkey>, asset: Option<Pubkey>) -> Result<(), String> {
        let m = people.monitors[seat_index as usize].insecure_clone();
        let seat = Some(seat_pda(&self.estate, seat_index));
        self.raise_objection(&m, kind, target, seat_index, seat, false, target_account, asset)
    }

    fn vote_objection(
        &mut self,
        voter: &Keypair,
        target: Pubkey,
        uphold: bool,
        seats: Option<[Pubkey; 3]>,
        target_account: Option<Pubkey>,
        asset: Option<Pubkey>,
    ) -> Result<(), String> {
        let mut i = ix(
            heirloom::accounts::VoteObjection {
                voter: voter.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                objection: objection_pda(&target),
                target_account,
                asset,
            },
            heirloom::instruction::VoteObjection { uphold },
        );
        for seat in seats.into_iter().flatten() {
            i.accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(seat, false));
        }
        send(&mut self.svm, i, &[voter])
    }

    /// What a monitor passes to vote on a Fallback objection.
    fn all_seats(&self) -> Option<[Pubkey; 3]> {
        Some([0, 1, 2].map(|i| seat_pda(&self.estate, i)))
    }

    fn objection(&self, target: &Pubkey) -> Objection {
        fetch(&self.svm, &objection_pda(target))
    }

    fn approve_claim_by(&mut self, signer: &Keypair, claim: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ApproveClaim {
                verifier: signer.pubkey(),
                estate: self.estate,
                claim,
                payer: signer.pubkey(),
                approval_stamp: stamp_pda(&claim),
                system_program: system_program(),
            },
            heirloom::instruction::ApproveClaim {},
        );
        send(&mut self.svm, i, &[signer])
    }

    fn set_fallback(&mut self, recipients: [Pubkey; 4]) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetFallback {
                owner: self.owner.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                fallback_report0: fallback_report_pda(&self.estate, 0),
                fallback_report1: fallback_report_pda(&self.estate, 1),
                fallback_report2: fallback_report_pda(&self.estate, 2),
                fallback_report3: fallback_report_pda(&self.estate, 3),
            },
            heirloom::instruction::SetFallback { recipients },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn report_fallback_death_by(&mut self, who: &Keypair, index: u8, seat: Option<u8>, cert: [u8; 32]) -> Result<(), String> {
        let ben = beneficiary_pda(&self.estate, &who.pubkey());
        let i = ix(
            heirloom::accounts::ReportFallbackDeath {
                reporter: who.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                fallback_report: fallback_report_pda(&self.estate, index),
                signer_seat: seat.map(|i| seat_pda(&self.estate, i)),
                beneficiary_account: self.svm.get_account(&ben).map(|_| ben),
                system_program: system_program(),
            },
            heirloom::instruction::ReportFallbackDeath { index, cert_hash: cert },
        );
        send(&mut self.svm, i, &[who])
    }

    /// kid2 reports recipient `index`.
    fn report_fallback_death(&mut self, index: u8) -> Result<(), String> {
        let kid2 = self.kid2.insecure_clone();
        self.report_fallback_death_by(&kid2, index, None, [7u8; 32])
    }

    fn review_fallback_death_as(&mut self, index: u8, approve: bool, cert_hash: [u8; 32]) -> Result<(), String> {
        let report = fallback_report_pda(&self.estate, index);
        let stored = self.svm.get_account(&report).filter(|a| !a.data.is_empty()).map(|_| fetch::<FallbackReport>(&self.svm, &report));
        let rent_to = stored.as_ref().map_or(self.agent.pubkey(), |r| r.rent_payer);
        let recipient = stored.as_ref().map_or(d(), |r| r.recipient);
        let i = ix(
            heirloom::accounts::ReviewFallbackDeath {
                agent: self.agent.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                fallback_report: report,
                rent_to,
            },
            heirloom::instruction::ReviewFallbackDeath { index, approve, report_hash: [9u8; 32], cert_hash, recipient },
        );
        send(&mut self.svm, i, &[&self.agent])
    }

    fn review_fallback_death(&mut self, index: u8, approve: bool) -> Result<(), String> {
        self.review_fallback_death_as(index, approve, [7u8; 32])
    }

    fn resolve_fallback_death(&mut self, who: &Keypair, index: u8, seat: Option<u8>, dead: bool) -> Result<(), String> {
        let report = fallback_report_pda(&self.estate, index);
        let ben = beneficiary_pda(&self.estate, &who.pubkey());
        let i = ix(
            heirloom::accounts::ResolveFallbackDeath {
                signer: who.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                fallback_report: report,
                rent_to: fetch::<FallbackReport>(&self.svm, &report).rent_payer,
                signer_seat: seat.map(|i| seat_pda(&self.estate, i)),
                beneficiary_account: self.svm.get_account(&ben).map(|_| ben),
            },
            heirloom::instruction::ResolveFallbackDeath { index, dead },
        );
        send(&mut self.svm, i, &[who])
    }

    fn start_fallback(&mut self) -> Result<(), String> {
        let e = self.estate;
        let i = ix(
            heirloom::accounts::StartFallback {
                estate: e,
                guard: guard_pda(&e),
                seat0: seat_pda(&e, 0),
                seat1: seat_pda(&e, 1),
                seat2: seat_pda(&e, 2),
                caller: self.stranger.pubkey(),
            },
            heirloom::instruction::StartFallback {},
        );
        let s = self.stranger.insecure_clone();
        send(&mut self.svm, i, &[&s])
    }

    fn lapse_objection(&mut self, target: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::LapseObjection {
                estate: self.estate,
                guard: guard_pda(&self.estate),
                objection: objection_pda(&target),
                caller: self.stranger.pubkey(),
            },
            heirloom::instruction::LapseObjection {},
        );
        let s = self.stranger.insecure_clone();
        send(&mut self.svm, i, &[&s])
    }

    fn execute_fallback(&mut self, recipient: Pubkey) -> Result<(), String> {
        let e = self.estate;
        let guard = guard_pda(&e);
        let i = ix(
            heirloom::accounts::ExecuteFallback {
                payer: self.stranger.pubkey(),
                estate: e,
                guard,
                seat0: seat_pda(&e, 0),
                seat1: seat_pda(&e, 1),
                seat2: seat_pda(&e, 2),
                objection: objection_pda(&guard),
                fallback_report: fallback_report_pda(&e, fetch::<Guard>(&self.svm, &guard).next_fallback_index()),
                recipient,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                recipient_usdt: ata(&recipient, &self.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                unlock_objection: objection_pda(&e),
            },
            heirloom::instruction::ExecuteFallback {},
        );
        let s = self.stranger.insecure_clone();
        send(&mut self.svm, i, &[&s])
    }
}

/// Configured estate with a Guard and 3 Seats: seat i held by verifier i, backups people.backups[i],
/// monitor people.monitors[i].
fn guarded(env: &mut Env) -> People {
    let people = People::new(&mut env.svm);
    env.init_guard().unwrap();
    for i in 0..3u8 {
        let b = [people.backups[i as usize][0].pubkey(), people.backups[i as usize][1].pubkey()];
        let m = [people.monitors[i as usize].pubkey(), d()];
        env.init_seat(i, b, m).unwrap();
    }
    people
}

fn guardian_env() -> (Env, People) {
    let mut env = Env::configured();
    let people = guarded(&mut env);
    (env, people)
}

/// Guarded, kid1 tuition rule (rule 0) and the estate unlocked.
fn guarded_claims() -> (Env, People, Pubkey) {
    let (mut env, people) = guardian_env();
    let valid_until = now(&env.svm) + 365 * DAY;
    let kid1 = env.kid1.pubkey();
    let rule = env.add_rule(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until);
    env.unlock();
    (env, people, rule)
}

/// 100 USD₮ claim: submitted, agent-approved, approved by verifier 0 (seat 0, threshold 1).
fn approved_claim(env: &mut Env, rule: Pubkey) -> Pubkey {
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    claim
}

// ------------------------------------------------------------------- objections on claims

#[test]
fn monitor_objection_blocks_claim_and_upheld_rejects_it() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    let stamp: ApprovalStamp = fetch(&env.svm, &stamp_pda(&claim));
    assert_eq!((stamp.approved_at, stamp.seat_index), (now(&env.svm), 0));

    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    assert_eq!(env.guard().open_objections, 1);
    let o = env.objection(&claim);
    assert_eq!((o.status, o.kind, o.seat_index, o.monitor), (ObjectionStatus::Open, TargetKind::Claim, 0, people.monitors[0].pubkey()));
    // One open objection per target.
    expect_err(env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None), HeirloomError::ObjectionOpen);

    warp(&mut env.svm, WINDOW);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);

    // The watched holder can't vote on an objection about their own approval.
    let (v0, v1, v2) = (env.v(0), env.v(1), env.v(2));
    expect_err(env.vote_objection(&v0, claim, false, None, Some(claim), None), HeirloomError::NotVerifier);
    env.vote_objection(&v1, claim, true, None, Some(claim), None).unwrap();
    expect_err(env.vote_objection(&v1, claim, true, None, Some(claim), None), HeirloomError::AlreadyApproved);
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Open);
    env.vote_objection(&v2, claim, true, None, Some(claim), None).unwrap();

    assert_eq!(env.objection(&claim).status, ObjectionStatus::Upheld);
    assert_eq!(env.guard().open_objections, 0);
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.status, ClaimStatus::Rejected);
    expect_err(env.execute_claim(rule, claim), HeirloomError::BadStatus);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

#[test]
fn dismissed_objection_lets_claim_execute_after_window() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    let (v1, v2) = (env.v(1), env.v(2));
    env.vote_objection(&v1, claim, false, None, Some(claim), None).unwrap();
    env.vote_objection(&v2, claim, false, None, Some(claim), None).unwrap();
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Dismissed);
    assert_eq!(env.guard().open_objections, 0);

    // Dismissed, but the window still runs from the approval.
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
    assert_eq!(balance(&env.svm, &ata(&env.university.pubkey(), &env.usdt_mint)), 100 * USDT);
}

#[test]
fn guarded_claim_waits_for_objection_window() {
    let (mut env, _people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, WINDOW - 1);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, 1);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn only_the_seats_monitor_can_object() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    let stranger = env.kp(&env.stranger);
    let seat0 = Some(seat_pda(&env.estate, 0));
    let seat1 = Some(seat_pda(&env.estate, 1));
    expect_err(
        env.raise_objection(&stranger, TargetKind::Claim, claim, 0, seat0, false, Some(claim), None),
        HeirloomError::NotMonitor,
    );
    // Seat 1's monitor can't object to seat 0's approval...
    let m1 = env.kp(&people.monitors[1]);
    expect_err(
        env.raise_objection(&m1, TargetKind::Claim, claim, 0, seat1, false, Some(claim), None),
        HeirloomError::NotMonitor,
    );
    // ...nor to a claim its own holder didn't approve.
    expect_err(
        env.raise_objection(&m1, TargetKind::Claim, claim, 1, seat1, false, Some(claim), None),
        HeirloomError::BadStatus,
    );
}

#[test]
fn owner_alive_decides_an_objection_alone() {
    let mut env = Env::configured();
    let people = guarded(&mut env);
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 365 * DAY;
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    let claim = env.submit_claim(true, rule, uni, 300 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    // An approval an older program took while the owner was alive: the monitor can still object to it.
    let mut c: Claim = fetch(&env.svm, &claim);
    c.approvals = 0b001;
    env.plant(claim, &c);
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();

    env.owner_approve_claim(rule, claim).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);
    let owner = env.kp(&env.owner);
    env.vote_objection(&owner, claim, false, None, Some(claim), None).unwrap();
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Dismissed);
    // Owner-approved while alive: no objection window.
    env.execute_claim(rule, claim).unwrap();
}

// ------------------------------------------------------------------- objections on unlock and sales

#[test]
fn unlock_objection_blocks_finalize_and_upheld_clears_death_claim() {
    let (mut env, people) = guardian_env();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    env.attest_death(1).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);

    let estate = env.estate;
    env.object(&people, TargetKind::Unlock, estate, 0, None, None).unwrap();
    assert_eq!(env.objection(&estate).seat_index, 255);
    warp(&mut env.svm, WAITING);
    expect_err(env.finalize_unlock(), HeirloomError::ObjectionOpen);

    let (v1, v2) = (env.v(1), env.v(2));
    env.vote_objection(&v1, estate, true, None, None, None).unwrap();
    env.vote_objection(&v2, estate, true, None, None, None).unwrap();
    let e = env.estate_state();
    assert_eq!(e.status, EstateStatus::Active);
    assert_eq!(e.death_cert_hash, [0u8; 32]);
    expect_err(env.finalize_unlock(), HeirloomError::BadStatus);
}

#[test]
fn sale_objection_blocks_accept_until_relisted() {
    let mut s = Sale::build(true);
    let people = s.people.take().unwrap();
    let asset = s.asset;
    s.place_offer(2, 9_500 * USDT).unwrap();
    s.env.object(&people, TargetKind::Sale, asset, 0, Some(asset), None).unwrap();
    expect_err(s.accept_offer(2), HeirloomError::ObjectionOpen);

    let (v1, v2) = (s.env.v(1), s.env.v(2));
    s.env.vote_objection(&v1, asset, true, None, Some(asset), None).unwrap();
    s.env.vote_objection(&v2, asset, true, None, Some(asset), None).unwrap();
    let a: Asset = fetch(&s.env.svm, &asset);
    assert_eq!(a.status, AssetStatus::Held);
    expect_err(s.accept_offer(2), HeirloomError::BadStatus);

    // Relisted: the upheld objection no longer blocks, but the offer made before it was upheld can't be
    // accepted (M8): it is withdrawn, made again and waits out the window.
    let i = ix(
        heirloom::accounts::ListAsset { authority: s.env.agent.pubkey(), estate: s.env.estate, asset },
        heirloom::instruction::ListAsset { duration_secs: DAY },
    );
    send(&mut s.env.svm, i, &[&s.env.agent]).unwrap();
    expect_err(s.accept_offer(2), HeirloomError::OfferTooOld);
    s.withdraw_offer(2).unwrap();
    warp(&mut s.env.svm, 1);
    s.place_offer(2, 9_500 * USDT).unwrap();
    warp(&mut s.env.svm, WINDOW);
    s.accept_offer(2).unwrap();
}

#[test]
fn hardship_objection_pauses_hardship_sale_and_upheld_restores_floor() {
    let mut s = Sale::build(true);
    let people = s.people.take().unwrap();
    let asset = s.asset;
    s.place_offer(1, 7_500 * USDT).unwrap();
    s.approved_hardship(); // verifiers 0 and 2 approve
    let hardship = hardship_pda(&asset, &s.env.kid2.pubkey());

    s.env.object(&people, TargetKind::Hardship, hardship, 0, Some(hardship), Some(asset)).unwrap();
    expect_err(s.accept_offer(1), HeirloomError::ObjectionOpen);

    let (v1, v2) = (s.env.v(1), s.env.v(2));
    s.env.vote_objection(&v1, hardship, true, None, Some(hardship), Some(asset)).unwrap();
    s.env.vote_objection(&v2, hardship, true, None, Some(hardship), Some(asset)).unwrap();
    let h: Hardship = fetch(&s.env.svm, &hardship);
    assert_eq!(h.status, HardshipStatus::Rejected);
    let a: Asset = fetch(&s.env.svm, &asset);
    assert_eq!(a.hardship_beneficiary, None);
    expect_err(s.accept_offer(1), HeirloomError::BelowFloor);
}

// ------------------------------------------------------------------- succession

#[test]
fn succession_first_backup_takes_the_seat_and_can_approve() {
    let (mut env, people) = guardian_env();
    let valid_until = now(&env.svm) + 365 * DAY;
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let rule = env.add_rule(0, kid1, PayeeKind::University, 600 * USDT, 1_000 * USDT, valid_until);

    let reporter = env.kp(&env.kid1);
    let (v0, v2) = (env.v(0), env.v(2));
    expect_err(env.review_seat_death(2, true), HeirloomError::NoSuccessionPending);
    env.report_seat_death(&reporter, 2).unwrap();
    expect_err(env.report_seat_death(&reporter, 2), HeirloomError::SuccessionPending);
    expect_err(env.confirm_seat_death(&v0, 2), HeirloomError::AgentNotApproved);
    env.review_seat_death(2, true).unwrap();
    expect_err(env.finalize_succession(2), HeirloomError::NotConfirmer);
    env.confirm_seat_death(&v0, 2).unwrap();
    expect_err(env.finalize_succession(2), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(2).unwrap();

    let heir = env.kp(&people.backups[2][0]);
    let seat = env.seat(2);
    assert_eq!(seat.holder, heir.pubkey());
    assert_eq!(seat.backups, [people.backups[2][1].pubkey(), d()]);
    assert_eq!(seat.monitors[0], people.monitors[2].pubkey());
    assert_eq!((seat.generation, seat.vacant, seat.death_cert_hash), (1, false, [0u8; 32]));
    assert_eq!(env.estate_state().verifiers[2], heir.pubkey());

    // The successor approves at once; the late holder no longer can.
    env.unlock();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    expect_err(env.approve_claim_by(&v2, claim), HeirloomError::NotVerifier);
    env.approve_claim_by(&heir, claim).unwrap();
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.approvals, 0b100);
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn holder_vetoes_their_reported_death() {
    let (mut env, _people) = guardian_env();
    let (reporter, stranger) = (env.kp(&env.kid1), env.kp(&env.stranger));
    let (v0, v2) = (env.v(0), env.v(2));
    expect_err(env.veto_seat_death(&v2, 2), HeirloomError::NoSuccessionPending);
    env.report_seat_death(&reporter, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&v0, 2).unwrap();
    expect_err(env.veto_seat_death(&stranger, 2), HeirloomError::NotVerifier);
    env.veto_seat_death(&v2, 2).unwrap();

    let seat = env.seat(2);
    assert_eq!(seat.holder, v2.pubkey());
    assert_eq!((seat.death_cert_hash, seat.death_verdict, seat.death_pending_since), ([0u8; 32], Verdict::Pending, 0));
    warp(&mut env.svm, SUCCESSION_WAIT);
    expect_err(env.finalize_succession(2), HeirloomError::NoSuccessionPending);
}

#[test]
fn reporter_and_outsiders_cannot_confirm_a_seat_death() {
    let (mut env, _people) = guardian_env();
    let (v0, v1, v2) = (env.v(0), env.v(1), env.v(2));
    let stranger = env.kp(&env.stranger);
    // Nobody reports their own death.
    expect_err(env.report_seat_death(&v2, 2), HeirloomError::BadStatus);
    env.report_seat_death(&v0, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    expect_err(env.confirm_seat_death(&v0, 2), HeirloomError::NotConfirmer);
    expect_err(env.confirm_seat_death(&stranger, 2), HeirloomError::NotConfirmer);
    env.confirm_seat_death(&v1, 2).unwrap();
    expect_err(env.confirm_seat_death(&v1, 2), HeirloomError::AlreadyApproved);
}

#[test]
fn agent_rejection_clears_seat_death_report() {
    let (mut env, _people) = guardian_env();
    let reporter = env.kp(&env.kid1);
    let v0 = env.v(0);
    env.report_seat_death(&reporter, 2).unwrap();
    env.review_seat_death(2, false).unwrap();
    assert_eq!(env.seat(2).death_cert_hash, [0u8; 32]);
    expect_err(env.confirm_seat_death(&v0, 2), HeirloomError::NoSuccessionPending);
}

#[test]
fn no_backups_leaves_the_seat_vacant() {
    let (mut env, _people) = guardian_env();
    let owner = env.kp(&env.owner);
    let v1 = env.v(1);
    env.set_seat_backups(&owner, 0, [d(), d()]).unwrap();
    env.succeed(0, &v1);

    let seat = env.seat(0);
    assert!(seat.vacant);
    assert_eq!((seat.holder, seat.generation), (d(), 1));
    assert_eq!(env.estate_state().verifiers[0], d());
    let reporter = env.kp(&env.kid1);
    expect_err(env.report_seat_death(&reporter, 0), HeirloomError::SeatVacant);
}

#[test]
fn last_holder_confirmed_by_second_backup_never_the_first() {
    let (mut env, people) = guardian_env();
    let owner = env.kp(&env.owner);
    let (v0, v1, v2) = (env.v(0), env.v(1), env.v(2));
    env.set_seat_backups(&owner, 0, [d(), d()]).unwrap();
    env.set_seat_backups(&owner, 1, [d(), d()]).unwrap();
    env.succeed(0, &v1);
    env.succeed(1, &v2);
    assert!(env.seat(0).vacant && env.seat(1).vacant);

    // Seat 2: no other living holder, so backups[1] (or a monitor) confirms; backups[0] can't.
    let reporter = env.kp(&env.kid1);
    env.report_seat_death(&reporter, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    let (first, second) = (env.kp(&people.backups[2][0]), env.kp(&people.backups[2][1]));
    expect_err(env.confirm_seat_death(&first, 2), HeirloomError::NotConfirmer);
    expect_err(env.confirm_seat_death(&v0, 2), HeirloomError::NotConfirmer);
    env.confirm_seat_death(&second, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(2).unwrap();
    assert_eq!(env.seat(2).holder, first.pubkey());
}

#[test]
fn chain_of_succession_twice_reaches_generation_two() {
    let (mut env, people) = guardian_env();
    let v0 = env.v(0);
    env.succeed(2, &v0);
    let heir = env.kp(&people.backups[2][0]);
    assert_eq!(env.seat(2).holder, heir.pubkey());

    // The new holder names their own backup.
    let next = funded(&mut env.svm);
    let owner_pk = env.owner.pubkey();
    expect_err(env.set_seat_backups(&heir, 2, [owner_pk, d()]), HeirloomError::BadBackup);
    env.set_seat_backups(&heir, 2, [next.pubkey(), d()]).unwrap();

    env.succeed(2, &v0);
    let seat = env.seat(2);
    assert_eq!((seat.holder, seat.generation, seat.backups), (next.pubkey(), 2, [d(), d()]));
    assert_eq!(env.estate_state().verifiers[2], next.pubkey());
}

#[test]
fn succession_objection_blocks_and_upheld_clears_it() {
    let (mut env, people) = guardian_env();
    let reporter = env.kp(&env.kid1);
    let (v0, v1) = (env.v(0), env.v(1));
    env.report_seat_death(&reporter, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&v0, 2).unwrap();
    let seat = seat_pda(&env.estate, 2);
    env.object(&people, TargetKind::Succession, seat, 2, None, None).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    expect_err(env.finalize_succession(2), HeirloomError::ObjectionOpen);
    env.vote_objection(&v0, seat, true, None, Some(seat), None).unwrap();
    env.vote_objection(&v1, seat, true, None, Some(seat), None).unwrap();
    assert_eq!(env.seat(2).death_cert_hash, [0u8; 32]);
    expect_err(env.finalize_succession(2), HeirloomError::NoSuccessionPending);
}

#[test]
fn seat_and_fallback_settings_are_validated() {
    let (mut env, people) = guardian_env();
    let (owner, stranger, v0) = (env.kp(&env.owner), env.kp(&env.stranger), env.v(0));
    let (o, v1) = (env.owner.pubkey(), env.verifiers[1].pubkey());
    let x = people.backups[0][0].pubkey();

    expect_err(env.set_seat_backups(&owner, 0, [o, d()]), HeirloomError::BadBackup);
    expect_err(env.set_seat_backups(&owner, 0, [v1, d()]), HeirloomError::BadBackup);
    expect_err(env.set_seat_backups(&owner, 0, [v0.pubkey(), d()]), HeirloomError::BadBackup);
    expect_err(env.set_seat_backups(&owner, 0, [x, x]), HeirloomError::BadBackup);
    expect_err(env.set_seat_backups(&stranger, 0, [x, d()]), HeirloomError::NotOwner);
    // The holder may set their own backups; a lone second entry is moved to the front.
    env.set_seat_backups(&v0, 0, [d(), x]).unwrap();
    assert_eq!(env.seat(0).backups, [x, d()]);

    expect_err(env.set_seat_monitors(0, [v0.pubkey(), d()]), HeirloomError::BadMonitor);
    expect_err(env.set_seat_monitors(0, [x, x]), HeirloomError::BadMonitor);
    env.set_seat_monitors(0, [people.monitors[1].pubkey(), d()]).unwrap();

    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    expect_err(env.set_fallback([k1, o, d(), d()]), HeirloomError::BadFallback);
    expect_err(env.set_fallback([k1, k1, d(), d()]), HeirloomError::BadFallback);
    env.set_fallback([k1, k2, d(), d()]).unwrap();
    assert_eq!(env.guard().fallback, [k1, k2, d(), d()]);
}

// ------------------------------------------------------------------- fallback plan

/// Guarded estate with the fallback list [kid1, kid2, executor] and the owner's death claim agent-approved.
fn fallback_env() -> (Env, People) {
    let (mut env, people) = guardian_env();
    let (k1, k2, ex) = (env.kid1.pubkey(), env.kid2.pubkey(), env.executor.pubkey());
    env.set_fallback([k1, k2, ex, d()]).unwrap();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    (env, people)
}

/// Every seat holder dies with no backups left.
fn vacate_all(env: &mut Env, people: &People) {
    let owner = env.kp(&env.owner);
    for i in 0..3 {
        env.set_seat_backups(&owner, i, [d(), d()]).unwrap();
    }
    let (v1, v2) = (env.v(1), env.v(2));
    env.succeed(0, &v1);
    env.succeed(1, &v2);
    let m2 = env.kp(&people.monitors[2]);
    env.succeed(2, &m2);
    assert!((0..3).all(|i| env.seat(i).vacant));
}

#[test]
fn fallback_blocked_while_a_seat_is_filled_or_owner_alive() {
    let (mut env, people) = fallback_env();
    expect_err(env.start_fallback(), HeirloomError::SeatsNotVacant);

    // All seats vacant but no proof of the owner's death: not ready.
    let (mut env2, people2) = guardian_env();
    let k1 = env2.kid1.pubkey();
    env2.set_fallback([k1, d(), d(), d()]).unwrap();
    vacate_all(&mut env2, &people2);
    expect_err(env2.start_fallback(), HeirloomError::FallbackNotReady);

    // Two of three vacant is still not enough.
    let owner = env.kp(&env.owner);
    env.set_seat_backups(&owner, 0, [d(), d()]).unwrap();
    env.set_seat_backups(&owner, 1, [d(), d()]).unwrap();
    let (v1, v2) = (env.v(1), env.v(2));
    env.succeed(0, &v1);
    env.succeed(1, &v2);
    expect_err(env.start_fallback(), HeirloomError::SeatsNotVacant);
    let _ = people;
}

#[test]
fn fallback_pays_whole_vault_to_first_recipient() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackNotReady);
    env.start_fallback().unwrap();
    expect_err(env.start_fallback(), HeirloomError::BadStatus);
    expect_err(env.execute_fallback(k1), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, FALLBACK_WAIT);
    expect_err(env.execute_fallback(k2), HeirloomError::NoFallbackRecipient);
    env.execute_fallback(k1).unwrap();

    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 5_000 * USDT);
    assert_eq!(balance(&env.svm, &env.vault()), 0);
    assert!(env.guard().fallback_done);
    assert_eq!(env.estate_state().status, EstateStatus::Unlocked);
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackDone);
}

#[test]
fn fallback_skips_a_recipient_proven_dead() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    env.start_fallback().unwrap();
    env.report_fallback_death(0).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    env.review_fallback_death(0, true).unwrap();
    assert_eq!(env.guard().fallback_dead, 0, "the agent's review alone changes nothing");
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    let m0 = env.kp(&people.monitors[0]);
    env.resolve_fallback_death(&m0, 0, Some(0), true).unwrap();
    let g = env.guard();
    assert_eq!(g.fallback_dead, 0b1);
    // The recipient changed, so the countdown restarted.
    assert_eq!(g.fallback_started_at, now(&env.svm));
    expect_err(env.report_fallback_death(0), HeirloomError::BadStatus);

    warp(&mut env.svm, FALLBACK_WAIT / 2);
    expect_err(env.execute_fallback(k2), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    expect_err(env.execute_fallback(k1), HeirloomError::NoFallbackRecipient);
    env.execute_fallback(k2).unwrap();
    assert_eq!(balance(&env.svm, &ata(&k2, &env.usdt_mint)), 5_000 * USDT);
    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 0);
}

#[test]
fn open_objection_blocks_execute_fallback() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let guard = guard_pda(&env.estate);
    let (kid2, stranger) = (env.kp(&env.kid2), env.kp(&env.stranger));
    let k1 = env.kid1.pubkey();

    expect_err(
        env.raise_objection(&stranger, TargetKind::Fallback, guard, 255, None, false, None, None),
        HeirloomError::NotMonitor,
    );
    // A beneficiary may object to the fallback (raised 10 s in, so it is still open, not lapsed,
    // when the countdown ends).
    warp(&mut env.svm, 10);
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT - 10);
    expect_err(env.execute_fallback(k1), HeirloomError::ObjectionOpen);

    // Every holder is gone, so monitors decide; the objector can't vote.
    let (m0, m1) = (env.kp(&people.monitors[0]), env.kp(&people.monitors[1]));
    let (s0, s1) = (env.all_seats(), env.all_seats());
    expect_err(env.vote_objection(&kid2, guard, false, None, None, None), HeirloomError::NotVerifier);
    expect_err(env.vote_objection(&m0, guard, true, None, None, None), HeirloomError::NotMonitor);
    env.vote_objection(&m0, guard, true, s0, None, None).unwrap();
    env.vote_objection(&m1, guard, true, s1, None, None).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Upheld);
    assert_eq!(env.guard().fallback_started_at, 0);
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackNotReady);

    // A fresh start runs the full wait again.
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    env.execute_fallback(k1).unwrap();
}

#[test]
fn owner_heartbeat_voids_a_started_fallback() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    warp(&mut env.svm, 10);
    let i = ix(
        heirloom::accounts::Heartbeat { owner: env.owner.pubkey(), estate: env.estate },
        heirloom::instruction::Heartbeat {},
    );
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    let k1 = env.kid1.pubkey();
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackNotReady);
}

// ------------------------------------------------------------------- asset photos

#[test]
fn asset_media_set_by_the_living_owner_only() {
    let mut env = Env::configured();
    let owner = env.owner.pubkey();
    let nft_mint = create_title(&mut env.svm);
    let owner_nft = fund_ata(&mut env.svm, &owner, &nft_mint, 1);
    let asset = asset_pda(&env.estate, &nft_mint);
    let i = ix(
        heirloom::accounts::RegisterAsset {
            owner,
            estate: env.estate,
            nft_mint,
            owner_nft,
            nft_escrow: ata(&env.estate, &nft_mint),
            asset,
            token_program: token_program(),
            associated_token_program: ata_program(),
            system_program: system_program(),
        },
        heirloom::instruction::RegisterAsset {
            floor_price: FLOOR,
            hardship_floor: HARDSHIP_FLOOR,
            asking_price: ASKING,
            proceeds_to: env.executor.pubkey(),
            doc_hash: [3u8; 32],
        },
    );
    send(&mut env.svm, i, &[&env.owner]).unwrap();

    let set = |env: &Env, who: &Keypair, count: u8| {
        ix(
            heirloom::accounts::SetAssetMedia {
                authority: who.pubkey(),
                estate: env.estate,
                asset,
                media: media_pda(&asset),
                system_program: system_program(),
            },
            heirloom::instruction::SetAssetMedia { kind: AssetKind::Motorbike, photos_root: [count; 32], photo_count: count },
        )
    };
    let (o, a, s) = (env.kp(&env.owner), env.kp(&env.agent), env.kp(&env.stranger));
    // At most 24 photos (MAX_PHOTOS): 25 is refused, 24 is accepted.
    let i = set(&env, &o, 25);
    expect_err(send(&mut env.svm, i, &[&o]), HeirloomError::InvalidAmount);
    let i = set(&env, &o, 24);
    send(&mut env.svm, i, &[&o]).unwrap();
    let m: AssetMedia = fetch(&env.svm, &media_pda(&asset));
    assert_eq!(m.photo_count, 24);
    let i = set(&env, &s, 3);
    expect_err(send(&mut env.svm, i, &[&s]), HeirloomError::NotOwner);
    let i = set(&env, &o, 3);
    send(&mut env.svm, i, &[&o]).unwrap();
    let m: AssetMedia = fetch(&env.svm, &media_pda(&asset));
    assert_eq!((m.asset, m.kind, m.photo_count, m.photos_root), (asset, AssetKind::Motorbike, 3, [3u8; 32]));

    let i = set(&env, &a, 5);
    expect_err(send(&mut env.svm, i, &[&a]), HeirloomError::NotOwner);

    // After the unlock nobody can update the photos.
    env.unlock();
    let i = set(&env, &o, 5);
    expect_err(send(&mut env.svm, i, &[&o]), HeirloomError::NotOwner);
    let i = set(&env, &a, 5);
    expect_err(send(&mut env.svm, i, &[&a]), HeirloomError::NotOwner);
    let m: AssetMedia = fetch(&env.svm, &media_pda(&asset));
    assert_eq!(m.photo_count, 3);
}

// ------------------------------------------------------------------- fallback objections lapse (funds never locked forever)

#[test]
fn fallback_objection_with_no_monitors_lapses_and_fallback_pays() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    for i in 0..3 {
        env.set_seat_monitors(i, [d(), d()]).unwrap();
    }
    env.claim_again();
    env.start_fallback().unwrap();
    let started = env.guard().fallback_started_at;
    let guard = guard_pda(&env.estate);
    let kid2 = env.kp(&env.kid2);
    let k1 = env.kid1.pubkey();

    // Raised halfway through the countdown: nobody can vote on it.
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    expect_err(env.execute_fallback(k1), HeirloomError::ObjectionOpen);
    expect_err(env.lapse_objection(guard), HeirloomError::ObjectionNotLapsed);

    // Lapses fallback_wait after it was raised; the countdown itself did not restart.
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    assert_eq!(env.guard().fallback_started_at, started);
    env.execute_fallback(k1).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Dismissed);
    assert_eq!(env.guard().open_objections, 0);
    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 5_000 * USDT);
}

#[test]
fn tied_fallback_objection_lapses() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let started = env.guard().fallback_started_at;
    let guard = guard_pda(&env.estate);
    let kid2 = env.kp(&env.kid2);
    let k1 = env.kid1.pubkey();
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();

    let (m0, m1, m2) = (env.kp(&people.monitors[0]), env.kp(&people.monitors[1]), env.kp(&people.monitors[2]));
    let (s0, s1, s2) = (env.all_seats(), env.all_seats(), env.all_seats());
    env.vote_objection(&m0, guard, true, s0, None, None).unwrap();
    env.vote_objection(&m1, guard, false, s1, None, None).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Open);

    warp(&mut env.svm, FALLBACK_WAIT);
    // Too late to break the tie.
    expect_err(env.vote_objection(&m2, guard, true, s2, None, None), HeirloomError::ObjectionLapsed);
    env.lapse_objection(guard).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Dismissed);
    assert_eq!(env.guard().open_objections, 0);
    assert_eq!(env.guard().fallback_started_at, started);
    expect_err(env.lapse_objection(guard), HeirloomError::BadStatus);
    // No second objection in the same countdown.
    expect_err(
        env.raise_objection(&kid2, TargetKind::Fallback, guard, 255, None, true, None, None),
        HeirloomError::BadStatus,
    );
    env.execute_fallback(k1).unwrap();
    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 5_000 * USDT);
}

#[test]
fn fallback_objection_upheld_before_lapse_resets_the_fallback() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let guard = guard_pda(&env.estate);
    let kid2 = env.kp(&env.kid2);
    let k1 = env.kid1.pubkey();
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();

    warp(&mut env.svm, FALLBACK_WAIT - 1);
    let (m0, m1) = (env.kp(&people.monitors[0]), env.kp(&people.monitors[1]));
    let (s0, s1) = (env.all_seats(), env.all_seats());
    env.vote_objection(&m0, guard, true, s0, None, None).unwrap();
    env.vote_objection(&m1, guard, true, s1, None, None).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Upheld);
    assert_eq!(env.guard().fallback_started_at, 0);

    warp(&mut env.svm, FALLBACK_WAIT);
    expect_err(env.lapse_objection(guard), HeirloomError::BadStatus);
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackNotReady);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

// =================================================================== disputes (U9, 2026-11-15)

const YEAR: i64 = 365 * DAY;

impl Env {
    fn raise_dispute(&mut self, disputer: &Keypair, kind: TargetKind, target: Pubkey, as_beneficiary: bool, reason: [u8; 32]) -> Result<(), String> {
        let target_account = (kind == TargetKind::Claim).then_some(target);
        let i = ix(
            heirloom::accounts::RaiseDispute {
                disputer: disputer.pubkey(),
                estate: self.estate,
                beneficiary_account: as_beneficiary.then(|| beneficiary_pda(&self.estate, &disputer.pubkey())),
                target_account,
                objection: objection_pda(&target),
                system_program: system_program(),
                guard: guard_pda(&self.estate),
            },
            heirloom::instruction::RaiseDispute { kind, target, reason_hash: reason },
        );
        send(&mut self.svm, i, &[disputer])
    }

    /// kid2 (a beneficiary) disputes `target`.
    fn kid_disputes(&mut self, kind: TargetKind, target: Pubkey) -> Result<(), String> {
        let kid2 = self.kid2.insecure_clone();
        self.raise_dispute(&kid2, kind, target, true, [5u8; 32])
    }

    fn resolve_dispute(&mut self, verifier: &Keypair, target: Pubkey, uphold: bool, is_claim: bool) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ResolveDispute {
                verifier: verifier.pubkey(),
                estate: self.estate,
                objection: objection_pda(&target),
                target_account: is_claim.then_some(target),
            },
            heirloom::instruction::ResolveDispute { uphold },
        );
        send(&mut self.svm, i, &[verifier])
    }

    fn set_yearly_cap(&mut self, rule: Pubkey, cap: u64, period_start: i64) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetYearlyCap {
                owner: self.owner.pubkey(),
                estate: self.estate,
                rule,
                year_cap: year_cap_pda(&rule),
                system_program: system_program(),
            },
            heirloom::instruction::SetYearlyCap { cap, period_start },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn year_cap(&self, rule: &Pubkey) -> YearCap {
        fetch(&self.svm, &year_cap_pda(rule))
    }

    /// Death claim submitted, agent-approved and attested by 2 verifiers: DeathPending.
    fn death_pending(&mut self) {
        self.submit_death_claim(1).unwrap();
        self.review_death(true).unwrap();
        self.attest_death(0).unwrap();
        self.attest_death(1).unwrap();
        assert_eq!(self.estate_state().status, EstateStatus::DeathPending);
    }
}

/// Unguarded estate, unlocked, with an agent- and verifier-approved 100 USD₮ claim on kid1's tuition rule.
fn disputed_claim_env() -> (Env, Pubkey, Pubkey) {
    let (mut env, rule) = claims_env();
    env.unlock();
    let claim = approved_claim(&mut env, rule);
    (env, rule, claim)
}

#[test]
fn beneficiary_dispute_freezes_claim_and_two_verifiers_uphold() {
    let (mut env, rule, claim) = disputed_claim_env();
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    let o = env.objection(&claim);
    assert_eq!((o.status, o.kind, o.seat_index, o.monitor), (ObjectionStatus::Open, TargetKind::Claim, 254, env.kid2.pubkey()));
    assert_eq!(o.reason_hash, [5u8; 32]);
    // Frozen: no Guard needed for a dispute to pause the payment.
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);
    expect_err(env.kid_disputes(TargetKind::Claim, claim), HeirloomError::ObjectionOpen);

    let kid2 = env.kp(&env.kid2);
    expect_err(env.resolve_dispute(&kid2, claim, true, true), HeirloomError::NotVerifier);
    let (v0, v1) = (env.v(0), env.v(1));
    env.resolve_dispute(&v0, claim, true, true).unwrap();
    expect_err(env.resolve_dispute(&v0, claim, false, true), HeirloomError::AlreadyApproved);
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Open);
    env.resolve_dispute(&v1, claim, true, true).unwrap();

    assert_eq!(env.objection(&claim).status, ObjectionStatus::Upheld);
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.status, ClaimStatus::Rejected);
    expect_err(env.execute_claim(rule, claim), HeirloomError::BadStatus);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

#[test]
fn dismissed_dispute_lets_claim_pay_and_cannot_be_raised_again() {
    let (mut env, rule, claim) = disputed_claim_env();
    // A verifier disputes; they can't then vote on their own dispute.
    let (v0, v1, v2) = (env.v(0), env.v(1), env.v(2));
    env.raise_dispute(&v1, TargetKind::Claim, claim, false, [5u8; 32]).unwrap();
    expect_err(env.resolve_dispute(&v1, claim, false, true), HeirloomError::NotVerifier);
    env.resolve_dispute(&v0, claim, false, true).unwrap();
    env.resolve_dispute(&v2, claim, false, true).unwrap();
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Dismissed);
    expect_err(env.resolve_dispute(&v2, claim, true, true), HeirloomError::BadStatus);

    // One challenge per claim: a dismissed dispute can't be raised again to freeze it anew.
    expect_err(env.kid_disputes(TargetKind::Claim, claim), HeirloomError::BadStatus);
    env.execute_claim(rule, claim).unwrap();
    assert_eq!(balance(&env.svm, &ata(&env.university.pubkey(), &env.usdt_mint)), 100 * USDT);
}

#[test]
fn dispute_lapses_so_funds_are_never_locked() {
    let (mut env, rule, claim) = disputed_claim_env();
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    let v0 = env.v(0);
    env.resolve_dispute(&v0, claim, true, true).unwrap(); // one vote only: no decision
    warp(&mut env.svm, WAITING - 1);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);
    warp(&mut env.svm, 1);
    // Lapsed after the estate's waiting period: it counts as dismissed and can no longer be voted on.
    let v1 = env.v(1);
    expect_err(env.resolve_dispute(&v1, claim, true, true), HeirloomError::DisputeLapsed);
    expect_err(env.kid_disputes(TargetKind::Claim, claim), HeirloomError::BadStatus);
    env.execute_claim(rule, claim).unwrap();
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.status, ClaimStatus::Paid);
}

#[test]
fn only_beneficiaries_and_verifiers_can_dispute_pending_actions() {
    let (mut env, rule, claim) = disputed_claim_env();
    let stranger = env.kp(&env.stranger);
    expect_err(env.raise_dispute(&stranger, TargetKind::Claim, claim, false, [5u8; 32]), HeirloomError::NotDisputer);
    // A beneficiary must pass their Beneficiary PDA.
    let kid2 = env.kp(&env.kid2);
    expect_err(env.raise_dispute(&kid2, TargetKind::Claim, claim, false, [5u8; 32]), HeirloomError::NotDisputer);
    // A reason is required (its hash).
    expect_err(env.raise_dispute(&kid2, TargetKind::Claim, claim, true, [0u8; 32]), HeirloomError::InvalidAmount);
    // Only claims and unlocks; the estate is Unlocked, so there is no pending unlock either.
    let estate = env.estate;
    expect_err(env.kid_disputes(TargetKind::Unlock, estate), HeirloomError::BadStatus);
    // A paid claim is no longer pending.
    env.execute_claim(rule, claim).unwrap();
    expect_err(env.kid_disputes(TargetKind::Claim, claim), HeirloomError::BadStatus);
}

#[test]
fn unlock_dispute_blocks_finalize_and_upheld_clears_death_claim() {
    let mut env = Env::configured();
    env.death_pending();
    let estate = env.estate;
    warp(&mut env.svm, WAITING / 2);
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    warp(&mut env.svm, WAITING / 2);
    expect_err(env.finalize_unlock(), HeirloomError::ObjectionOpen);

    let (v0, v2) = (env.v(0), env.v(2));
    env.resolve_dispute(&v0, estate, true, false).unwrap();
    env.resolve_dispute(&v2, estate, true, false).unwrap();
    let e = env.estate_state();
    assert_eq!(e.status, EstateStatus::Active);
    assert_eq!(e.death_cert_hash, [0u8; 32]);
    expect_err(env.finalize_unlock(), HeirloomError::BadStatus);
    // No pending unlock any more, so nothing to dispute.
    expect_err(env.kid_disputes(TargetKind::Unlock, estate), HeirloomError::BadStatus);
}

#[test]
fn unlock_dispute_once_per_waiting_period_and_dismissed_unlock_proceeds() {
    let mut env = Env::configured();
    env.death_pending();
    let estate = env.estate;
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    let (v0, v1) = (env.v(0), env.v(1));
    env.resolve_dispute(&v0, estate, false, false).unwrap();
    env.resolve_dispute(&v1, estate, false, false).unwrap();
    assert_eq!(env.objection(&estate).status, ObjectionStatus::Dismissed);
    let v2 = env.v(2);
    expect_err(env.raise_dispute(&v2, TargetKind::Unlock, estate, false, [5u8; 32]), HeirloomError::BadStatus);
    warp(&mut env.svm, WAITING);
    env.finalize_unlock().unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::Unlocked);
}

#[test]
fn new_waiting_period_can_be_disputed_again() {
    let mut env = Env::configured();
    env.death_pending();
    let estate = env.estate;
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    warp(&mut env.svm, WAITING); // lapses
    env.veto_death().unwrap(); // the owner is alive after all
    warp(&mut env.svm, 10);
    env.death_pending(); // a later death claim starts a new waiting period
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);
}

#[test]
fn disputes_share_the_objection_pda_with_monitors() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    assert_eq!(env.guard().open_objections, 0); // disputes are not monitor objections
    // While the dispute is open, a monitor's objection would only duplicate the freeze.
    expect_err(env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None), HeirloomError::ObjectionOpen);
    // Monitors' voting rules don't apply to disputes.
    let v1 = env.v(1);
    expect_err(env.vote_objection(&v1, claim, true, None, Some(claim), None), HeirloomError::BadStatus);
    // After the lapse the monitors still have their own objection; only theirs can use it up.
    warp(&mut env.svm, WAITING);
    env.svm.expire_blockhash();
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);
    warp(&mut env.svm, 2 * WAITING + WINDOW);
    env.svm.expire_blockhash();
    env.execute_claim(rule, claim).unwrap();
}

// =================================================================== yearly caps (2026-11-15)

/// kid1's tuition: 600 per claim, 3,000 lifetime, valid 3 years; a yearly cap of 800; unlocked.
fn capped_env() -> (Env, Pubkey) {
    let mut env = Env::configured();
    let valid_until = now(&env.svm) + 3 * YEAR;
    let kid1 = env.kid1.pubkey();
    let rule = env.add_rule(0, kid1, PayeeKind::University, 600 * USDT, 3_000 * USDT, valid_until);
    env.set_yearly_cap(rule, 800 * USDT, 0).unwrap();
    env.unlock();
    (env, rule)
}

#[test]
fn yearly_cap_limits_claims_per_period_and_resets() {
    let (mut env, rule) = capped_env();
    let uni = env.university.pubkey();
    let start = env.year_cap(&rule).period_start;
    env.pay_claim(rule, uni, 600 * USDT);
    assert_eq!(env.year_cap(&rule).period_spent, 600 * USDT);
    // 600 + 300 > 800 for this year, though within the per-claim and lifetime caps.
    expect_err(env.submit_claim(true, rule, uni, 300 * USDT), HeirloomError::ExceedsYearlyCap);
    env.pay_claim(rule, uni, 200 * USDT);
    assert_eq!(env.year_cap(&rule).period_spent, 800 * USDT);
    expect_err(env.submit_claim(true, rule, uni, USDT), HeirloomError::ExceedsYearlyCap);

    // The next 12-month period starts from zero.
    warp(&mut env.svm, YEAR);
    env.pay_claim(rule, uni, 600 * USDT);
    let yc = env.year_cap(&rule);
    assert_eq!((yc.period_start, yc.period_spent), (start + YEAR, 600 * USDT));
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!(r.spent_total, 1_400 * USDT);
}

#[test]
fn yearly_cap_rechecked_at_execution() {
    let (mut env, rule) = capped_env();
    let uni = env.university.pubkey();
    let a = env.submit_claim(true, rule, uni, 500 * USDT).unwrap();
    let b = env.submit_claim(true, rule, uni, 500 * USDT).unwrap();
    for c in [a, b] {
        env.review_claim(c, true).unwrap();
        env.approve_claim(c, 0).unwrap();
    }
    env.execute_claim(rule, a).unwrap();
    expect_err(env.execute_claim(rule, b), HeirloomError::ExceedsYearlyCap);
    warp(&mut env.svm, YEAR);
    env.execute_claim(rule, b).unwrap();
    assert_eq!(env.year_cap(&rule).period_spent, 500 * USDT);
}

#[test]
fn yearly_cap_is_validated_and_set_only_while_active() {
    let mut env = Env::configured();
    warp(&mut env.svm, 200 * DAY); // so that "100 days ago" is a valid time
    let valid_until = now(&env.svm) + 3 * YEAR;
    let kid1 = env.kid1.pubkey();
    let rule = env.add_rule(0, kid1, PayeeKind::University, 600 * USDT, 3_000 * USDT, valid_until);
    expect_err(env.set_yearly_cap(rule, 0, 0), HeirloomError::InvalidAmount);
    expect_err(env.set_yearly_cap(rule, 3_001 * USDT, 0), HeirloomError::InvalidAmount);
    let future = now(&env.svm) + DAY;
    expect_err(env.set_yearly_cap(rule, 800 * USDT, future), HeirloomError::InvalidAmount);

    // A period can start in the past (e.g. 1 January); it rolls forward when used.
    let jan = now(&env.svm) - 100 * DAY;
    env.set_yearly_cap(rule, 800 * USDT, jan).unwrap();
    assert_eq!(env.year_cap(&rule).period_start, jan);
    // Update: new cap, period kept.
    env.set_yearly_cap(rule, 900 * USDT, 0).unwrap();
    let yc = env.year_cap(&rule);
    assert_eq!((yc.cap, yc.period_start, yc.rule), (900 * USDT, jan, rule));

    // Only the owner (another signer can't produce the owner's estate PDA).
    let stranger = env.kp(&env.stranger);
    let i = ix(
        heirloom::accounts::SetYearlyCap {
            owner: stranger.pubkey(),
            estate: env.estate,
            rule,
            year_cap: year_cap_pda(&rule),
            system_program: system_program(),
        },
        heirloom::instruction::SetYearlyCap { cap: 3_000 * USDT, period_start: 0 },
    );
    assert!(send(&mut env.svm, i, &[&stranger]).is_err());

    env.unlock();
    expect_err(env.set_yearly_cap(rule, 3_000 * USDT, 0), HeirloomError::BadStatus);
}

#[test]
fn yearly_cap_applies_to_scheduled_payments() {
    let mut env = Env::configured();
    let (kid1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let valid_until = now(&env.svm) + 3 * YEAR;
    let first_due = now(&env.svm);
    let month = 30 * DAY;
    // Living plan: 100 a month to the university; at most 250 a year.
    let i = env.add_rule_ix(0, kid1, PayeeKind::University, 600 * USDT, 3_000 * USDT, valid_until, true, 100 * USDT, month, first_due, Some(uni));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    // The cap must cover at least one instalment.
    expect_err(env.set_yearly_cap(rule, 99 * USDT, 0), HeirloomError::InvalidAmount);
    env.set_yearly_cap(rule, 250 * USDT, 0).unwrap();

    env.execute_scheduled(rule).unwrap();
    warp(&mut env.svm, month);
    env.execute_scheduled(rule).unwrap();
    warp(&mut env.svm, month);
    expect_err(env.execute_scheduled(rule), HeirloomError::ExceedsYearlyCap);
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!(r.next_due, first_due + 2 * month); // the instalment waits
    warp(&mut env.svm, YEAR - 2 * month);
    env.execute_scheduled(rule).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 300 * USDT);
    assert_eq!(env.year_cap(&rule).period_spent, 100 * USDT);
}

// =================================================================== fee sponsorship (2026-11-15)

/// Permissionless calls (finalize_unlock, finalize_succession, start_fallback, lapse_objection) take any
/// wallet as `caller`, so a sponsor can be the fee payer while a wallet with no SOL signs.
#[test]
fn permissionless_calls_can_be_sponsored() {
    let mut env = Env::configured();
    env.death_pending();
    warp(&mut env.svm, WAITING);
    let sponsor = funded(&mut env.svm);
    let caller = Keypair::new(); // no SOL at all
    let i = ix(
        heirloom::accounts::FinalizeUnlock { estate: env.estate, objection: objection_pda(&env.estate), caller: caller.pubkey() },
        heirloom::instruction::FinalizeUnlock {},
    );
    // The caller must sign.
    let mut unsigned = i.clone();
    unsigned.accounts.iter_mut().for_each(|m| m.is_signer = false);
    expect_err_any(send(&mut env.svm, unsigned, &[&sponsor]));
    send(&mut env.svm, i, &[&sponsor, &caller]).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::Unlocked);
}

fn expect_err_any(res: Result<(), String>) {
    assert!(res.is_err(), "expected the transaction to fail");
}

#[test]
fn sponsored_finalize_succession_and_start_fallback() {
    let (mut env, people) = guardian_env();
    // Seat 2's holder dies; the first backup takes over, finalized by a no-SOL wallet with a sponsor paying.
    let kid1 = env.kp(&env.kid1);
    let v0 = env.v(0);
    env.report_seat_death(&kid1, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&v0, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    let sponsor = funded(&mut env.svm);
    let caller = Keypair::new();
    let seat = seat_pda(&env.estate, 2);
    let i = ix(
        heirloom::accounts::FinalizeSuccession {
            estate: env.estate,
            guard: guard_pda(&env.estate),
            seat,
            objection: objection_pda(&seat),
            caller: caller.pubkey(),
        },
        heirloom::instruction::FinalizeSuccession { index: 2 },
    );
    send(&mut env.svm, i, &[&sponsor, &caller]).unwrap();
    assert_eq!(env.seat(2).holder, people.backups[2][0].pubkey());

    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    let sponsor = funded(&mut env.svm);
    let caller = Keypair::new();
    let e = env.estate;
    let i = ix(
        heirloom::accounts::StartFallback {
            estate: e,
            guard: guard_pda(&e),
            seat0: seat_pda(&e, 0),
            seat1: seat_pda(&e, 1),
            seat2: seat_pda(&e, 2),
            caller: caller.pubkey(),
        },
        heirloom::instruction::StartFallback {},
    );
    send(&mut env.svm, i, &[&sponsor, &caller]).unwrap();
    assert!(env.guard().fallback_started_at > 0);
}

// =================================================================== judge-review fixes (2026-11-22, plan §17)
// Each attack in this section succeeded on the program deployed before the fix.

fn residual_pda(estate: &Pubkey) -> Pubkey {
    pda(&[b"residual", estate.as_ref()])
}
fn agent_vote_pda(estate: &Pubkey, candidate: &Pubkey) -> Pubkey {
    pda(&[b"agentvote", estate.as_ref(), candidate.as_ref()])
}

impl Env {
    fn refer_death(&mut self) -> Result<(), String> {
        self.review_death_as(ReviewOutcome::Refer, None)
    }

    fn refer_claim(&mut self, claim: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReviewClaim { agent: self.agent.pubkey(), estate: self.estate, claim },
            heirloom::instruction::ReviewClaim { outcome: ReviewOutcome::Refer, report_hash: [2u8; 32] },
        );
        send(&mut self.svm, i, &[&self.agent])
    }

    fn end_rule(&mut self, signer: &Keypair, rule: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::EndRule { owner: signer.pubkey(), estate: self.estate, rule },
            heirloom::instruction::EndRule {},
        );
        send(&mut self.svm, i, &[signer])
    }

    fn set_residual(&mut self, recipient: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetResidual {
                owner: self.owner.pubkey(),
                estate: self.estate,
                residual: residual_pda(&self.estate),
                system_program: system_program(),
            },
            heirloom::instruction::SetResidual { recipient },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn sweep(&mut self, recipient: Pubkey, rules: &[Pubkey]) -> Result<(), String> {
        let guard = guard_pda(&self.estate);
        let index = match self.svm.get_account(&guard) {
            Some(a) if !a.data.is_empty() => self.guard().next_fallback_index(),
            _ => 255,
        };
        self.sweep_with(recipient, rules, fallback_report_pda(&self.estate, index))
    }

    fn sweep_with(&mut self, recipient: Pubkey, rules: &[Pubkey], fallback_report: Pubkey) -> Result<(), String> {
        self.svm.expire_blockhash();
        let mut i = ix(
            heirloom::accounts::SweepResidual {
                payer: self.stranger.pubkey(),
                estate: self.estate,
                residual: residual_pda(&self.estate),
                guard: guard_pda(&self.estate),
                recipient,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                recipient_usdt: ata(&recipient, &self.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                fallback_report,
            },
            heirloom::instruction::SweepResidual {},
        );
        for r in rules {
            i.accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(*r, false));
        }
        send(&mut self.svm, i, &[&self.stranger])
    }

    fn set_agent(&mut self, signer: &Keypair, agent: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetAgent {
                owner: signer.pubkey(),
                estate: self.estate,
                seat0: seat_pda(&self.estate, 0),
                seat1: seat_pda(&self.estate, 1),
                seat2: seat_pda(&self.estate, 2),
                fallback_report0: fallback_report_pda(&self.estate, 0),
                fallback_report1: fallback_report_pda(&self.estate, 1),
                fallback_report2: fallback_report_pda(&self.estate, 2),
                fallback_report3: fallback_report_pda(&self.estate, 3),
            },
            heirloom::instruction::SetAgent { agent },
        );
        send(&mut self.svm, i, &[signer])
    }

    /// As a client does: the voter's Beneficiary PDA as the first remaining account.
    fn vote_agent(&mut self, voter: &Keypair, candidate: Pubkey) -> Result<(), String> {
        let b = beneficiary_pda(&self.estate, &voter.pubkey());
        self.vote_agent_with(voter, candidate, &[b])
    }

    fn vote_agent_with(&mut self, voter: &Keypair, candidate: Pubkey, extra: &[Pubkey]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let mut i = ix(
            heirloom::accounts::VoteAgent {
                verifier: voter.pubkey(),
                estate: self.estate,
                agent_vote: agent_vote_pda(&self.estate, &candidate),
                system_program: system_program(),
                seat0: seat_pda(&self.estate, 0),
                seat1: seat_pda(&self.estate, 1),
                seat2: seat_pda(&self.estate, 2),
                fallback_report0: fallback_report_pda(&self.estate, 0),
                fallback_report1: fallback_report_pda(&self.estate, 1),
                fallback_report2: fallback_report_pda(&self.estate, 2),
                fallback_report3: fallback_report_pda(&self.estate, 3),
            },
            heirloom::instruction::VoteAgent { candidate },
        );
        for k in extra {
            i.accounts.push(AccountMeta::new_readonly(*k, false));
        }
        send(&mut self.svm, i, &[voter])
    }
}

// ------------------------------------------------------------------- P1 disputes

#[test]
fn claimant_cannot_dispute_their_own_claim() {
    let (mut env, people, rule) = guarded_claims();
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    let claimant = env.kid1.insecure_clone();
    expect_err(env.raise_dispute(&claimant, TargetKind::Claim, claim, true, [9u8; 32]), HeirloomError::OwnClaimDispute);

    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);
}

#[test]
fn finished_dispute_never_uses_up_the_monitors_objection() {
    let (mut env, people, rule) = guarded_claims();
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    // A sibling's dispute is left to lapse.
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    warp(&mut env.svm, WAITING);
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();

    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);
}

#[test]
fn dispute_held_over_the_window_gives_monitors_a_fresh_one() {
    let (mut env, _people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    warp(&mut env.svm, WINDOW - 1);
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    warp(&mut env.svm, WAITING);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, WINDOW);
    env.svm.expire_blockhash();
    env.execute_claim(rule, claim).unwrap();
}

// ------------------------------------------------------------------- P2 surplus

#[test]
fn surplus_goes_to_the_residual_recipient_and_reserves_stay() {
    let (mut env, rule) = claims_env();
    let heir = env.kid2.pubkey();
    env.set_residual(heir).unwrap();
    expect_err(env.sweep(heir, &[rule]), HeirloomError::BadStatus);
    env.unlock();

    let uni = env.university.pubkey();
    env.pay_claim(rule, uni, 600 * USDT); // 400 of the 1,000 cap is still reserved
    env.sweep(heir, &[rule]).unwrap();
    assert_eq!(balance(&env.svm, &ata(&heir, &env.usdt_mint)), 4_000 * USDT);
    assert_eq!(balance(&env.svm, &env.vault()), 400 * USDT);
    expect_err(env.sweep(heir, &[rule]), HeirloomError::NothingToSweep);

    // The reserved money still pays the rule.
    env.pay_claim(rule, uni, 400 * USDT);
    assert_eq!(balance(&env.svm, &env.vault()), 0);
}

#[test]
fn expired_rules_release_their_reserve() {
    let (mut env, rule) = claims_env();
    let heir = env.kid2.pubkey();
    env.set_residual(heir).unwrap();
    env.unlock();
    warp(&mut env.svm, 366 * DAY);
    env.sweep(heir, &[rule]).unwrap();
    assert_eq!(balance(&env.svm, &env.vault()), 0);
}

#[test]
fn sweep_needs_every_rule_and_the_named_recipient() {
    let (mut env, r0) = claims_env();
    let (k2, until) = (env.kid2.pubkey(), now(&env.svm) + 365 * DAY);
    let r1 = env.add_rule(1, k2, PayeeKind::Landlord, 500 * USDT, 2_000 * USDT, until);
    env.set_residual(k2).unwrap();
    env.unlock();

    expect_err(env.sweep(k2, &[r0]), HeirloomError::RulesIncomplete);
    expect_err(env.sweep(k2, &[r0, r0]), HeirloomError::RulesIncomplete);
    expect_err(env.sweep(k2, &[r1, r0]), HeirloomError::RulesIncomplete);
    let outsider = env.buyer1.pubkey();
    expect_err(env.sweep(outsider, &[r0, r1]), HeirloomError::NoResidualRecipient);

    env.sweep(k2, &[r0, r1]).unwrap();
    assert_eq!(balance(&env.svm, &env.vault()), 3_000 * USDT);
}

#[test]
fn surplus_defaults_to_the_fallback_recipient_or_to_nobody() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let k1 = env.kid1.pubkey();
    expect_err(env.sweep(k1, &[rule]), HeirloomError::NoResidualRecipient);

    let (mut guarded_env, _people) = guardian_env();
    let heir = guarded_env.kid1.pubkey();
    guarded_env.set_fallback([heir, d(), d(), d()]).unwrap();
    guarded_env.unlock();
    guarded_env.sweep(heir, &[]).unwrap();
    assert_eq!(balance(&guarded_env.svm, &guarded_env.vault()), 0);
}

#[test]
fn residual_recipient_is_set_only_while_active_and_never_the_owner() {
    let mut env = Env::configured();
    let (owner, kid) = (env.owner.pubkey(), env.kid1.pubkey());
    expect_err(env.set_residual(owner), HeirloomError::NoResidualRecipient);
    env.unlock();
    expect_err(env.set_residual(kid), HeirloomError::BadStatus);
}

// ------------------------------------------------------------------- P3 listings

#[test]
fn expired_listing_can_be_listed_again_but_a_live_one_cannot() {
    let mut s = Sale::new();
    let list = |s: &mut Sale, secs: i64| {
        s.env.svm.expire_blockhash();
        let i = ix(
            heirloom::accounts::ListAsset { authority: s.env.agent.pubkey(), estate: s.env.estate, asset: s.asset },
            heirloom::instruction::ListAsset { duration_secs: secs },
        );
        send(&mut s.env.svm, i, &[&s.env.agent])
    };
    expect_err(list(&mut s, DAY), HeirloomError::BadStatus);
    warp(&mut s.env.svm, 4 * DAY);
    expect_err(list(&mut s, 60), HeirloomError::TimeOutOfRange);
    list(&mut s, DAY).unwrap();
    s.place_offer(1, 9_500 * USDT).unwrap();
}

// ------------------------------------------------------------------- P4 instalments

#[test]
fn missed_instalments_pay_once_then_return_to_the_schedule() {
    let mut env = Env::configured();
    let (kid, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let t = now(&env.svm);
    let i = env.add_rule_ix(0, kid, PayeeKind::University, 100 * USDT, 1_200 * USDT, t + 3650 * DAY, false, 100 * USDT, 30 * DAY, t, Some(uni));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    warp(&mut env.svm, 361 * DAY);
    env.unlock();

    env.execute_scheduled(rule).unwrap();
    env.svm.expire_blockhash();
    expect_err(env.execute_scheduled(rule), HeirloomError::NotDue);
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 100 * USDT);
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!(r.next_due, t + 390 * DAY);

    warp(&mut env.svm, 30 * DAY);
    env.svm.expire_blockhash();
    env.execute_scheduled(rule).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 200 * USDT);
}

// ------------------------------------------------------------------- P5 agent rotation

#[test]
fn owner_replaces_the_agent_while_active() {
    let (mut env, _) = claims_env();
    let (owner, stranger) = (env.owner.insecure_clone(), env.stranger.insecure_clone());
    let next = Keypair::new().pubkey();
    assert!(env.set_agent(&stranger, next).is_err());
    let v0 = env.verifiers[0].pubkey();
    expect_err(env.set_agent(&owner, v0), HeirloomError::BadAgent);
    env.unlock();
    expect_err(env.set_agent(&owner, next), HeirloomError::BadStatus);

    let (mut active, _rule) = claims_env();
    let active_owner = active.owner.insecure_clone();
    active.set_agent(&active_owner, next).unwrap();
    assert_eq!(active.estate_state().agent, next);
    assert_eq!(env.estate_state().agent, env.agent.pubkey());
}

#[test]
fn verifiers_replace_a_lost_agent_all_three_while_active() {
    let mut env = Env::configured();
    let next = Keypair::new().pubkey();
    let v = [env.verifiers[0].insecure_clone(), env.verifiers[1].insecure_clone(), env.verifiers[2].insecure_clone()];
    let stranger = env.stranger.insecure_clone();
    expect_err(env.vote_agent(&stranger, next), HeirloomError::NotVerifier);
    env.vote_agent(&v[0], next).unwrap();
    expect_err(env.vote_agent(&v[0], next), HeirloomError::AlreadyApproved);
    env.vote_agent(&v[1], next).unwrap();
    assert_eq!(env.estate_state().agent, env.agent.pubkey());
    env.vote_agent(&v[2], next).unwrap();
    assert_eq!(env.estate_state().agent, next);
}

#[test]
fn two_verifiers_replace_the_agent_after_unlock_and_old_votes_are_void() {
    let mut env = Env::configured();
    env.unlock();
    let (a, b) = (Keypair::new().pubkey(), Keypair::new().pubkey());
    let v = [env.verifiers[0].insecure_clone(), env.verifiers[1].insecure_clone()];
    env.vote_agent(&v[0], b).unwrap(); // one vote for b, against the first agent
    env.vote_agent(&v[0], a).unwrap();
    env.vote_agent(&v[1], a).unwrap();
    assert_eq!(env.estate_state().agent, a);
    env.vote_agent(&v[1], b).unwrap();
    assert_eq!(env.estate_state().agent, a, "a vote cast against the previous agent no longer counts");
}

// ------------------------------------------------------------------- P6 bounded waits

#[test]
fn only_the_owner_creates_a_guard_and_waits_are_bounded() {
    let mut env = Env::configured();
    let guard = |who: &Keypair, estate: Pubkey, window: i64| {
        ix(
            heirloom::accounts::InitGuard { authority: who.pubkey(), estate, guard: guard_pda(&estate), system_program: system_program() },
            heirloom::instruction::InitGuard { objection_window_secs: window, succession_wait_secs: 60, fallback_wait_secs: 60 },
        )
    };
    let i = guard(&env.agent, env.estate, 60);
    expect_err(send(&mut env.svm, i, &[&env.agent]), HeirloomError::NotOwner);
    let i = guard(&env.owner, env.estate, i64::MAX);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::TimeOutOfRange);
}

#[test]
fn waiting_period_is_bounded() {
    let mut env = Env::new();
    let v = env.verifier_keys();
    for secs in [0, 59, 366 * DAY] {
        let i = env.create_estate_ix(v, 2, 1, 2, secs);
        expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::TimeOutOfRange);
    }
}

// ------------------------------------------------------------------- P7 objections lapse

#[test]
fn unanswered_claim_objection_lapses_and_cannot_be_repeated() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    expect_err(env.lapse_objection(claim), HeirloomError::ObjectionNotLapsed);
    warp(&mut env.svm, (2 * WAITING).max(WINDOW));
    let v1 = env.verifiers[1].insecure_clone();
    expect_err(env.vote_objection(&v1, claim, true, None, Some(claim), None), HeirloomError::ObjectionLapsed);
    env.svm.expire_blockhash();
    expect_err(env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None), HeirloomError::BadStatus);
    env.svm.expire_blockhash();
    env.lapse_objection(claim).unwrap();
    assert_eq!(env.guard().open_objections, 0);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn a_monitor_cannot_stall_an_unlock_forever() {
    let (mut env, people) = guardian_env();
    env.death_pending();
    let estate = env.estate;
    warp(&mut env.svm, 1);
    env.object(&people, TargetKind::Unlock, estate, 0, None, None).unwrap();
    warp(&mut env.svm, 2 * WAITING);
    env.svm.expire_blockhash();
    expect_err(env.object(&people, TargetKind::Unlock, estate, 0, None, None), HeirloomError::BadStatus);
    env.finalize_unlock().unwrap();
}

#[test]
fn sale_objections_have_a_cooldown() {
    let mut s = Sale::build(true);
    let people = s.people.take().unwrap();
    let asset = s.asset;
    s.env.object(&people, TargetKind::Sale, asset, 0, Some(asset), None).unwrap();
    warp(&mut s.env.svm, 2 * WAITING);
    s.env.svm.expire_blockhash();
    expect_err(s.env.object(&people, TargetKind::Sale, asset, 0, Some(asset), None), HeirloomError::ObjectionCooldown);
    s.place_offer(1, 9_500 * USDT).unwrap();
    warp(&mut s.env.svm, WINDOW); // an offer waits out the objection window (M8)
    s.accept_offer(1).unwrap();
}

// ------------------------------------------------------------------- P8 referred

#[test]
fn referred_claim_needs_two_trusted_people() {
    let (mut env, rule) = claims_env();
    env.unlock();
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.refer_claim(claim).unwrap();
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.agent_verdict, Verdict::Referred);

    env.approve_claim(claim, 0).unwrap(); // the estate's own threshold is 1
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    env.approve_claim(claim, 1).unwrap();
    env.svm.expire_blockhash();
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn referred_claim_window_starts_at_the_second_approval() {
    let (mut env, _people, rule) = guarded_claims();
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.refer_claim(claim).unwrap();
    env.approve_claim(claim, 0).unwrap();
    let s: ApprovalStamp = fetch(&env.svm, &stamp_pda(&claim));
    assert_eq!(s.approved_at, 0);
    env.approve_claim(claim, 1).unwrap();
    let s: ApprovalStamp = fetch(&env.svm, &stamp_pda(&claim));
    assert!(s.approved_at > 0);
}

#[test]
fn referred_living_claim_still_needs_the_owner() {
    let mut env = Env::configured();
    let (kid, uni, until) = (env.kid1.pubkey(), env.university.pubkey(), now(&env.svm) + 365 * DAY);
    let i = env.add_rule_ix(0, kid, PayeeKind::University, 600 * USDT, 1_000 * USDT, until, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    let claim = env.submit_claim(true, rule, uni, 50 * USDT).unwrap();
    env.refer_claim(claim).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    env.owner_approve_claim(rule, claim).unwrap();
    env.svm.expire_blockhash();
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn referred_death_keeps_the_quorum_and_the_waiting_period() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.refer_death().unwrap();
    env.attest_death(0).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::Active);
    env.attest_death(1).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);
}

// ------------------------------------------------------------------- P9 end a rule

#[test]
fn owner_ends_a_rule_and_it_cannot_pay_any_more() {
    let (mut env, rule) = claims_env();
    let (owner, stranger) = (env.owner.insecure_clone(), env.stranger.insecure_clone());
    assert!(env.end_rule(&stranger, rule).is_err());
    env.end_rule(&owner, rule).unwrap();
    env.svm.expire_blockhash();
    expect_err(env.end_rule(&owner, rule), HeirloomError::RuleExpired);
    env.unlock();
    let uni = env.university.pubkey();
    expect_err(env.submit_claim(true, rule, uni, 1), HeirloomError::RuleExpired);
}

#[test]
fn rule_count_is_capped_so_a_sweep_always_fits() {
    let mut env = Env::configured();
    let (kid, until) = (env.kid1.pubkey(), now(&env.svm) + 365 * DAY);
    let mut rules = Vec::new();
    for id in 0..16 {
        rules.push(env.add_rule(id, kid, PayeeKind::University, USDT, USDT, until));
    }
    let i = env.add_rule_ix(16, kid, PayeeKind::University, USDT, USDT, until, false, 0, 0, 0, None);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::TooManyRules);

    let heir = env.kid2.pubkey();
    env.set_residual(heir).unwrap();
    env.unlock();
    env.sweep(heir, &rules).unwrap();
    assert_eq!(balance(&env.svm, &env.vault()), 16 * USDT);
    assert_eq!(balance(&env.svm, &ata(&heir, &env.usdt_mint)), 4_984 * USDT);
}

// =================================================================== compute units

/// The heaviest instructions fit the default 200k. Keys are random and PDA searches vary, so each runs a few
/// times and the worst is printed (`cargo test -- --nocapture compute_units`).
#[test]
fn compute_units_of_the_heaviest_instructions_fit_the_default_limit() {
    let mut worst = [0u64; 4];
    let mut best = [u64::MAX; 4];
    for _ in 0..16 {
        let mut s = Sale::build(true);
        s.approved_hardship();
        s.place_offer(1, FLOOR).unwrap();
        warp(&mut s.env.svm, WINDOW);
        s.accept_offer(1).unwrap();
        let accept = last_cu();

        let (mut env, rule) = claims_env();
        let _people = guarded(&mut env);
        env.set_yearly_cap(rule, 800 * USDT, 0).unwrap();
        env.unlock();
        let claim = approved_claim(&mut env, rule);
        warp(&mut env.svm, WINDOW);
        env.execute_claim(rule, claim).unwrap();
        let execute = last_cu();

        let (mut env, people) = fallback_env();
        vacate_all(&mut env, &people);
        env.start_fallback().unwrap();
        warp(&mut env.svm, FALLBACK_WAIT);
        let heir = env.kid1.pubkey();
        env.execute_fallback(heir).unwrap();
        let fallback = last_cu();

        let mut env = Env::configured();
        let (kid, until) = (env.kid1.pubkey(), now(&env.svm) + 365 * DAY);
        let rules: Vec<Pubkey> = (0..16).map(|id| env.add_rule(id, kid, PayeeKind::University, USDT, USDT, until)).collect();
        let heir = env.kid2.pubkey();
        env.set_residual(heir).unwrap();
        env.unlock();
        env.sweep(heir, &rules).unwrap();
        let sweep = last_cu();

        for (k, cu) in [accept, execute, fallback, sweep].into_iter().enumerate() {
            worst[k] = worst[k].max(cu);
            best[k] = best[k].min(cu);
        }
    }
    for (k, name) in ["accept_offer", "execute_claim", "execute_fallback", "sweep_residual(16 rules)"].into_iter().enumerate() {
        println!("CU {name}: {}..{}", best[k], worst[k]);
        assert!(worst[k] < 200_000, "{name} needs {} compute units", worst[k]);
    }
}

// =================================================================== second security review (2026-11-22, plan 18)
// r01 to r09 each reproduce a defect that was present on fc693c3.

impl Env {
    fn heartbeat(&mut self) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::Heartbeat { owner: self.owner.pubkey(), estate: self.estate },
            heirloom::instruction::Heartbeat {},
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    fn replace_seat(&mut self, index: u8, new_holder: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::OwnerReplaceSeat {
                owner: self.owner.pubkey(),
                estate: self.estate,
                seat: seat_pda(&self.estate, index),
                next_seat: seat_pda(&self.estate, (index + 1) % 3),
                last_seat: seat_pda(&self.estate, (index + 2) % 3),
            },
            heirloom::instruction::OwnerReplaceSeat { index, new_holder },
        );
        send(&mut self.svm, i, &[&self.owner])
    }

    /// Overwrites an account with a value an earlier program version could have left behind.
    fn plant<T: AccountSerialize>(&mut self, address: Pubkey, value: &T) {
        let mut account = self.svm.get_account(&address).expect("account missing");
        let mut data = Vec::new();
        value.try_serialize(&mut data).unwrap();
        account.data[..data.len()].copy_from_slice(&data);
        self.svm.set_account(address, account).unwrap();
    }
}

// ------------------------------------------------------------------- R1 a check-in is proof of life

#[test]
fn r01_check_in_during_the_wait_stops_the_unlock() {
    let mut env = Env::configured();
    env.death_pending();
    warp(&mut env.svm, WAITING - 1);
    env.heartbeat().unwrap();
    let e = env.estate_state();
    assert_eq!((e.status, e.death_cert_hash, e.death_attestations), (EstateStatus::Active, [0u8; 32], 0));
    assert_eq!((e.death_verdict, e.death_pending_since, e.last_heartbeat), (Verdict::Pending, 0, now(&env.svm)));
    warp(&mut env.svm, 2);
    expect_err(env.finalize_unlock(), HeirloomError::BadStatus);
}

#[test]
fn r01_check_in_clears_a_claim_that_has_no_quorum_yet() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    env.heartbeat().unwrap();
    expect_err(env.attest_death(1), HeirloomError::NoDeathClaim);
}

#[test]
fn r01_check_in_is_refused_after_the_unlock() {
    let mut env = Env::configured();
    env.unlock();
    expect_err(env.heartbeat(), HeirloomError::BadStatus);
}

#[test]
fn r01_check_in_voids_an_unlock_objection_and_its_votes() {
    let (mut env, people) = guardian_env();
    env.death_pending();
    let estate = env.estate;
    env.object(&people, TargetKind::Unlock, estate, 0, None, None).unwrap();
    let (v0, v1) = (env.v(0), env.v(1));
    env.vote_objection(&v0, estate, true, None, None, None).unwrap();
    warp(&mut env.svm, 1);
    env.heartbeat().unwrap();
    warp(&mut env.svm, 1);
    env.death_pending();
    // The old vote cannot help cancel the new claim, and the old objection does not hold it.
    expect_err(env.vote_objection(&v1, estate, true, None, None, None), HeirloomError::ObjectionLapsed);
    env.object(&people, TargetKind::Unlock, estate, 1, None, None).unwrap();
    assert_eq!((env.objection(&estate).votes_uphold, env.guard().open_objections), (0, 1));
}

// ------------------------------------------------------------------- R2 replacing a trusted person

#[test]
fn r02_replacing_a_trusted_person_clears_their_attestation_and_the_claim() {
    let (mut env, _people) = guardian_env();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    let newbie = funded(&mut env.svm);
    warp(&mut env.svm, 5);
    env.replace_seat(0, newbie.pubkey()).unwrap();
    let e = env.estate_state();
    assert_eq!((e.death_cert_hash, e.death_attestations, e.last_heartbeat), ([0u8; 32], 0, now(&env.svm)));
    expect_err(env.attest_death(1), HeirloomError::NoDeathClaim);

    // A fresh claim counts the new person and starts from nothing.
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.attest_death_by(&newbie).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::Active);
}

#[test]
fn r02_replacing_is_refused_once_the_death_is_pending() {
    let (mut env, _people) = guardian_env();
    env.death_pending();
    let newbie = Keypair::new().pubkey();
    expect_err(env.replace_seat(0, newbie), HeirloomError::BadStatus);
}

// ------------------------------------------------------------------- R5 a death claim cannot squat

#[test]
fn r05_an_unreviewed_death_claim_waits_for_its_review_instead_of_being_replaced() {
    // Changed by design (N4): an unreviewed claim is never replaced, so its time stays when this death's first
    // claim was made. The agent's rejection frees the place; a lost agent is replaced after RT (H7).
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    assert_eq!(env.estate_state().death_pending_since, now(&env.svm));
    warp(&mut env.svm, WAITING);
    expect_err(env.submit_death_claim(2), HeirloomError::BadStatus);
    warp(&mut env.svm, 10 * RT);
    expect_err(env.submit_death_claim(2), HeirloomError::BadStatus);
    env.review_death(false).unwrap();
    env.submit_death_claim(2).unwrap();
    let e = env.estate_state();
    assert_eq!((e.death_submitted_by, e.death_pending_since), (env.kid2.pubkey(), now(&env.svm)));
}

#[test]
fn r05_the_same_person_waits_a_grace_longer() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    warp(&mut env.svm, 3 * WAITING - 1);
    expect_err(env.submit_death_claim(1), HeirloomError::BadStatus);
    warp(&mut env.svm, 1);
    env.submit_death_claim(1).unwrap();
}

#[test]
fn r05_a_reviewed_claim_without_a_quorum_is_replaceable_after_two_waiting_periods() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    warp(&mut env.svm, 2 * WAITING - 1);
    expect_err(env.submit_death_claim(2), HeirloomError::BadStatus);
    warp(&mut env.svm, 1);
    // Whoever made it does not go first.
    expect_err(env.submit_death_claim(1), HeirloomError::BadStatus);
    env.submit_death_claim(2).unwrap();
    let e = env.estate_state();
    assert_eq!((e.death_verdict, e.death_attestations), (Verdict::Pending, 0));
}

#[test]
fn r05_the_grace_is_at_most_a_day() {
    // An unreviewed seat report gives way after the grace, which is at most a day.
    let mut env = estate_with_seats(30 * DAY, FALLBACK_WAIT, [[d(); 2]; 3], [[d(); 2]; 3]);
    let (k1, k2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone());
    env.report_seat_death(&k1, 0).unwrap();
    warp(&mut env.svm, DAY - 1);
    expect_err(env.report_seat_death(&k2, 0), HeirloomError::SuccessionPending);
    warp(&mut env.svm, 1);
    env.report_seat_death(&k2, 0).unwrap();
}

#[test]
fn r05_a_confirmed_claim_cannot_be_replaced() {
    let mut env = Env::configured();
    env.death_pending();
    warp(&mut env.svm, 10 * 365 * DAY);
    expect_err(env.submit_death_claim(2), HeirloomError::BadStatus);
}

#[test]
fn r05_the_wait_runs_from_the_quorum_not_the_submission() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    warp(&mut env.svm, WAITING);
    env.attest_death(0).unwrap();
    env.attest_death(1).unwrap();
    assert_eq!(env.estate_state().death_pending_since, now(&env.svm));
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);
}

#[test]
fn r05_a_legacy_claim_with_time_zero_is_stale_at_once() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    let mut e = env.estate_state();
    e.death_pending_since = 0;
    let address = env.estate;
    env.plant(address, &e);
    env.submit_death_claim(2).unwrap();
}

#[test]
fn r05_the_agent_cannot_review_a_claim_that_replaced_the_one_it_read() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    expect_err(env.review_death_as(ReviewOutcome::Approve, Some([1u8; 32])), HeirloomError::ReportChanged);
    env.review_death_as(ReviewOutcome::Approve, Some([7u8; 32])).unwrap();
}

// ------------------------------------------------------------------- R7 referred death, nobody left

#[test]
fn r07_referred_death_with_all_seats_vacant_pays_after_twice_the_wait() {
    let (mut env, people) = guardian_env();
    let k1 = env.kid1.pubkey();
    env.set_fallback([k1, d(), d(), d()]).unwrap();
    env.submit_death_claim(1).unwrap();
    env.refer_death().unwrap();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    expect_err(env.execute_fallback(k1), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, FALLBACK_WAIT);
    env.execute_fallback(k1).unwrap();
    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 5_000 * USDT);
    assert_eq!(env.estate_state().status, EstateStatus::Unlocked);
}

#[test]
fn r07_an_unreviewed_death_does_not_start_the_fallback() {
    let (mut env, people) = guardian_env();
    let k1 = env.kid1.pubkey();
    env.set_fallback([k1, d(), d(), d()]).unwrap();
    env.submit_death_claim(1).unwrap();
    vacate_all(&mut env, &people);
    expect_err(env.start_fallback(), HeirloomError::FallbackNotReady);
}

#[test]
fn r07_a_reviewed_claim_cannot_be_swapped_out_when_nobody_is_left() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    warp(&mut env.svm, 10 * WAITING);
    expect_err(env.submit_death_claim(2), HeirloomError::BadStatus);
    env.start_fallback().unwrap();
}

#[test]
fn r07_a_countdown_for_an_earlier_claim_does_not_count_for_the_next() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    // As an upheld unlock objection leaves it: the claim is gone, the countdown is still stored.
    let mut e = env.estate_state();
    e.clear_death_claim();
    let address = env.estate;
    env.plant(address, &e);
    env.submit_death_claim(2).unwrap();
    env.review_death(true).unwrap();
    let k1 = env.kid1.pubkey();
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackNotReady);
    env.start_fallback().unwrap();
    expect_err(env.execute_fallback(k1), HeirloomError::WaitingPeriodNotOver);
}

impl Env {
    fn submit_death_claim_by(&mut self, who: &Keypair) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SubmitDeathClaim {
                beneficiary: who.pubkey(),
                estate: self.estate,
                beneficiary_account: self.member_account(&who.pubkey()),
                guard: None,
                objection: objection_pda(&self.estate),
            },
            heirloom::instruction::SubmitDeathClaim { cert_hash: [7u8; 32] },
        );
        send(&mut self.svm, i, &[who])
    }

    fn submit_claim_by(&mut self, who: &Keypair, rule: Pubkey, payee_wallet: Pubkey, amount: u64) -> Result<Pubkey, String> {
        let r: Rule = fetch(&self.svm, &rule);
        let claim = claim_pda(&rule, r.claim_count);
        let i = ix(
            heirloom::accounts::SubmitClaim {
                beneficiary: who.pubkey(),
                estate: self.estate,
                beneficiary_account: beneficiary_pda(&self.estate, &who.pubkey()),
                rule,
                payee: payee_pda(&self.estate, &payee_wallet),
                claim,
                system_program: system_program(),
                year_cap: year_cap_pda(&rule),
            },
            heirloom::instruction::SubmitClaim { amount, evidence_hash: [1u8; 32] },
        );
        send(&mut self.svm, i, &[who]).map(|_| claim)
    }

    /// Writes the ApprovalStamp and approvals an earlier program left on a claim.
    fn plant_approvals(&mut self, claim: Pubkey, approvals: u8, seat_index: u8, approved_at: i64) {
        let mut c: Claim = fetch(&self.svm, &claim);
        c.approvals = approvals;
        self.plant(claim, &c);
        let (address, bump) = Pubkey::find_program_address(&[b"stamp", claim.as_ref()], &heirloom::id());
        let stamp = ApprovalStamp { target: claim, seat_index, approver: self.verifiers[0].pubkey(), approved_at, bump };
        let mut data = Vec::new();
        stamp.try_serialize(&mut data).unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(address, Account { lamports, data, owner: heirloom::id(), executable: false, rent_epoch: 0 })
            .unwrap();
    }

    /// Seats 0 and 1 die with no backups: verifier 2 is the only one left.
    fn leave_one_survivor(&mut self) {
        let owner = self.kp(&self.owner);
        for i in 0..2 {
            self.set_seat_backups(&owner, i, [d(), d()]).unwrap();
        }
        let (v1, v2) = (self.v(1), self.v(2));
        self.succeed(0, &v1);
        self.succeed(1, &v2);
        assert_eq!(self.estate_state().verifiers, [d(), d(), v2.pubkey()]);
    }
}

/// kid1's living tuition rule, and a claim on it that the agent approved.
fn living_claim(env: &mut Env) -> (Pubkey, Pubkey) {
    let (kid, uni, until) = (env.kid1.pubkey(), env.university.pubkey(), now(&env.svm) + 365 * DAY);
    let i = env.add_rule_ix(0, kid, PayeeKind::University, 600 * USDT, 1_000 * USDT, until, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    (rule, claim)
}

// ------------------------------------------------------------------- R3 approvals count only after the unlock

#[test]
fn r03_a_removed_persons_early_approval_never_pays() {
    let (mut env, _people) = guardian_env();
    let (rule, claim) = living_claim(&mut env);
    expect_err(env.approve_claim(claim, 0), HeirloomError::BadStatus);
    let newbie = funded(&mut env.svm);
    env.replace_seat(0, newbie.pubkey()).unwrap();
    warp(&mut env.svm, WINDOW + 1);
    env.death_pending_by_seats_1_and_2();
    expect_err(env.approve_claim(claim, 1), HeirloomError::BadStatus);
    warp(&mut env.svm, WAITING);
    env.finalize_unlock().unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

impl Env {
    fn death_pending_by_seats_1_and_2(&mut self) {
        self.submit_death_claim(1).unwrap();
        self.review_death(true).unwrap();
        self.attest_death(1).unwrap();
        self.attest_death(2).unwrap();
    }
}

#[test]
fn r03_a_stamp_from_before_the_death_neither_pays_nor_blocks_a_fresh_quorum() {
    let (mut env, _people) = guardian_env();
    let (rule, claim) = living_claim(&mut env);
    let stamped_at = now(&env.svm);
    env.plant_approvals(claim, 0b001, 0, stamped_at);
    warp(&mut env.svm, DAY);
    env.unlock();
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);

    // The same seat can approve again, and the monitors get their window from then.
    env.approve_claim(claim, 0).unwrap();
    let s: ApprovalStamp = fetch(&env.svm, &stamp_pda(&claim));
    assert_eq!((s.approved_at, s.seat_index), (now(&env.svm), 0));
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn r03_a_partial_approval_from_before_the_death_does_not_add_up() {
    let mut env = Env::configured();
    let (rule, claim) = living_claim(&mut env);
    let mut c: Claim = fetch(&env.svm, &claim);
    c.agent_verdict = Verdict::Referred;
    env.plant(claim, &c);
    env.plant_approvals(claim, 0b001, 0, 0);
    warp(&mut env.svm, DAY);
    env.unlock();

    env.approve_claim(claim, 1).unwrap();
    let c: Claim = fetch(&env.svm, &claim);
    assert_eq!(c.approvals, 0b010, "the early approval was dropped");
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    env.approve_claim(claim, 2).unwrap();
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn r03_an_approval_without_a_stamp_from_before_the_death_never_pays() {
    let mut env = Env::configured();
    let (rule, claim) = living_claim(&mut env);
    let mut c: Claim = fetch(&env.svm, &claim);
    c.approvals = 0b111;
    env.plant(claim, &c);
    warp(&mut env.svm, DAY);
    env.unlock();
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    env.approve_claim(claim, 1).unwrap();
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn r03_the_owners_own_approval_still_pays_after_the_unlock() {
    let mut env = Env::configured();
    let (rule, claim) = living_claim(&mut env);
    env.owner_approve_claim(rule, claim).unwrap();
    env.unlock();
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn r03_an_objection_from_before_the_death_does_not_use_up_the_monitors_objection() {
    let (mut env, people) = guardian_env();
    let (_rule, claim) = living_claim(&mut env);
    let mut c: Claim = fetch(&env.svm, &claim);
    c.approvals = 0b001;
    env.plant(claim, &c);
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    let owner = env.kp(&env.owner);
    env.vote_objection(&owner, claim, false, None, Some(claim), None).unwrap();
    warp(&mut env.svm, DAY);
    env.unlock();
    env.approve_claim(claim, 0).unwrap();
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
}

// ------------------------------------------------------------------- R8 one survivor

#[test]
fn r08_one_survivor_completes_the_death_quorum() {
    let (mut env, _people) = fallback_env();
    env.leave_one_survivor();
    env.attest_death(2).unwrap();
    let e = env.estate_state();
    assert_eq!((e.status, e.death_pending_since), (EstateStatus::DeathPending, now(&env.svm)));
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, WAITING);
    env.finalize_unlock().unwrap();
}

#[test]
fn r08_a_survivor_who_already_attested_completes_the_dropped_quorum() {
    let (mut env, _people) = fallback_env();
    env.attest_death(2).unwrap();
    expect_err(env.attest_death(2), HeirloomError::AlreadyApproved);
    env.leave_one_survivor();
    env.attest_death(2).unwrap();
    let e = env.estate_state();
    assert_eq!((e.status, e.death_pending_since), (EstateStatus::DeathPending, now(&env.svm)));
    expect_err(env.attest_death(2), HeirloomError::AlreadyApproved);
}

#[test]
fn r08_a_vacant_seats_attestation_does_not_count() {
    let (mut env, _people) = fallback_env();
    env.attest_death(0).unwrap();
    let owner = env.kp(&env.owner);
    env.set_seat_backups(&owner, 0, [d(), d()]).unwrap();
    let v1 = env.v(1);
    env.succeed(0, &v1);
    env.attest_death(1).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::Active);
    env.attest_death(2).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);
}

#[test]
fn r08_a_successor_inherits_the_seats_attestation() {
    let (mut env, _people) = fallback_env();
    env.attest_death(0).unwrap();
    let v1 = env.v(1);
    env.succeed(0, &v1);
    env.attest_death(1).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);
}

#[test]
fn r08_one_survivor_pays_a_referred_claim_after_a_fresh_window() {
    let (mut env, _people, rule) = guarded_claims();
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.refer_claim(claim).unwrap();
    env.approve_claim(claim, 2).unwrap();
    expect_err(env.approve_claim(claim, 2), HeirloomError::AlreadyApproved);
    // Nobody can change backups for the owner now, so each holder empties their own before dying.
    for i in 0..2 {
        let v = env.v(i);
        env.set_seat_backups(&v, i as u8, [d(), d()]).unwrap();
    }
    let (v1, v2) = (env.v(1), env.v(2));
    env.succeed(0, &v1);
    env.succeed(1, &v2);

    // The quorum dropped to one, but the window has not started.
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    env.approve_claim(claim, 2).unwrap();
    let s: ApprovalStamp = fetch(&env.svm, &stamp_pda(&claim));
    assert_eq!((s.approved_at, s.seat_index), (now(&env.svm), 2));
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn r08_a_lost_quorum_needs_another_approval_and_a_fresh_window() {
    let (mut env, _people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    let v0 = env.v(0);
    env.set_seat_backups(&v0, 0, [d(), d()]).unwrap();
    let v1 = env.v(1);
    env.succeed(0, &v1);
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    env.approve_claim(claim, 1).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn r08_one_survivor_completes_a_hardship_quorum() {
    let mut s = Sale::build(true);
    let h = s.submit_hardship().unwrap();
    s.review_hardship(h, true).unwrap();
    s.approve_hardship(h, 2).unwrap();
    expect_err(s.approve_hardship(h, 2), HeirloomError::AlreadyApproved);
    for i in 0..2 {
        let v = s.env.v(i);
        s.env.set_seat_backups(&v, i as u8, [d(), d()]).unwrap();
    }
    let (v1, v2) = (s.env.v(1), s.env.v(2));
    s.env.succeed(0, &v1);
    s.env.succeed(1, &v2);
    s.approve_hardship(h, 2).unwrap();
    let a: Asset = fetch(&s.env.svm, &s.asset);
    assert_eq!(a.hardship_beneficiary, Some(s.env.kid2.pubkey()));
}

#[test]
fn r08_zero_eligible_seats_never_pass() {
    let (mut env, _people) = guardian_env();
    let v2 = env.v(2);
    env.add_beneficiary(v2.pubkey(), "Trusted child");
    env.leave_one_survivor();
    env.submit_death_claim_by(&v2).unwrap();
    env.refer_death().unwrap();
    expect_err(env.attest_death(2), HeirloomError::OwnApproval);
    assert!(!env.estate_state().quorum_met(0b111, &v2.pubkey(), 1));
    assert_eq!(env.estate_state().status, EstateStatus::Active);
}

#[test]
fn r08_a_survivor_who_already_voted_completes_the_agent_replacement() {
    let (mut env, _people) = guardian_env();
    env.unlock();
    let next = Keypair::new().pubkey();
    let v2 = env.v(2);
    env.vote_agent(&v2, next).unwrap();
    expect_err(env.vote_agent(&v2, next), HeirloomError::AlreadyApproved);
    for i in 0..2 {
        let v = env.v(i);
        env.set_seat_backups(&v, i as u8, [d(), d()]).unwrap();
    }
    let v1 = env.v(1);
    env.succeed(0, &v1);
    env.succeed(1, &v2);
    env.vote_agent(&v2, next).unwrap();
    assert_eq!(env.estate_state().agent, next);
}

#[test]
fn r08_a_vacant_seats_dispute_vote_does_not_count() {
    let (mut env, _people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    let (v0, v1, v2) = (env.v(0), env.v(1), env.v(2));
    env.resolve_dispute(&v0, claim, true, true).unwrap();
    env.set_seat_backups(&v0, 0, [d(), d()]).unwrap();
    env.succeed(0, &v1);
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Open);
    env.resolve_dispute(&v1, claim, true, true).unwrap();
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Open, "one living vote is not two");
    env.resolve_dispute(&v2, claim, true, true).unwrap();
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Upheld);
}

// ------------------------------------------------------------------- R11 nobody in their own favour

#[test]
fn r11_a_trusted_person_cannot_approve_their_own_claim() {
    let mut env = Env::configured();
    let (v0, uni, until) = (env.v(0), env.university.pubkey(), now(&env.svm) + 365 * DAY);
    env.add_beneficiary(v0.pubkey(), "Trusted child");
    let rule = env.add_rule(0, v0.pubkey(), PayeeKind::University, 600 * USDT, 1_000 * USDT, until);
    env.unlock();
    let claim = env.submit_claim_by(&v0, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    expect_err(env.approve_claim(claim, 0), HeirloomError::OwnApproval);
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    env.approve_claim(claim, 1).unwrap();
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn r11_a_self_approval_already_on_chain_does_not_count() {
    let mut env = Env::configured();
    let (v0, uni, until) = (env.v(0), env.university.pubkey(), now(&env.svm) + 365 * DAY);
    env.add_beneficiary(v0.pubkey(), "Trusted child");
    let rule = env.add_rule(0, v0.pubkey(), PayeeKind::University, 600 * USDT, 1_000 * USDT, until);
    env.unlock();
    let claim = env.submit_claim_by(&v0, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    let t = now(&env.svm);
    env.plant_approvals(claim, 0b001, 0, t);
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
}

#[test]
fn r11_a_trusted_person_cannot_approve_their_own_hardship() {
    let mut s = Sale::new();
    let h = s.submit_hardship().unwrap();
    s.review_hardship(h, true).unwrap();
    let mut e = s.env.estate_state();
    e.verifiers[0] = s.env.kid2.pubkey();
    let estate = s.env.estate;
    s.env.plant(estate, &e);
    let i = ix(
        heirloom::accounts::ApproveHardship {
            verifier: s.env.kid2.pubkey(),
            estate,
            asset: s.asset,
            hardship: h,
            payer: s.env.kid2.pubkey(),
            approval_stamp: stamp_pda(&h),
            system_program: system_program(),
        },
        heirloom::instruction::ApproveHardship {},
    );
    expect_err(send(&mut s.env.svm, i, &[&s.env.kid2]), HeirloomError::OwnApproval);
    s.approve_hardship(h, 1).unwrap();
    s.approve_hardship(h, 2).unwrap();
}

#[test]
fn r11_whoever_gains_cannot_spend_the_one_objection() {
    let (mut env, _people) = fallback_env();
    let k1 = env.kid1.insecure_clone();
    env.death_pending_from_approved();
    let estate = env.estate;
    expect_err(env.raise_dispute(&k1, TargetKind::Unlock, estate, true, [5u8; 32]), HeirloomError::OwnClaimDispute);
    env.set_seat_monitors_by_planting(0, k1.pubkey());
    let seat = Some(seat_pda(&env.estate, 0));
    expect_err(env.raise_objection(&k1, TargetKind::Unlock, estate, 0, seat, false, None, None), HeirloomError::OwnClaimDispute);
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
}

impl Env {
    fn death_pending_from_approved(&mut self) {
        self.attest_death(0).unwrap();
        self.attest_death(1).unwrap();
    }

    fn set_seat_monitors_by_planting(&mut self, index: u8, monitor: Pubkey) {
        let mut seat = self.seat(index);
        seat.monitors[1] = monitor;
        self.plant(seat_pda(&self.estate, index), &seat);
    }
}

#[test]
fn r11_the_claimant_cannot_object_to_use_up_the_claims_objection() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    let k1 = env.kid1.insecure_clone();
    env.set_seat_monitors_by_planting(0, k1.pubkey());
    let seat = Some(seat_pda(&env.estate, 0));
    expect_err(env.raise_objection(&k1, TargetKind::Claim, claim, 0, seat, false, Some(claim), None), HeirloomError::OwnClaimDispute);
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
}

#[test]
fn r11_the_next_recipient_cannot_spend_the_fallback_objection() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let (guard, k1, k2) = (guard_pda(&env.estate), env.kid1.insecure_clone(), env.kid2.insecure_clone());
    expect_err(env.raise_objection(&k1, TargetKind::Fallback, guard, 255, None, true, None, None), HeirloomError::OwnClaimDispute);
    env.raise_objection(&k2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();
}

#[test]
fn r11_a_claimant_cannot_dismiss_a_challenge_to_their_own_claim() {
    let mut env = Env::configured();
    let (v0, uni, until) = (env.v(0), env.university.pubkey(), now(&env.svm) + 365 * DAY);
    env.add_beneficiary(v0.pubkey(), "Trusted child");
    let rule = env.add_rule(0, v0.pubkey(), PayeeKind::University, 600 * USDT, 1_000 * USDT, until);
    env.unlock();
    let claim = env.submit_claim_by(&v0, rule, uni, 100 * USDT).unwrap();
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    expect_err(env.resolve_dispute(&v0, claim, false, true), HeirloomError::OwnApproval);
    let v1 = env.v(1);
    env.resolve_dispute(&v1, claim, false, true).unwrap();
}

#[test]
fn r11_a_monitors_objection_cannot_be_dismissed_by_the_claimant() {
    let (mut env, people) = guardian_env();
    let (v2, uni, until) = (env.v(2), env.university.pubkey(), now(&env.svm) + 365 * DAY);
    env.add_beneficiary(v2.pubkey(), "Trusted child");
    let rule = env.add_rule(0, v2.pubkey(), PayeeKind::University, 600 * USDT, 1_000 * USDT, until);
    env.unlock();
    let claim = env.submit_claim_by(&v2, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    expect_err(env.vote_objection(&v2, claim, false, None, Some(claim), None), HeirloomError::OwnApproval);
    env.vote_objection(&v2, claim, true, None, Some(claim), None).unwrap();
}

// ------------------------------------------------------------------- R4 a fallback recipient's death

#[test]
fn r04_the_agent_alone_cannot_redirect_the_surplus() {
    let (mut env, _people) = guardian_env();
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    env.set_fallback([k1, k2, d(), d()]).unwrap();
    env.unlock();
    assert!(env.review_fallback_death(0, true).is_err(), "there is no report to review");
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    assert_eq!(env.guard().fallback_dead, 0);
    expect_err(env.sweep(k2, &[]), HeirloomError::NoResidualRecipient);
}

#[test]
fn r04_a_second_person_confirms_after_the_fallback_wait() {
    let (mut env, _people) = fallback_env();
    env.report_fallback_death(0).unwrap();
    let v0 = env.v(0);
    expect_err(env.resolve_fallback_death(&v0, 0, None, true), HeirloomError::AgentNotApproved);
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT - 1);
    expect_err(env.resolve_fallback_death(&v0, 0, None, true), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, 1);
    env.resolve_fallback_death(&v0, 0, None, true).unwrap();
    let g = env.guard();
    assert_eq!((g.fallback_dead, g.next_fallback_recipient(), g.fallback_started_at), (0b1, env.kid2.pubkey(), 0));
    assert!(is_closed(&env.svm, &fallback_report_pda(&env.estate, 0)));
}

#[test]
fn r04_the_reporter_the_gainer_the_agent_and_strangers_cannot_confirm() {
    let (mut env, _people) = fallback_env();
    let v0 = env.v(0);
    env.report_fallback_death_by(&v0, 0, None, [7u8; 32]).unwrap();
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    let (k1, k2, agent, stranger) =
        (env.kid1.insecure_clone(), env.kid2.insecure_clone(), env.agent.insecure_clone(), env.stranger.insecure_clone());
    for who in [&v0, &k2, &k1, &agent, &stranger] {
        expect_err(env.resolve_fallback_death(who, 0, None, true), HeirloomError::NotConfirmer);
    }
    let v1 = env.v(1);
    env.resolve_fallback_death(&v1, 0, None, true).unwrap();
}

#[test]
fn r04_only_participants_report_and_never_the_recipient_or_the_agent() {
    let (mut env, people) = fallback_env();
    let (k1, agent, stranger) = (env.kid1.insecure_clone(), env.agent.insecure_clone(), env.stranger.insecure_clone());
    for who in [&k1, &agent, &stranger] {
        expect_err(env.report_fallback_death_by(who, 0, None, [7u8; 32]), HeirloomError::NotParticipant);
    }
    let (m0, executor) = (env.kp(&people.monitors[0]), env.executor.insecure_clone());
    env.svm.airdrop(&executor.pubkey(), 1_000_000_000).unwrap();
    expect_err(env.report_fallback_death_by(&m0, 0, None, [7u8; 32]), HeirloomError::NotParticipant);
    env.report_fallback_death_by(&m0, 0, Some(0), [7u8; 32]).unwrap();
    // A listed recipient may report another one.
    env.report_fallback_death_by(&executor, 1, None, [7u8; 32]).unwrap();
}

#[test]
fn r04_a_listed_recipient_or_a_monitor_confirms_when_every_seat_is_vacant() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    let executor = env.executor.insecure_clone();
    env.svm.airdrop(&executor.pubkey(), 1_000_000_000).unwrap();
    env.resolve_fallback_death(&executor, 0, None, true).unwrap();
    assert_eq!(env.guard().fallback_dead, 0b1);

    env.report_fallback_death_by(&executor, 1, None, [7u8; 32]).unwrap();
    env.review_fallback_death(1, true).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    let m2 = env.kp(&people.monitors[2]);
    env.resolve_fallback_death(&m2, 1, Some(2), true).unwrap();
    assert_eq!(env.guard().fallback_dead, 0b11);
}

#[test]
fn r04_the_recipient_can_refute_at_any_time_before_confirmation() {
    let (mut env, _people) = fallback_env();
    let (k1, k2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone());
    let report = fallback_report_pda(&env.estate, 0);
    env.report_fallback_death(0).unwrap();
    env.resolve_fallback_death(&k1, 0, None, false).unwrap();
    assert!(is_closed(&env.svm, &report));

    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, 3 * FALLBACK_WAIT);
    expect_err(env.resolve_fallback_death(&k2, 0, None, false), HeirloomError::NotParticipant);
    env.resolve_fallback_death(&k1, 0, None, false).unwrap();
    assert_eq!(env.guard().fallback_dead, 0);
}

#[test]
fn r04_a_rejection_closes_the_report() {
    let (mut env, _people) = fallback_env();
    env.report_fallback_death(0).unwrap();
    expect_err(env.review_fallback_death_as(0, true, [1u8; 32]), HeirloomError::ReportChanged);
    env.review_fallback_death(0, false).unwrap();
    assert!(is_closed(&env.svm, &fallback_report_pda(&env.estate, 0)));
    env.report_fallback_death(0).unwrap();
}

#[test]
fn r04_a_stale_report_is_replaceable_and_its_rent_cannot_be_taken() {
    let (mut env, _people) = fallback_env();
    let (v0, k2) = (env.v(0), env.kid2.insecure_clone());
    env.report_fallback_death_by(&v0, 0, None, [7u8; 32]).unwrap();
    let report = fallback_report_pda(&env.estate, 0);
    let rent = env.svm.get_account(&report).unwrap().lamports;
    expect_err(env.report_fallback_death(0), HeirloomError::BadStatus);
    // An unreviewed fallback report keeps its place for half the refute wait (L12).
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    expect_err(env.report_fallback_death_by(&v0, 0, None, [7u8; 32]), HeirloomError::BadStatus);
    env.report_fallback_death(0).unwrap();
    let r: FallbackReport = fetch(&env.svm, &report);
    assert_eq!((r.reporter, r.rent_payer, r.verdict), (k2.pubkey(), v0.pubkey(), Verdict::Pending));

    let k1 = env.kid1.insecure_clone();
    // The rent can't be redirected.
    let i = ix(
        heirloom::accounts::ResolveFallbackDeath {
            signer: k1.pubkey(),
            estate: env.estate,
            guard: guard_pda(&env.estate),
            fallback_report: report,
            rent_to: k2.pubkey(),
            signer_seat: None,
            beneficiary_account: None,
        },
        heirloom::instruction::ResolveFallbackDeath { index: 0, dead: false },
    );
    assert!(send(&mut env.svm, i, &[&k1]).is_err());
    let before = env.svm.get_account(&v0.pubkey()).unwrap().lamports;
    env.resolve_fallback_death(&k1, 0, None, false).unwrap();
    assert_eq!(env.svm.get_account(&v0.pubkey()).unwrap().lamports, before + rent);
}

#[test]
fn r04_an_approved_report_is_replaceable_once_it_is_stale() {
    let (mut env, _people) = fallback_env();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    let v0 = env.v(0);
    warp(&mut env.svm, 2 * FALLBACK_WAIT - 1);
    expect_err(env.report_fallback_death_by(&v0, 0, None, [7u8; 32]), HeirloomError::BadStatus);
    warp(&mut env.svm, 1);
    env.report_fallback_death_by(&v0, 0, None, [7u8; 32]).unwrap();
}

#[test]
fn r04_a_changed_list_voids_the_report() {
    let (mut env, _people) = fallback_env();
    env.report_fallback_death(0).unwrap();
    let (k2, executor) = (env.kid2.pubkey(), env.executor.pubkey());
    env.set_fallback([executor, k2, d(), d()]).unwrap();
    expect_err(env.review_fallback_death(0, true), HeirloomError::NoFallbackRecipient);
    let v0 = env.v(0);
    env.report_fallback_death_by(&v0, 0, None, [7u8; 32]).unwrap();
}

#[test]
fn r04_a_report_made_during_the_countdown_can_still_be_confirmed_in_time() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT - 1);
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, 1);
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    expect_err(env.execute_fallback(k1), HeirloomError::DeathReportOpen);
    warp(&mut env.svm, FALLBACK_WAIT);
    let m0 = env.kp(&people.monitors[0]);
    env.resolve_fallback_death(&m0, 0, Some(0), true).unwrap();
    assert_eq!(env.guard().fallback_started_at, now(&env.svm));
    warp(&mut env.svm, FALLBACK_WAIT);
    env.execute_fallback(k2).unwrap();
}

#[test]
fn r04_an_unconfirmed_report_cannot_hold_the_fallback_for_ever() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT - 1);
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, 2 * FALLBACK_WAIT);
    // A new report after the countdown ended holds nothing.
    let m0 = env.kp(&people.monitors[0]);
    env.report_fallback_death_by(&m0, 0, Some(0), [7u8; 32]).unwrap();
    env.review_fallback_death(0, true).unwrap();
    let k1 = env.kid1.pubkey();
    env.execute_fallback(k1).unwrap();
}

#[test]
fn r04_confirming_does_not_revive_a_countdown_the_owner_voided() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let started = env.guard().fallback_started_at;
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    env.heartbeat().unwrap();
    let m0 = env.kp(&people.monitors[0]);
    env.resolve_fallback_death(&m0, 0, Some(0), true).unwrap();
    assert_eq!(env.guard().fallback_started_at, started);
    let k2 = env.kid2.pubkey();
    expect_err(env.execute_fallback(k2), HeirloomError::FallbackNotReady);
}

// ------------------------------------------------------------------- R6 a seat-death report cannot squat

#[test]
fn r06_a_stranger_cannot_report_a_seat_death() {
    let (mut env, people) = guardian_env();
    let (stranger, agent) = (env.stranger.insecure_clone(), env.agent.insecure_clone());
    expect_err(env.report_seat_death(&stranger, 0), HeirloomError::NotParticipant);
    expect_err(env.report_seat_death(&agent, 0), HeirloomError::NotParticipant);
    let (backup, monitor) = (env.kp(&people.backups[1][0]), env.kp(&people.monitors[2]));
    expect_err(env.report_seat_death(&backup, 0), HeirloomError::NotParticipant); // another seat's backup
    env.report_seat_death(&backup, 1).unwrap();
    env.report_seat_death(&monitor, 2).unwrap();
    let v1 = env.v(1);
    env.report_seat_death(&v1, 0).unwrap();
}

#[test]
fn r06_the_owner_can_report_a_seat_death() {
    let (mut env, _people) = guardian_env();
    let owner = env.kp(&env.owner);
    env.report_seat_death(&owner, 0).unwrap();
}

#[test]
fn r06_an_unreviewed_report_can_be_replaced_after_a_grace() {
    let (mut env, _people) = guardian_env();
    let (v1, kid) = (env.v(1), env.kid1.insecure_clone());
    env.report_seat_death(&v1, 0).unwrap();
    assert_eq!(env.seat(0).death_pending_since, now(&env.svm));
    warp(&mut env.svm, WAITING - 1);
    expect_err(env.report_seat_death(&kid, 0), HeirloomError::SuccessionPending);
    warp(&mut env.svm, 1);
    // Whoever made it does not go first.
    expect_err(env.report_seat_death(&v1, 0), HeirloomError::SuccessionPending);
    env.report_seat_death(&kid, 0).unwrap();
    assert_eq!(env.seat(0).death_reported_by, kid.pubkey());
}

#[test]
fn r06_a_reviewed_report_is_replaceable_after_the_recovery_route_had_its_time_until_confirmed() {
    let (mut env, _people) = guardian_env();
    let (v1, v2, kid) = (env.v(1), env.v(2), env.kid1.insecure_clone());
    env.report_seat_death(&v1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    // The recovery timeout (4 waiting periods) and then two more (H3): replacing sooner would restart the route.
    warp(&mut env.svm, 6 * WAITING - 1);
    expect_err(env.report_seat_death(&kid, 0), HeirloomError::SuccessionPending);
    warp(&mut env.svm, 1);
    env.report_seat_death(&kid, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v2, 0).unwrap();
    warp(&mut env.svm, 10 * WAITING);
    expect_err(env.report_seat_death(&v1, 0), HeirloomError::SuccessionPending);
}

#[test]
fn r06_a_stale_report_does_not_block_backup_changes() {
    let (mut env, _people) = guardian_env();
    let (v1, owner) = (env.v(1), env.kp(&env.owner));
    env.report_seat_death(&v1, 0).unwrap();
    expect_err(env.set_seat_backups(&owner, 0, [d(), d()]), HeirloomError::SuccessionPending);
    warp(&mut env.svm, WAITING);
    env.set_seat_backups(&owner, 0, [d(), d()]).unwrap();
    let s = env.seat(0);
    assert_eq!((s.death_cert_hash, s.backups), ([0u8; 32], [d(), d()]));
}

#[test]
fn r06_a_legacy_report_with_time_zero_is_stale_at_once() {
    let (mut env, _people) = guardian_env();
    let (v1, kid) = (env.v(1), env.kid1.insecure_clone());
    env.report_seat_death(&v1, 0).unwrap();
    let mut s = env.seat(0);
    s.death_pending_since = 0;
    env.plant(seat_pda(&env.estate, 0), &s);
    env.report_seat_death(&kid, 0).unwrap();
}

#[test]
fn r06_the_agent_cannot_review_a_report_that_replaced_the_one_it_read() {
    let (mut env, _people) = guardian_env();
    let v1 = env.v(1);
    env.report_seat_death(&v1, 0).unwrap();
    let review = |env: &Env, cert_hash: [u8; 32]| {
        ix(
            heirloom::accounts::ReviewSeatDeath { agent: env.agent.pubkey(), estate: env.estate, seat: seat_pda(&env.estate, 0) },
            heirloom::instruction::ReviewSeatDeath { index: 0, approve: true, report_hash: [9u8; 32], cert_hash, holder: env.seat(0).holder },
        )
    };
    let i = review(&env, [1u8; 32]);
    expect_err(send(&mut env.svm, i, &[&env.agent]), HeirloomError::ReportChanged);
    let i = review(&env, [8u8; 32]);
    send(&mut env.svm, i, &[&env.agent]).unwrap();
}

#[test]
fn r06_the_agent_cannot_confirm_a_seat_death() {
    let (mut env, _people) = guardian_env();
    let owner = env.kp(&env.owner);
    for i in 0..2 {
        env.set_seat_backups(&owner, i, [d(), d()]).unwrap();
    }
    let (v1, v2, kid, agent) = (env.v(1), env.v(2), env.kid1.insecure_clone(), env.agent.insecure_clone());
    env.succeed(0, &v1);
    env.succeed(1, &v2);
    env.set_seat_monitors(2, [agent.pubkey(), d()]).unwrap();
    env.report_seat_death(&kid, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    expect_err(env.confirm_seat_death(&agent, 2), HeirloomError::NotConfirmer);
}

// ------------------------------------------------------------------- R9 one wallet, one vote

#[test]
fn r09_one_monitor_of_two_seats_is_one_vote() {
    let (mut env, people) = fallback_env();
    let m0 = env.kp(&people.monitors[0]);
    env.set_seat_monitors(1, [m0.pubkey(), d()]).unwrap();
    env.claim_again();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let (guard, kid2) = (guard_pda(&env.estate), env.kid2.insecure_clone());
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 0, None, true, None, None).unwrap();
    let seats = env.all_seats();
    env.vote_objection(&m0, guard, true, seats, None, None).unwrap();
    expect_err(env.vote_objection(&m0, guard, true, seats, None, None), HeirloomError::AlreadyApproved);
    expect_err(env.vote_objection(&m0, guard, false, seats, None, None), HeirloomError::AlreadyApproved);
    let o = env.objection(&guard);
    assert_eq!((o.status, o.votes_uphold), (ObjectionStatus::Open, 0b1));

    let m2 = env.kp(&people.monitors[2]);
    env.vote_objection(&m2, guard, true, seats, None, None).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Upheld);
}

#[test]
fn r09_a_vote_already_cast_from_another_position_counts_as_the_vote() {
    let (mut env, people) = fallback_env();
    let m0 = env.kp(&people.monitors[0]);
    env.set_seat_monitors(1, [m0.pubkey(), d()]).unwrap();
    env.claim_again();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let (guard, kid2) = (guard_pda(&env.estate), env.kid2.insecure_clone());
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 0, None, true, None, None).unwrap();
    // As the older program recorded a vote from seat 1.
    let mut o = env.objection(&guard);
    o.votes_uphold = 0b100;
    env.plant(objection_pda(&guard), &o);
    let seats = env.all_seats();
    expect_err(env.vote_objection(&m0, guard, true, seats, None, None), HeirloomError::AlreadyApproved);
}

#[test]
fn r09_the_three_seats_are_required_in_order() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let (guard, kid2, m0) = (guard_pda(&env.estate), env.kid2.insecure_clone(), env.kp(&people.monitors[0]));
    env.raise_objection(&kid2, TargetKind::Fallback, guard, 0, None, true, None, None).unwrap();
    expect_err(env.vote_objection(&m0, guard, true, None, None, None), HeirloomError::NotMonitor);
    let [s0, s1, s2] = env.all_seats().unwrap();
    expect_err(env.vote_objection(&m0, guard, true, Some([s1, s0, s2]), None, None), HeirloomError::BadStatus);
    expect_err(env.vote_objection(&m0, guard, true, Some([s0, s0, s2]), None, None), HeirloomError::BadStatus);
    env.vote_objection(&m0, guard, true, Some([s0, s1, s2]), None, None).unwrap();
}

// ------------------------------------------------------------------- R10 succession never sticks

#[test]
fn r10_the_only_backup_reporting_clears_for_a_fresh_report() {
    let (mut env, people) = guardian_env();
    let (b, owner) = (env.kp(&people.backups[0][0]), env.kp(&env.owner));
    env.set_seat_backups(&owner, 0, [b.pubkey(), d()]).unwrap();
    let (v1, kid) = (env.v(1), env.kid1.insecure_clone());
    env.report_seat_death(&b, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(0).unwrap();
    let s = env.seat(0);
    assert_eq!((s.death_cert_hash, s.vacant, s.generation), ([0u8; 32], false, 0));
    assert_eq!((s.holder, s.backups), (env.verifiers[0].pubkey(), [b.pubkey(), d()]));

    env.report_seat_death(&kid, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(0).unwrap();
    assert_eq!(env.seat(0).holder, b.pubkey());
}

#[test]
fn r10_the_only_backup_confirming_clears_for_a_fresh_report() {
    let (mut env, people) = guardian_env();
    env.leave_one_survivor();
    let (b0, b1) = (env.kp(&people.backups[2][0]), env.kp(&people.backups[2][1]));
    env.report_seat_death(&b0, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&b1, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(2).unwrap();
    let s = env.seat(2);
    assert_eq!((s.death_cert_hash, s.vacant), ([0u8; 32], false));
}

#[test]
fn r10_a_seat_vacates_when_no_backup_could_ever_be_eligible() {
    let (mut env, _people) = guardian_env();
    let shared = funded(&mut env.svm);
    let owner = env.kp(&env.owner);
    env.set_seat_backups(&owner, 0, [shared.pubkey(), d()]).unwrap();
    env.set_seat_backups(&owner, 2, [shared.pubkey(), d()]).unwrap();
    let v1 = env.v(1);
    env.succeed(2, &v1);
    assert_eq!(env.seat(2).holder, shared.pubkey());
    env.succeed(0, &v1);
    assert!(env.seat(0).vacant);
    assert_eq!(env.estate_state().verifiers[0], d());
}

#[test]
fn r10_the_agent_is_never_promoted() {
    let (mut env, people) = guardian_env();
    let mut s = env.seat(0);
    s.backups = [env.agent.pubkey(), people.backups[0][1].pubkey()];
    env.plant(seat_pda(&env.estate, 0), &s);
    let v1 = env.v(1);
    env.succeed(0, &v1);
    assert_eq!(env.seat(0).holder, people.backups[0][1].pubkey());
}

impl Env {
    fn register_asset_ix(&self, nft_mint: Pubkey, proceeds_to: Pubkey) -> Instruction {
        let owner = self.owner.pubkey();
        ix(
            heirloom::accounts::RegisterAsset {
                owner,
                estate: self.estate,
                nft_mint,
                owner_nft: ata(&owner, &nft_mint),
                nft_escrow: ata(&self.estate, &nft_mint),
                asset: asset_pda(&self.estate, &nft_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
            },
            heirloom::instruction::RegisterAsset {
                floor_price: FLOOR,
                hardship_floor: HARDSHIP_FLOOR,
                asking_price: ASKING,
                proceeds_to,
                doc_hash: [3u8; 32],
            },
        )
    }

    /// The owner's title, registered.
    fn registered_title(&mut self) -> Pubkey {
        let nft_mint = create_title(&mut self.svm);
        let owner = self.owner.pubkey();
        fund_ata(&mut self.svm, &owner, &nft_mint, 1);
        let i = self.register_asset_ix(nft_mint, self.executor.pubkey());
        send(&mut self.svm, i, &[&self.owner]).unwrap();
        nft_mint
    }

    fn release_asset_by(&mut self, who: &Keypair, nft_mint: Pubkey) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::ReleaseAsset {
                owner: who.pubkey(),
                estate: self.estate,
                asset: asset_pda(&self.estate, &nft_mint),
                nft_mint,
                nft_escrow: ata(&self.estate, &nft_mint),
                owner_nft: ata(&who.pubkey(), &nft_mint),
                token_program: token_program(),
            },
            heirloom::instruction::ReleaseAsset {},
        );
        send(&mut self.svm, i, &[who])
    }

    /// After the unlock: each holder empties their backups, then all three die.
    fn vacate_all_after_unlock(&mut self, people: &People) {
        for i in 0..3 {
            let v = self.v(i);
            self.set_seat_backups(&v, i as u8, [d(), d()]).unwrap();
        }
        let (v1, v2) = (self.v(1), self.v(2));
        self.succeed(0, &v1);
        self.succeed(1, &v2);
        let m2 = self.kp(&people.monitors[2]);
        self.succeed(2, &m2);
    }
}

// ------------------------------------------------------------------- R12 the agent cannot sell alone

#[test]
fn r12_a_sale_needs_a_living_trusted_persons_co_signature() {
    let mut s = Sale::new();
    s.place_offer(1, FLOOR).unwrap();
    let (agent, stranger, buyer) =
        (s.env.agent.insecure_clone(), s.env.stranger.insecure_clone(), s.env.buyer1.insecure_clone());
    expect_err(s.accept_offer_with(1, None), HeirloomError::CoSignerRequired);
    for who in [&agent, &stranger, &buyer] {
        expect_err(s.accept_offer_with(1, Some(who)), HeirloomError::CoSignerRequired);
    }
    let v2 = s.env.v(2);
    s.accept_offer_with(1, Some(&v2)).unwrap();
}

#[test]
fn r12_the_co_signer_cannot_be_the_buyer() {
    let mut s = Sale::new();
    s.place_offer(1, FLOOR).unwrap();
    let mut e = s.env.estate_state();
    e.verifiers[0] = s.env.buyer1.pubkey();
    let estate = s.env.estate;
    s.env.plant(estate, &e);
    let buyer = s.env.buyer1.insecure_clone();
    expect_err(s.accept_offer_with(1, Some(&buyer)), HeirloomError::CoSignerRequired);
}

#[test]
fn r12_the_agent_cannot_sell_to_itself() {
    let mut s = Sale::new();
    s.place_offer(1, FLOOR).unwrap();
    let mut e = s.env.estate_state();
    e.agent = s.env.buyer1.pubkey();
    let estate = s.env.estate;
    s.env.plant(estate, &e);
    s.env.agent = s.env.buyer1.insecure_clone();
    expect_err(s.accept_offer(1), HeirloomError::BadAgent);
}

#[test]
fn r12_with_no_seats_left_the_sale_waits_for_the_listing_to_end() {
    let mut s = Sale::build(true);
    let people = s.people.take().unwrap();
    s.env.vacate_all_after_unlock(&people);
    s.place_offer(1, FLOOR).unwrap();
    expect_err(s.accept_offer_with(1, None), HeirloomError::ListingStillOpen);
    let ends = fetch::<Asset>(&s.env.svm, &s.asset).listing_ends;
    let wait = ends - now(&s.env.svm);
    warp(&mut s.env.svm, wait - 1);
    expect_err(s.accept_offer_with(1, None), HeirloomError::ListingStillOpen);
    warp(&mut s.env.svm, 1);
    s.accept_offer_with(1, None).unwrap();
}

// ------------------------------------------------------------------- R13 a title's authorities

#[test]
fn r13_a_title_must_have_no_mint_or_freeze_authority() {
    let mut env = Env::configured();
    let (owner, executor) = (env.owner.pubkey(), env.executor.pubkey());
    let mintable = create_mint(&mut env.svm, &owner, 1, 0);
    fund_ata(&mut env.svm, &owner, &mintable, 1);
    let i = env.register_asset_ix(mintable, executor);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidNft);

    let freezable = create_title(&mut env.svm);
    let mut data = env.svm.get_account(&freezable).unwrap().data;
    data[46..50].copy_from_slice(&1u32.to_le_bytes());
    data[50..82].copy_from_slice(owner.as_ref());
    set_token_state(&mut env.svm, freezable, data);
    fund_ata(&mut env.svm, &owner, &freezable, 1);
    let i = env.register_asset_ix(freezable, executor);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidNft);

    env.registered_title();
}

// ------------------------------------------------------------------- R14 setup values

#[test]
fn r14_three_real_trusted_people_and_a_real_agent() {
    let mut env = Env::new();
    let v = env.verifier_keys();
    let i = env.create_estate_ix([v[0], d(), v[2]], 2, 1, 2, WAITING);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidWallet);

    let real = env.agent.insecure_clone();
    for bad in [env.owner.insecure_clone(), env.v(1)] {
        env.agent = bad;
        let i = env.create_estate_ix(v, 2, 1, 2, WAITING);
        expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::BadAgent);
    }
    let mut i = env.create_estate_ix(v, 2, 1, 2, WAITING);
    i.data[8..40].copy_from_slice(&[0u8; 32]);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::BadAgent);

    env.agent = real;
    env.create_estate();
}

#[test]
fn r14_the_agent_cannot_become_a_trusted_person() {
    let (mut env, _people) = guardian_env();
    let (agent, owner) = (env.agent.pubkey(), env.kp(&env.owner));
    expect_err(env.replace_seat(0, agent), HeirloomError::BadAgent);
    expect_err(env.set_seat_backups(&owner, 0, [agent, d()]), HeirloomError::BadBackup);
}

#[test]
fn r14_proceeds_need_a_real_wallet() {
    let mut env = Env::configured();
    let nft_mint = create_title(&mut env.svm);
    let owner = env.owner.pubkey();
    fund_ata(&mut env.svm, &owner, &nft_mint, 1);
    let i = env.register_asset_ix(nft_mint, d());
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::InvalidWallet);
    let i = env.register_asset_ix(nft_mint, env.executor.pubkey());
    send(&mut env.svm, i, &[&env.owner]).unwrap();
}

#[test]
fn r14_a_rules_end_date_is_in_the_future() {
    let mut env = Env::configured();
    let (kid, t) = (env.kid1.pubkey(), now(&env.svm));
    let i = env.add_rule_ix(0, kid, PayeeKind::University, USDT, USDT, t, false, 0, 0, 0, None);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::TimeOutOfRange);
    env.add_rule(0, kid, PayeeKind::University, USDT, USDT, t + 1);
}

// ------------------------------------------------------------------- R15 take an asset back

#[test]
fn r15_a_living_owner_takes_the_title_back_and_can_register_it_again() {
    let mut env = Env::configured();
    let nft_mint = env.registered_title();
    let owner = env.owner.insecure_clone();
    let (escrow, asset) = (ata(&env.estate, &nft_mint), asset_pda(&env.estate, &nft_mint));
    env.release_asset_by(&owner, nft_mint).unwrap();
    assert_eq!(balance(&env.svm, &ata(&owner.pubkey(), &nft_mint)), 1);
    assert!(is_closed(&env.svm, &escrow) && is_closed(&env.svm, &asset));

    let i = env.register_asset_ix(nft_mint, env.executor.pubkey());
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    assert_eq!(balance(&env.svm, &escrow), 1);
}

#[test]
fn r15_only_the_owner_while_active_and_held() {
    let mut env = Env::configured();
    let nft_mint = env.registered_title();
    let (owner, stranger) = (env.owner.insecure_clone(), env.stranger.insecure_clone());
    fund_ata(&mut env.svm, &stranger.pubkey(), &nft_mint, 0);
    assert!(env.release_asset_by(&stranger, nft_mint).is_err());

    let address = asset_pda(&env.estate, &nft_mint);
    let held: Asset = fetch(&env.svm, &address);
    let mut listed: Asset = fetch(&env.svm, &address);
    listed.status = AssetStatus::Listed;
    env.plant(address, &listed);
    expect_err(env.release_asset_by(&owner, nft_mint), HeirloomError::BadStatus);
    env.plant(address, &held);

    env.death_pending();
    expect_err(env.release_asset_by(&owner, nft_mint), HeirloomError::BadStatus);
    warp(&mut env.svm, WAITING);
    env.finalize_unlock().unwrap();
    expect_err(env.release_asset_by(&owner, nft_mint), HeirloomError::BadStatus);
}

impl Env {
    fn remove_member_by(&mut self, who: &Keypair, beneficiary: Option<Pubkey>, payee: Option<Pubkey>) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::RemoveMember {
                owner: who.pubkey(),
                estate: self.estate,
                beneficiary_account: beneficiary.map(|w| beneficiary_pda(&self.estate, &w)),
                payee_account: payee.map(|w| payee_pda(&self.estate, &w)),
                seat0: seat_pda(&self.estate, 0),
                seat1: seat_pda(&self.estate, 1),
                seat2: seat_pda(&self.estate, 2),
            },
            heirloom::instruction::RemoveMember {},
        );
        send(&mut self.svm, i, &[who])
    }

    fn remove_beneficiary(&mut self, wallet: Pubkey) -> Result<(), String> {
        let owner = self.owner.insecure_clone();
        self.remove_member_by(&owner, Some(wallet), None)
    }

    fn remove_payee(&mut self, wallet: Pubkey) -> Result<(), String> {
        let owner = self.owner.insecure_clone();
        self.remove_member_by(&owner, None, Some(wallet))
    }
}

/// Anchor's AccountNotInitialized: what a closed Payee PDA gives.
fn expect_missing_account(res: Result<(), String>) {
    let e = res.expect_err("expected the missing account to be refused");
    assert!(e.contains("Custom(3012)"), "expected Custom(3012), got {e}");
}

/// kid1's living rule that pays the university 100 a month from now.
fn scheduled_rule(env: &mut Env) -> Pubkey {
    let (kid, uni, t) = (env.kid1.pubkey(), env.university.pubkey(), now(&env.svm));
    let i = env.add_rule_ix(0, kid, PayeeKind::University, 600 * USDT, 1_000 * USDT, t + 365 * DAY, true, 100 * USDT, 30 * DAY, t, Some(uni));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    rule_pda(&env.estate, 0)
}

// ------------------------------------------------------------------- R16 removal

#[test]
fn r16_a_removed_payee_stops_open_claims() {
    let mut env = Env::configured();
    let (rule, claim) = living_claim(&mut env);
    env.owner_approve_claim(rule, claim).unwrap();
    let uni = env.university.pubkey();
    env.remove_payee(uni).unwrap();
    assert!(is_closed(&env.svm, &payee_pda(&env.estate, &uni)));
    expect_missing_account(env.execute_claim(rule, claim));
    expect_missing_account(env.submit_claim(true, rule, uni, USDT).map(|_| ()));
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);

    // Added again, it can be paid again.
    env.add_payee(uni, PayeeKind::University, "University");
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn r16_a_payee_added_back_as_another_kind_is_not_paid() {
    let mut env = Env::configured();
    let (rule, claim) = living_claim(&mut env);
    env.owner_approve_claim(rule, claim).unwrap();
    let uni = env.university.pubkey();
    env.remove_payee(uni).unwrap();
    env.add_payee(uni, PayeeKind::Landlord, "Residence");
    expect_err(env.execute_claim(rule, claim), HeirloomError::WrongPayeeKind);
}

#[test]
fn r16_a_removed_payee_stops_the_schedule() {
    let mut env = Env::configured();
    let rule = scheduled_rule(&mut env);
    let uni = env.university.pubkey();
    env.remove_payee(uni).unwrap();
    expect_missing_account(env.execute_scheduled(rule));
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

#[test]
fn r16_a_removed_beneficiary_stops_claims_schedules_death_claims_disputes_and_rules() {
    let mut env = Env::configured();
    let (rule, claim) = living_claim(&mut env);
    env.owner_approve_claim(rule, claim).unwrap();
    let (kid, uni, until) = (env.kid1.pubkey(), env.university.pubkey(), now(&env.svm) + 365 * DAY);
    let t = now(&env.svm);
    let i = env.add_rule_ix(1, kid, PayeeKind::University, 100 * USDT, 500 * USDT, until, true, 100 * USDT, 30 * DAY, t, Some(uni));
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let schedule = rule_pda(&env.estate, 1);

    env.remove_beneficiary(kid).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::NotBeneficiary);
    expect_err(env.execute_scheduled(schedule), HeirloomError::NotBeneficiary);
    expect_err(env.submit_claim(true, rule, uni, USDT), HeirloomError::NotBeneficiary);
    expect_err(env.submit_death_claim(1), HeirloomError::NotBeneficiary);
    let i = env.add_rule_ix(2, kid, PayeeKind::University, USDT, USDT, until, false, 0, 0, 0, None);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::NotBeneficiary);
    let k1 = env.kid1.insecure_clone();
    expect_err(env.raise_dispute(&k1, TargetKind::Claim, claim, true, [5u8; 32]), HeirloomError::NotDisputer);
    expect_err(env.remove_beneficiary(kid), HeirloomError::NotBeneficiary);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

#[test]
fn r16_a_removed_beneficiary_can_be_added_again_but_an_active_one_cannot() {
    let mut env = Env::configured();
    let kid = env.kid1.pubkey();
    let add = |env: &Env| {
        ix(
            heirloom::accounts::AddBeneficiary {
                owner: env.owner.pubkey(),
                estate: env.estate,
                wallet: env.kid1.pubkey(),
                beneficiary: beneficiary_pda(&env.estate, &env.kid1.pubkey()),
                system_program: system_program(),
            },
            heirloom::instruction::AddBeneficiary { label: "Eldest".to_string() },
        )
    };
    let i = add(&env);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::BadStatus);
    env.remove_beneficiary(kid).unwrap();
    let address = beneficiary_pda(&env.estate, &kid);
    assert!(!fetch::<Beneficiary>(&env.svm, &address).active);
    let i = add(&env);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let b: Beneficiary = fetch(&env.svm, &address);
    assert!(b.active);
    assert_eq!(b.label, "Eldest");
    env.submit_death_claim(1).unwrap();
}

#[test]
fn r16_a_removal_is_proof_of_life() {
    let mut env = Env::configured();
    let kid = env.kid1.pubkey();
    env.submit_death_claim(1).unwrap();
    warp(&mut env.svm, 3);
    env.remove_beneficiary(kid).unwrap();
    let e = env.estate_state();
    assert_eq!((e.death_cert_hash, e.last_heartbeat), ([0u8; 32], now(&env.svm)));
}

#[test]
fn r16_only_the_owner_removes_while_active_and_names_someone() {
    let mut env = Env::configured();
    let (owner, stranger, kid) = (env.owner.insecure_clone(), env.stranger.insecure_clone(), env.kid1.pubkey());
    assert!(env.remove_member_by(&stranger, Some(kid), None).is_err());
    expect_err(env.remove_member_by(&owner, None, None), HeirloomError::BadStatus);
    env.unlock();
    expect_err(env.remove_beneficiary(kid), HeirloomError::BadStatus);
    let uni = env.university.pubkey();
    expect_err(env.remove_payee(uni), HeirloomError::BadStatus);
}

#[test]
fn r16_both_can_be_removed_at_once() {
    let mut env = Env::configured();
    let (owner, kid, uni) = (env.owner.insecure_clone(), env.kid1.pubkey(), env.university.pubkey());
    env.remove_member_by(&owner, Some(kid), Some(uni)).unwrap();
    assert!(!fetch::<Beneficiary>(&env.svm, &beneficiary_pda(&env.estate, &kid)).active);
    assert!(is_closed(&env.svm, &payee_pda(&env.estate, &uni)));
}

// ------------------------------------------------------------------- R17 reuse a slot

#[test]
fn r17_reuse_never_revives_or_collides_with_an_old_claim() {
    let mut env = Env::configured();
    let (rule, old) = living_claim(&mut env);
    env.owner_approve_claim(rule, old).unwrap();
    let (uni, kid, owner) = (env.university.pubkey(), env.kid1.pubkey(), env.owner.insecure_clone());
    let unapproved = env.submit_claim(true, rule, uni, 50 * USDT).unwrap();
    env.review_claim(unapproved, true).unwrap();
    env.end_rule(&owner, rule).unwrap();

    let until = now(&env.svm) + 365 * DAY;
    let i = env.add_rule_ix(0, kid, PayeeKind::University, 600 * USDT, 1_000 * USDT, until, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!((r.claim_count, r.spent_total, env.estate_state().rule_count), (65_536, 0, 1));
    expect_err(env.execute_claim(rule, old), HeirloomError::ClaimFromEndedRule);
    expect_err(env.owner_approve_claim(rule, unapproved), HeirloomError::ClaimFromEndedRule);

    let fresh = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    assert_eq!(fresh, claim_pda(&rule, 65_536));
    env.review_claim(fresh, true).unwrap();
    env.owner_approve_claim(rule, fresh).unwrap();
    env.execute_claim(rule, fresh).unwrap();

    env.unlock();
    expect_err(env.execute_claim(rule, old), HeirloomError::ClaimFromEndedRule);
}

#[test]
fn r17_a_second_reuse_takes_the_next_range() {
    let mut env = Env::configured();
    let (rule, _claim) = living_claim(&mut env);
    let (kid, owner) = (env.kid1.pubkey(), env.owner.insecure_clone());
    for round in 1..=2u32 {
        env.end_rule(&owner, rule).unwrap();
        env.add_rule(0, kid, PayeeKind::University, USDT, USDT, now(&env.svm) + 365 * DAY);
        // With or without claims in between.
        assert_eq!(fetch::<Rule>(&env.svm, &rule).claim_count, round * 65_536);
    }
}

#[test]
fn r17_a_rules_claim_ids_cannot_run_into_the_next_range() {
    let (mut env, rule) = claims_env();
    let mut r: Rule = fetch(&env.svm, &rule);
    r.claim_count = 65_535;
    env.plant(rule, &r);
    env.unlock();
    let uni = env.university.pubkey();
    expect_err(env.submit_claim(true, rule, uni, USDT), HeirloomError::MathOverflow);
}

#[test]
fn r17_a_live_rules_slot_cannot_be_reused() {
    let (mut env, _rule) = claims_env();
    let (kid, until) = (env.kid1.pubkey(), now(&env.svm) + 30 * DAY);
    let i = env.add_rule_ix(0, kid, PayeeKind::University, USDT, USDT, until, false, 0, 0, 0, None);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::BadStatus);
    // Nor can an id be skipped.
    let i = env.add_rule_ix(2, kid, PayeeKind::University, USDT, USDT, until, false, 0, 0, 0, None);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::BadStatus);
}

#[test]
fn r17_an_expired_rules_slot_can_be_reused_only_while_active() {
    let (mut env, rule) = claims_env();
    warp(&mut env.svm, 366 * DAY);
    let (kid, until) = (env.kid1.pubkey(), now(&env.svm) + 30 * DAY);
    env.add_rule(0, kid, PayeeKind::University, USDT, USDT, until);
    assert_eq!(fetch::<Rule>(&env.svm, &rule).valid_until, until);

    warp(&mut env.svm, 31 * DAY);
    env.unlock();
    let i = env.add_rule_ix(0, kid, PayeeKind::University, USDT, USDT, now(&env.svm) + DAY, false, 0, 0, 0, None);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::BadStatus);
}

#[test]
fn r17_reuse_drops_the_old_yearly_cap() {
    let mut env = Env::configured();
    let rule = scheduled_rule(&mut env);
    env.set_yearly_cap(rule, 100 * USDT, 0).unwrap();
    env.execute_scheduled(rule).unwrap();
    let owner = env.owner.insecure_clone();
    env.end_rule(&owner, rule).unwrap();
    warp(&mut env.svm, 1);
    let again = scheduled_rule(&mut env);
    assert!(is_closed(&env.svm, &year_cap_pda(&again)));
    env.execute_scheduled(again).unwrap();
    assert_eq!(fetch::<Rule>(&env.svm, &again).spent_total, 100 * USDT);

    env.set_yearly_cap(again, 300 * USDT, 0).unwrap();
    let yc = env.year_cap(&again);
    assert_eq!((yc.cap, yc.period_spent), (300 * USDT, 0));
}

#[test]
fn r17_sixteen_slots_reused_and_the_sweep_still_needs_every_one() {
    let mut env = Env::configured();
    let (kid, until, owner) = (env.kid1.pubkey(), now(&env.svm) + 365 * DAY, env.owner.insecure_clone());
    let rules: Vec<Pubkey> = (0..16).map(|id| env.add_rule(id, kid, PayeeKind::University, USDT, USDT, until)).collect();
    env.end_rule(&owner, rules[7]).unwrap();
    env.add_rule(7, kid, PayeeKind::University, 10 * USDT, 10 * USDT, until);
    assert_eq!(env.estate_state().rule_count, 16);

    let heir = env.kid2.pubkey();
    env.set_residual(heir).unwrap();
    env.unlock();
    expect_err(env.sweep(heir, &rules[..15]), HeirloomError::RulesIncomplete);
    env.sweep(heir, &rules).unwrap();
    assert_eq!(balance(&env.svm, &env.vault()), 25 * USDT, "15 rules of 1 and the reused one of 10");
}

// =================================================================== accounts from before this upgrade

/// Borsh bytes written by hand, as the program deployed before this upgrade stored them.
struct Raw(Vec<u8>);

impl Raw {
    fn new(discriminator: [u8; 8]) -> Self {
        Raw(discriminator.to_vec())
    }
    fn put(mut self, bytes: &[u8]) -> Self {
        self.0.extend_from_slice(bytes);
        self
    }
    fn key(self, n: u8) -> Self {
        self.put(&[n; 32])
    }
    fn text(self, s: &str) -> Self {
        self.put(&(s.len() as u32).to_le_bytes()).put(s.as_bytes())
    }
    fn i64(self, v: i64) -> Self {
        self.put(&v.to_le_bytes())
    }
    fn u64(self, v: u64) -> Self {
        self.put(&v.to_le_bytes())
    }
}

/// Decodes, writes back byte for byte, and the allocated size is the deployed one.
fn decodes<T: AccountDeserialize + AccountSerialize + Space>(raw: Raw, deployed_size: usize) -> T {
    let value = T::try_deserialize(&mut raw.0.as_slice()).expect("an account from before this upgrade must decode");
    let mut out = Vec::new();
    value.try_serialize(&mut out).unwrap();
    assert_eq!(out, raw.0);
    assert_eq!(8 + T::INIT_SPACE, deployed_size, "the account's size changed");
    value
}

#[test]
fn compat_every_account_type_from_before_this_upgrade_still_decodes() {
    let k = |n: u8| Pubkey::new_from_array([n; 32]);

    let e: Estate = decodes(
        Raw::new([193, 23, 206, 61, 104, 225, 211, 221])
            .key(1).key(2).key(3).key(4).key(5).key(6)
            .put(&[2, 1, 3]).i64(120).put(&[1]).key(7).text("ipfs://will").key(8).key(9)
            .put(&[3, 0b101]).i64(1_763_000_000).i64(1_762_000_000).put(&16u16.to_le_bytes()).put(&[255]),
        8 + 32 * 6 + 3 + 8 + 1 + 32 + 204 + 32 + 32 + 2 + 8 + 8 + 2 + 1,
    );
    assert_eq!((e.owner, e.verifiers[2], e.status, e.death_verdict), (k(1), k(6), EstateStatus::DeathPending, Verdict::Referred));
    assert_eq!((e.death_pending_since, e.last_heartbeat, e.rule_count), (1_763_000_000, 1_762_000_000, 16));

    let b: Beneficiary = decodes(
        Raw::new([45, 182, 224, 198, 197, 255, 233, 33]).key(1).key(2).text("Child 1").put(&[1, 254]),
        8 + 32 + 32 + 36 + 2,
    );
    assert!(b.active);

    let p: Payee = decodes(
        Raw::new([55, 185, 7, 92, 94, 200, 10, 246]).key(1).key(2).put(&[2]).text("Landlord").put(&[253]),
        8 + 32 + 32 + 1 + 68 + 1,
    );
    assert_eq!(p.kind, PayeeKind::Landlord);

    let r: Rule = decodes(
        Raw::new([82, 10, 53, 40, 250, 61, 143, 130])
            .key(1).put(&4u16.to_le_bytes()).key(2).put(&[4, 3]).u64(600).u64(1_000).u64(250).i64(1_800_000_000)
            .put(&7u32.to_le_bytes()).put(&[1]).u64(100).i64(60).i64(1_763_000_000).key(3).put(&[252]),
        8 + 32 + 2 + 32 + 2 + 8 * 4 + 4 + 1 + 8 * 3 + 32 + 1,
    );
    assert_eq!((r.id, r.spent_total, r.claim_count, r.fixed_payee), (4, 250, 7, k(3)));
    // A slot that was never reused: every claim id so far is current.
    assert!(r.is_current_claim(0) && r.is_current_claim(6));

    let c: Claim = decodes(
        Raw::new([155, 70, 22, 176, 123, 215, 246, 102])
            .key(1).key(2).put(&6u32.to_le_bytes()).key(3).key(4).u64(500).key(5).put(&[1]).key(6)
            .put(&[0b011, 0]).i64(1_763_000_000).put(&[1, 251]),
        8 + 32 * 2 + 4 + 32 * 2 + 8 + 32 + 1 + 32 + 2 + 8 + 2,
    );
    assert!(c.owner_approved && c.status == ClaimStatus::Open);

    let a: Asset = decodes(
        Raw::new([234, 180, 241, 252, 139, 224, 160, 8])
            .key(1).key(2).u64(9).u64(7).u64(10).key(3).put(&[1]).i64(1_763_000_000).key(4).put(&[1]).key(5).put(&[250]),
        8 + 32 * 2 + 8 * 3 + 32 + 1 + 8 + 32 + 33 + 1,
    );
    assert_eq!((a.status, a.hardship_beneficiary), (AssetStatus::Listed, Some(k(5))));

    let o: heirloom::Offer = decodes(
        Raw::new([215, 88, 60, 71, 170, 162, 73, 229]).key(1).key(2).u64(9_000).i64(1_763_000_000).put(&[249]),
        8 + 32 * 2 + 8 + 8 + 1,
    );
    assert_eq!(o.amount, 9_000);

    let h: Hardship = decodes(
        Raw::new([102, 188, 125, 76, 208, 132, 55, 26]).key(1).key(2).key(3).put(&[3]).key(4).put(&[0b10, 1, 248]),
        8 + 32 * 3 + 1 + 32 + 3,
    );
    assert_eq!(h.status, HardshipStatus::Approved);

    let s: Seat = decodes(
        Raw::new([90, 228, 22, 90, 162, 86, 173, 26])
            .key(1).put(&[2]).key(2).key(3).key(4).key(5).key(6).put(&9u16.to_le_bytes()).put(&[0])
            .key(7).key(8).put(&[1]).key(9).i64(1_763_000_000).put(&[247]),
        8 + 32 + 1 + 32 * 5 + 2 + 1 + 32 * 2 + 1 + 32 + 8 + 1,
    );
    assert_eq!((s.index, s.generation, s.death_confirmed_by), (2, 9, k(9)));

    let g: Guard = decodes(
        Raw::new([54, 187, 84, 137, 192, 15, 74, 248])
            .key(1).i64(60).i64(61).i64(62).put(&3u16.to_le_bytes()).key(2).key(3).key(4).key(5)
            .put(&[0b1]).i64(1_763_000_000).put(&[0, 246]),
        8 + 32 + 8 * 3 + 2 + 32 * 4 + 1 + 8 + 2,
    );
    assert_eq!((g.fallback_wait_secs, g.next_fallback_recipient()), (62, k(3)));

    let st: ApprovalStamp = decodes(
        Raw::new([223, 53, 41, 132, 211, 7, 38, 144]).key(1).put(&[1]).key(2).i64(1_763_000_000).put(&[245]),
        8 + 32 + 1 + 32 + 8 + 1,
    );
    assert_eq!(st.approved_at, 1_763_000_000);

    let ob: Objection = decodes(
        Raw::new([227, 142, 9, 142, 145, 166, 42, 91])
            .key(1).key(2).put(&[5]).key(3).put(&[255]).key(4).i64(1_763_000_000).put(&[0, 0b0100, 0b0001, 244]),
        8 + 32 * 2 + 1 + 32 + 1 + 32 + 8 + 4,
    );
    assert_eq!((ob.kind, ob.status), (TargetKind::Fallback, ObjectionStatus::Open));

    let m: AssetMedia = decodes(
        Raw::new([32, 60, 22, 217, 123, 33, 215, 231]).key(1).put(&[5]).key(2).put(&[24]).i64(1_763_000_000).put(&[243]),
        8 + 32 + 1 + 32 + 1 + 8 + 1,
    );
    assert_eq!(m.photo_count, 24);

    let y: YearCap = decodes(
        Raw::new([252, 131, 4, 241, 105, 64, 177, 86]).key(1).u64(800).i64(1_763_000_000).u64(300).put(&[242]),
        8 + 32 + 8 * 3 + 1,
    );
    assert_eq!(y.period_spent, 300);

    let re: heirloom::Residual = decodes(
        Raw::new([2, 202, 44, 147, 115, 240, 25, 130]).key(1).key(2).put(&[241]),
        8 + 32 * 2 + 1,
    );
    assert_eq!(re.recipient, k(2));

    let v: heirloom::AgentVote = decodes(
        Raw::new([220, 51, 114, 184, 194, 29, 176, 108]).key(1).key(2).key(3).key(4).key(5).key(6).put(&[240]),
        8 + 32 * 6 + 1,
    );
    assert_eq!(v.voters[2], k(6));
}

#[test]
fn compat_error_codes_already_deployed_keep_their_numbers() {
    let code = |e: HeirloomError| 6000 + e as u32;
    assert_eq!(code(HeirloomError::NotOwner), 6000);
    assert_eq!(code(HeirloomError::NotDue), 6025);
    assert_eq!(code(HeirloomError::ObjectionNotLapsed), 6041);
    assert_eq!(code(HeirloomError::ObjectionCooldown), 6052);
    assert_eq!(code(HeirloomError::NotParticipant), 6053);
    assert_eq!(code(HeirloomError::ClaimFromEndedRule), 6060);
    assert_eq!(code(HeirloomError::OfferChanged), 6061);
}

// =================================================================== second review: edges of the checks above

impl Env {
    /// An account of this program at a fresh address: what a spoof from another estate would be.
    fn plant_elsewhere<T: AccountSerialize>(&mut self, value: &T) -> Pubkey {
        let address = Pubkey::new_unique();
        let mut data = Vec::new();
        value.try_serialize(&mut data).unwrap();
        data.resize(data.len() + 64, 0);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(address, Account { lamports, data, owner: heirloom::id(), executable: false, rent_epoch: 0 })
            .unwrap();
        address
    }

    fn execute_claim_ix(&self, rule: Pubkey, claim: Pubkey, beneficiary_account: Pubkey, payee_account: Pubkey) -> Instruction {
        let c: Claim = fetch(&self.svm, &claim);
        ix(
            heirloom::accounts::ExecuteClaim {
                payer: self.stranger.pubkey(),
                estate: self.estate,
                rule,
                claim,
                payee_wallet: c.payee,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                payee_usdt: ata(&c.payee, &self.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                guard: guard_pda(&self.estate),
                approval_stamp: stamp_pda(&claim),
                objection: objection_pda(&claim),
                year_cap: year_cap_pda(&rule),
                beneficiary_account,
                payee_account,
            },
            heirloom::instruction::ExecuteClaim {},
        )
    }

    fn execute_scheduled_ix(&self, rule: Pubkey, beneficiary_account: Pubkey, payee_account: Pubkey) -> Instruction {
        let r: Rule = fetch(&self.svm, &rule);
        ix(
            heirloom::accounts::ExecuteScheduled {
                payer: self.stranger.pubkey(),
                estate: self.estate,
                rule,
                payee_wallet: r.fixed_payee,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                payee_usdt: ata(&r.fixed_payee, &self.usdt_mint),
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                year_cap: year_cap_pda(&rule),
                beneficiary_account,
                payee_account,
            },
            heirloom::instruction::ExecuteScheduled {},
        )
    }
}

#[test]
fn r01_an_objection_to_an_earlier_claim_does_not_use_up_the_next_ones() {
    let (mut env, people) = guardian_env();
    let estate = env.estate;
    env.submit_death_claim(1).unwrap();
    env.object(&people, TargetKind::Unlock, estate, 0, None, None).unwrap();
    let owner = env.kp(&env.owner);
    env.vote_objection(&owner, estate, false, None, None, None).unwrap();
    expect_err(env.object(&people, TargetKind::Unlock, estate, 1, None, None), HeirloomError::BadStatus);

    warp(&mut env.svm, 2 * WAITING);
    env.submit_death_claim(2).unwrap();
    env.object(&people, TargetKind::Unlock, estate, 1, None, None).unwrap();
}

#[test]
fn r01_a_fallback_objection_from_before_a_check_in_is_void() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let (guard, k2, m0) = (guard_pda(&env.estate), env.kid2.insecure_clone(), env.kp(&people.monitors[0]));
    env.raise_objection(&k2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();
    warp(&mut env.svm, 1);
    env.heartbeat().unwrap();
    let seats = env.all_seats();
    expect_err(env.vote_objection(&m0, guard, true, seats, None, None), HeirloomError::ObjectionLapsed);
    env.lapse_objection(guard).unwrap();
    assert_eq!(env.guard().open_objections, 0);
    // Nor can anyone object to a countdown that no longer runs.
    expect_err(
        env.raise_objection(&k2, TargetKind::Fallback, guard, 255, None, true, None, None),
        HeirloomError::FallbackNotReady,
    );
}

#[test]
fn r03_an_old_claim_made_after_the_unlock_keeps_its_approvals() {
    let (mut env, rule) = claims_env();
    env.unlock();
    warp(&mut env.svm, 5);
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    // As stored before approvals had stamps.
    let mut c: Claim = fetch(&env.svm, &claim);
    c.approvals = 0b001;
    env.plant(claim, &c);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn r04_reports_need_a_real_living_recipient_and_a_certificate() {
    let (mut env, _people) = fallback_env();
    let v0 = env.v(0);
    expect_err(env.report_fallback_death_by(&v0, 4, None, [7u8; 32]), HeirloomError::InvalidAmount);
    expect_err(env.report_fallback_death_by(&v0, 3, None, [7u8; 32]), HeirloomError::NoFallbackRecipient);
    expect_err(env.report_fallback_death_by(&v0, 0, None, [0u8; 32]), HeirloomError::NoDeathClaim);
    env.report_fallback_death_by(&v0, 0, None, [7u8; 32]).unwrap();
    env.review_fallback_death(0, true).unwrap();
    expect_err(env.review_fallback_death(0, true), HeirloomError::BadStatus);
}

#[test]
fn r04_a_confirmation_stops_once_the_list_or_the_plan_changed() {
    let (mut env, _people) = fallback_env();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    let (v0, k1) = (env.v(0), env.kid1.insecure_clone());
    let address = guard_pda(&env.estate);

    let mut g = env.guard();
    g.fallback_dead = 0b1;
    env.plant(address, &g);
    expect_err(env.resolve_fallback_death(&v0, 0, None, true), HeirloomError::BadStatus);

    let mut g = env.guard();
    g.fallback_dead = 0;
    g.fallback[0] = env.executor.pubkey();
    env.plant(address, &g);
    expect_err(env.resolve_fallback_death(&v0, 0, None, true), HeirloomError::NoFallbackRecipient);

    let mut g = env.guard();
    g.fallback[0] = k1.pubkey();
    g.fallback_done = true;
    env.plant(address, &g);
    expect_err(env.resolve_fallback_death(&v0, 0, None, true), HeirloomError::FallbackDone);
    // The recipient can still close it, which returns the rent.
    env.resolve_fallback_death(&k1, 0, None, false).unwrap();
}

#[test]
fn r04_membership_of_another_estate_is_no_membership() {
    let (mut env, _people) = fallback_env();
    let stranger = env.stranger.insecure_clone();
    let foreign_member = env.plant_elsewhere(&Beneficiary {
        estate: Pubkey::new_unique(),
        wallet: stranger.pubkey(),
        label: "Elsewhere".to_string(),
        active: true,
        bump: 1,
    });
    let mut seat = env.seat(0);
    seat.estate = Pubkey::new_unique();
    seat.monitors[0] = stranger.pubkey();
    let foreign_seat = env.plant_elsewhere(&seat);
    let i = ix(
        heirloom::accounts::ReportFallbackDeath {
            reporter: stranger.pubkey(),
            estate: env.estate,
            guard: guard_pda(&env.estate),
            fallback_report: fallback_report_pda(&env.estate, 0),
            signer_seat: Some(foreign_seat),
            beneficiary_account: Some(foreign_member),
            system_program: system_program(),
        },
        heirloom::instruction::ReportFallbackDeath { index: 0, cert_hash: [7u8; 32] },
    );
    expect_err(send(&mut env.svm, i, &[&stranger]), HeirloomError::NotParticipant);
    let i = ix(
        heirloom::accounts::ReportSeatDeath {
            reporter: stranger.pubkey(),
            estate: env.estate,
            seat: seat_pda(&env.estate, 0),
            beneficiary_account: Some(foreign_member),
            objection: objection_pda(&seat_pda(&env.estate, 0)),
        },
        heirloom::instruction::ReportSeatDeath { index: 0, cert_hash: [8u8; 32] },
    );
    expect_err(send(&mut env.svm, i, &[&stranger]), HeirloomError::NotParticipant);
}

#[test]
fn r07_a_referred_death_that_people_confirmed_keeps_the_normal_wait() {
    let (mut env, people) = guardian_env();
    let k1 = env.kid1.pubkey();
    env.set_fallback([k1, d(), d(), d()]).unwrap();
    env.submit_death_claim(1).unwrap();
    env.refer_death().unwrap();
    env.attest_death(0).unwrap();
    env.attest_death(1).unwrap();
    warp(&mut env.svm, WAITING);
    env.finalize_unlock().unwrap();
    env.vacate_all_after_unlock(&people);
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    env.execute_fallback(k1).unwrap();
}

#[test]
fn r07_the_fallback_records_when_the_death_took_effect() {
    let (mut env, people) = fallback_env();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    let k1 = env.kid1.pubkey();
    env.execute_fallback(k1).unwrap();
    assert_eq!(env.estate_state().death_pending_since, now(&env.svm));
}

#[test]
fn r08_zero_eligible_never_pays_a_claim() {
    let (mut env, _people) = guardian_env();
    let (v2, uni, until) = (env.v(2), env.university.pubkey(), now(&env.svm) + 365 * DAY);
    env.add_beneficiary(v2.pubkey(), "Trusted child");
    let rule = env.add_rule(0, v2.pubkey(), PayeeKind::University, 600 * USDT, 1_000 * USDT, until);
    env.leave_one_survivor();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(2).unwrap();
    warp(&mut env.svm, WAITING);
    env.finalize_unlock().unwrap();
    let claim = env.submit_claim_by(&v2, rule, uni, 100 * USDT).unwrap();
    env.refer_claim(claim).unwrap();
    expect_err(env.approve_claim(claim, 2), HeirloomError::OwnApproval);
    let t = now(&env.svm);
    env.plant_approvals(claim, 0b111, 2, t);
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
}

#[test]
fn r11_a_claimant_cannot_spend_or_dismiss_the_hardship_objection() {
    let mut s = Sale::build(true);
    let people = s.people.take().unwrap();
    let h = s.submit_hardship().unwrap();
    s.review_hardship(h, true).unwrap();
    s.approve_hardship(h, 0).unwrap();
    let (asset, k2) = (s.asset, s.env.kid2.insecure_clone());
    s.env.set_seat_monitors_by_planting(0, k2.pubkey());
    let seat = Some(seat_pda(&s.env.estate, 0));
    expect_err(
        s.env.raise_objection(&k2, TargetKind::Hardship, h, 0, seat, false, Some(h), Some(asset)),
        HeirloomError::OwnClaimDispute,
    );
    s.env.object(&people, TargetKind::Hardship, h, 0, Some(h), Some(asset)).unwrap();
    let mut e = s.env.estate_state();
    e.verifiers[1] = k2.pubkey();
    let estate = s.env.estate;
    s.env.plant(estate, &e);
    expect_err(s.env.vote_objection(&k2, h, false, None, Some(h), Some(asset)), HeirloomError::OwnApproval);
    let v2 = s.env.v(2);
    s.env.vote_objection(&v2, h, false, None, Some(h), Some(asset)).unwrap();
}

#[test]
fn r11_the_submitter_cannot_dismiss_a_challenge_to_the_unlock() {
    let mut env = Env::configured();
    let v0 = env.v(0);
    env.add_beneficiary(v0.pubkey(), "Trusted child");
    env.submit_death_claim_by(&v0).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(1).unwrap();
    env.attest_death(2).unwrap();
    let estate = env.estate;
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    expect_err(env.resolve_dispute(&v0, estate, false, false), HeirloomError::OwnApproval);
    env.resolve_dispute(&v0, estate, true, false).unwrap();
}

#[test]
fn r11_the_next_recipient_cannot_dismiss_the_fallback_objection() {
    let (mut env, people) = fallback_env();
    let k1 = env.kid1.insecure_clone();
    env.set_seat_monitors(0, [k1.pubkey(), d()]).unwrap();
    env.claim_again();
    vacate_all(&mut env, &people);
    env.start_fallback().unwrap();
    let (guard, k2) = (guard_pda(&env.estate), env.kid2.insecure_clone());
    env.raise_objection(&k2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();
    let seats = env.all_seats();
    expect_err(env.vote_objection(&k1, guard, false, seats, None, None), HeirloomError::OwnApproval);
}

#[test]
fn r15_the_title_goes_back_only_to_the_owners_own_account() {
    let mut env = Env::configured();
    let nft_mint = env.registered_title();
    let thief = env.stranger.pubkey();
    let elsewhere = fund_ata(&mut env.svm, &thief, &nft_mint, 0);
    let i = ix(
        heirloom::accounts::ReleaseAsset {
            owner: env.owner.pubkey(),
            estate: env.estate,
            asset: asset_pda(&env.estate, &nft_mint),
            nft_mint,
            nft_escrow: ata(&env.estate, &nft_mint),
            owner_nft: elsewhere,
            token_program: token_program(),
        },
        heirloom::instruction::ReleaseAsset {},
    );
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::NotOwner);
}

#[test]
fn r16_a_claim_cannot_borrow_another_members_accounts() {
    let mut env = Env::configured();
    let (rule, claim) = living_claim(&mut env);
    env.owner_approve_claim(rule, claim).unwrap();
    let (k1, k2, uni, landlord) = (env.kid1.pubkey(), env.kid2.pubkey(), env.university.pubkey(), env.landlord.pubkey());
    let (e, stranger) = (env.estate, env.stranger.insecure_clone());
    let i = env.execute_claim_ix(rule, claim, beneficiary_pda(&e, &k2), payee_pda(&e, &uni));
    expect_err(send(&mut env.svm, i, &[&stranger]), HeirloomError::NotBeneficiary);
    let i = env.execute_claim_ix(rule, claim, beneficiary_pda(&e, &k1), payee_pda(&e, &landlord));
    expect_err(send(&mut env.svm, i, &[&stranger]), HeirloomError::BadStatus);

    let mut b: Beneficiary = fetch(&env.svm, &beneficiary_pda(&e, &k1));
    b.estate = Pubkey::new_unique();
    let foreign = env.plant_elsewhere(&b);
    let i = env.execute_claim_ix(rule, claim, foreign, payee_pda(&e, &uni));
    expect_err(send(&mut env.svm, i, &[&stranger]), HeirloomError::NotBeneficiary);
    let mut p: Payee = fetch(&env.svm, &payee_pda(&e, &uni));
    p.estate = Pubkey::new_unique();
    let foreign = env.plant_elsewhere(&p);
    let i = env.execute_claim_ix(rule, claim, beneficiary_pda(&e, &k1), foreign);
    assert!(send(&mut env.svm, i, &[&stranger]).is_err());

    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn r16_a_schedule_cannot_borrow_another_members_accounts() {
    let mut env = Env::configured();
    let rule = scheduled_rule(&mut env);
    let (k1, k2, uni, landlord) = (env.kid1.pubkey(), env.kid2.pubkey(), env.university.pubkey(), env.landlord.pubkey());
    let (e, stranger) = (env.estate, env.stranger.insecure_clone());
    let i = env.execute_scheduled_ix(rule, beneficiary_pda(&e, &k2), payee_pda(&e, &uni));
    expect_err(send(&mut env.svm, i, &[&stranger]), HeirloomError::NotBeneficiary);
    let i = env.execute_scheduled_ix(rule, beneficiary_pda(&e, &k1), payee_pda(&e, &landlord));
    expect_err(send(&mut env.svm, i, &[&stranger]), HeirloomError::BadStatus);
    env.execute_scheduled(rule).unwrap();
}

#[test]
fn r16_a_schedule_stops_when_the_payee_returns_as_another_kind() {
    let mut env = Env::configured();
    let rule = scheduled_rule(&mut env);
    let uni = env.university.pubkey();
    env.remove_payee(uni).unwrap();
    let t = now(&env.svm);
    let i = env.add_rule_ix(1, env.kid1.pubkey(), PayeeKind::University, USDT, USDT, t + DAY, true, USDT, DAY, t, Some(uni));
    expect_missing_account(send(&mut env.svm, i, &[&env.owner]));
    env.add_payee(uni, PayeeKind::Landlord, "Residence");
    expect_err(env.execute_scheduled(rule), HeirloomError::WrongPayeeKind);
}

#[test]
fn r16_only_members_of_this_estate_can_be_removed() {
    let mut env = Env::configured();
    let mut b: Beneficiary = fetch(&env.svm, &beneficiary_pda(&env.estate, &env.kid1.pubkey()));
    b.estate = Pubkey::new_unique();
    let foreign = env.plant_elsewhere(&b);
    let i = ix(
        heirloom::accounts::RemoveMember {
            owner: env.owner.pubkey(),
            estate: env.estate,
            beneficiary_account: Some(foreign),
            payee_account: None,
            seat0: seat_pda(&env.estate, 0),
            seat1: seat_pda(&env.estate, 1),
            seat2: seat_pda(&env.estate, 2),
        },
        heirloom::instruction::RemoveMember {},
    );
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::NotBeneficiary);
}

#[test]
fn r02_a_replaced_persons_seat_death_confirmation_does_not_count() {
    let (mut env, _people) = guardian_env();
    let (v1, kid) = (env.v(1), env.kid1.insecure_clone());
    env.report_seat_death(&kid, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    warp(&mut env.svm, 1);
    let newbie = funded(&mut env.svm);
    env.replace_seat(1, newbie.pubkey()).unwrap();
    let s = env.seat(0);
    assert_eq!((s.holder, s.death_cert_hash, s.generation), (env.verifiers[0].pubkey(), [0u8; 32], 0));
    warp(&mut env.svm, SUCCESSION_WAIT);
    expect_err(env.finalize_succession(0), HeirloomError::NoSuccessionPending);

    env.report_seat_death(&kid, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&newbie, 0).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(0).unwrap();
    assert_eq!(env.seat(0).generation, 1);
}

#[test]
fn r02_a_confirmer_who_died_keeps_their_confirmation() {
    let (mut env, people) = guardian_env();
    let (v1, v2, kid) = (env.v(1), env.v(2), env.kid1.insecure_clone());
    warp(&mut env.svm, 1); // after the owner last checked in
    env.report_seat_death(&kid, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    env.succeed(1, &v2);
    env.finalize_succession(0).unwrap();
    assert_eq!(env.seat(0).holder, people.backups[0][0].pubkey());
}

#[test]
fn r02_replacing_the_agent_clears_the_death_claim_it_reviewed() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    warp(&mut env.svm, 1);
    let owner = env.owner.insecure_clone();
    env.set_agent(&owner, Keypair::new().pubkey()).unwrap();
    let e = env.estate_state();
    assert_eq!((e.death_cert_hash, e.death_verdict, e.last_heartbeat), ([0u8; 32], Verdict::Pending, now(&env.svm)));
}

#[test]
fn set_will_works_only_while_active() {
    let mut env = Env::configured();
    let will = |env: &Env| {
        ix(
            heirloom::accounts::SetWill { owner: env.owner.pubkey(), estate: env.estate },
            heirloom::instruction::SetWill { will_hash: [4u8; 32], will_uri: "ipfs://will".to_string() },
        )
    };
    let i = will(&env);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    assert_eq!(env.estate_state().will_hash, [4u8; 32]);
    env.unlock();
    let i = will(&env);
    expect_err(send(&mut env.svm, i, &[&env.owner]), HeirloomError::BadStatus);
}

#[test]
fn r02_watching_the_seat_does_not_save_a_replaced_confirmers_confirmation() {
    let (mut env, _people) = guardian_env();
    let (v1, kid) = (env.v(1), env.kid1.insecure_clone());
    env.set_seat_monitors(0, [v1.pubkey(), d()]).unwrap();
    env.report_seat_death(&kid, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    warp(&mut env.svm, 1);
    env.replace_seat(1, Keypair::new().pubkey()).unwrap();
    assert_eq!((env.seat(0).death_cert_hash, env.seat(0).generation), ([0u8; 32], 0));
}

#[test]
fn r14_proceeds_can_still_go_into_the_vault() {
    let mut s = Sale::new();
    let mut a: Asset = fetch(&s.env.svm, &s.asset);
    // Every client's default: register accepts it, and the sale pays the vault.
    let mut env = Env::configured();
    let title = create_title(&mut env.svm);
    let owner = env.owner.pubkey();
    fund_ata(&mut env.svm, &owner, &title, 1);
    let i = env.register_asset_ix(title, env.estate);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    assert_eq!(fetch::<Asset>(&env.svm, &asset_pda(&env.estate, &title)).proceeds_to, env.estate);

    a.proceeds_to = s.env.estate;
    let asset = s.asset;
    s.env.plant(asset, &a);
    let before = balance(&s.env.svm, &s.env.vault());
    s.place_offer(1, FLOOR).unwrap();
    s.accept_offer(1).unwrap();
    assert_eq!(balance(&s.env.svm, &s.env.vault()), before + FLOOR);
}

// =================================================================== open items of the second review (plan 18.8)

impl Env {
    /// Seats 0 and 1 vacant; seat 2 keeps one backup and has no monitor: only a beneficiary could confirm its death.
    fn last_holder_nobody_watches(&mut self, people: &People) {
        let owner = self.kp(&self.owner);
        self.set_seat_backups(&owner, 2, [people.backups[2][0].pubkey(), d()]).unwrap();
        self.set_seat_monitors(2, [d(), d()]).unwrap();
        self.leave_one_survivor();
    }
}

impl Sale {
    /// Another beneficiary's hardship, approved by the agent and still waiting for people.
    fn second_hardship(&mut self) -> Pubkey {
        let kid = self.env.kid1.pubkey();
        let hardship = hardship_pda(&self.asset, &kid);
        let i = ix(
            heirloom::accounts::SubmitHardship {
                beneficiary: kid,
                estate: self.env.estate,
                beneficiary_account: beneficiary_pda(&self.env.estate, &kid),
                asset: self.asset,
                hardship,
                system_program: system_program(),
            },
            heirloom::instruction::SubmitHardship { evidence_hash: [4u8; 32] },
        );
        send(&mut self.env.svm, i, &[&self.env.kid1]).unwrap();
        self.review_hardship(hardship, true).unwrap();
        hardship
    }

    fn set_media_by(&mut self, who: &Keypair) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SetAssetMedia {
                authority: who.pubkey(),
                estate: self.env.estate,
                asset: self.asset,
                media: media_pda(&self.asset),
                system_program: system_program(),
            },
            heirloom::instruction::SetAssetMedia { kind: AssetKind::Car, photos_root: [9u8; 32], photo_count: 1 },
        );
        send(&mut self.env.svm, i, &[who])
    }
}

// ------------------------------------------------------------------- R18 a last holder nobody watches

#[test]
fn r18_a_beneficiary_confirms_the_last_holder_nobody_watches() {
    let (mut env, people) = guardian_env();
    env.last_holder_nobody_watches(&people);
    let (k1, k2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone());
    env.report_seat_death(&k1, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&k2, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(2).unwrap();
    assert_eq!(env.seat(2).holder, people.backups[2][0].pubkey());
}

// ------------------------------------------------------------------- R20 a sweep and a reported death

#[test]
fn r20_an_approved_death_report_holds_the_sweep() {
    let (mut env, _people) = guardian_env();
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    env.set_fallback([k1, k2, d(), d()]).unwrap();
    env.unlock();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    expect_err(env.sweep(k1, &[]), HeirloomError::DeathReportOpen);
    warp(&mut env.svm, FALLBACK_WAIT);
    expect_err(env.sweep(k1, &[]), HeirloomError::DeathReportOpen);

    let v0 = env.v(0);
    env.resolve_fallback_death(&v0, 0, None, true).unwrap();
    env.sweep(k2, &[]).unwrap();
    assert_eq!(balance(&env.svm, &ata(&k2, &env.usdt_mint)), 5_000 * USDT);
}

// ------------------------------------------------------------------- R21 one approved hardship

#[test]
fn r21_a_second_hardship_cannot_replace_the_first_recipient() {
    let mut s = Sale::new();
    s.approved_hardship();
    let second = s.second_hardship();
    expect_err(s.approve_hardship(second, 0), HeirloomError::BadStatus);
    let a: Asset = fetch(&s.env.svm, &s.asset);
    assert_eq!(a.hardship_beneficiary, Some(s.env.kid2.pubkey()));
    assert_eq!(fetch::<Hardship>(&s.env.svm, &second).approvals, 0);
}

// ------------------------------------------------------------------- R22 only the living owner sets what buyers see

#[test]
fn r22_the_agent_cannot_change_what_buyers_see() {
    let mut s = Sale::new();
    let agent = s.env.agent.insecure_clone();
    expect_err(s.set_media_by(&agent), HeirloomError::NotOwner);
}

// ------------------------------------------------------------------- R18 refusals and the revocation rule

/// Seat 2 is the only one held and nobody watches it; kid1 reported its death and the agent approved.
fn unwatched_report() -> (Env, People) {
    let (mut env, people) = guardian_env();
    env.last_holder_nobody_watches(&people);
    let k1 = env.kid1.insecure_clone();
    env.report_seat_death(&k1, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    (env, people)
}

#[test]
fn r18_never_the_reporter_the_holder_the_first_backup_the_agent_or_an_outsider() {
    let (mut env, people) = unwatched_report();
    let (k1, v2, agent, stranger) = (env.kid1.insecure_clone(), env.v(2), env.agent.insecure_clone(), env.stranger.insecure_clone());
    let first = env.kp(&people.backups[2][0]);
    // Even as active beneficiaries.
    env.add_beneficiary(v2.pubkey(), "Trusted child");
    env.add_beneficiary(first.pubkey(), "Backup child");
    env.add_beneficiary(agent.pubkey(), "Agent");
    for who in [&k1, &v2, &first, &agent, &stranger] {
        expect_err(env.confirm_seat_death(who, 2), HeirloomError::NotConfirmer);
    }
    let k2 = env.kid2.insecure_clone();
    env.confirm_seat_death(&k2, 2).unwrap();
}

#[test]
fn r18_only_with_an_active_beneficiary_account_of_this_estate_and_wallet() {
    let (mut env, _people) = unwatched_report();
    let (k2, stranger) = (env.kid2.insecure_clone(), env.stranger.insecure_clone());
    expect_err(env.confirm_seat_death_with(&k2, 2, None), HeirloomError::NotConfirmer);
    let mine = beneficiary_pda(&env.estate, &k2.pubkey());
    expect_err(env.confirm_seat_death_with(&stranger, 2, Some(mine)), HeirloomError::NotConfirmer);

    let mut b: Beneficiary = fetch(&env.svm, &mine);
    b.estate = Pubkey::new_unique();
    let foreign = env.plant_elsewhere(&b);
    expect_err(env.confirm_seat_death_with(&k2, 2, Some(foreign)), HeirloomError::NotConfirmer);

    env.remove_beneficiary(k2.pubkey()).unwrap();
    expect_err(env.confirm_seat_death_with(&k2, 2, Some(mine)), HeirloomError::NotConfirmer);
}

#[test]
fn r18_the_route_is_closed_by_a_monitor_a_second_backup_or_another_holder() {
    let k2_is_refused = |env: &mut Env| {
        let (k1, k2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone());
        env.report_seat_death(&k1, 2).unwrap();
        env.review_seat_death(2, true).unwrap();
        expect_err(env.confirm_seat_death(&k2, 2), HeirloomError::NotConfirmer);
    };

    let (mut env, people) = guardian_env();
    let owner = env.kp(&env.owner);
    env.set_seat_backups(&owner, 2, [people.backups[2][0].pubkey(), d()]).unwrap();
    env.leave_one_survivor(); // the monitor stays
    k2_is_refused(&mut env);

    let (mut env, _people) = guardian_env();
    env.set_seat_monitors(2, [d(), d()]).unwrap();
    env.leave_one_survivor(); // the second backup stays
    k2_is_refused(&mut env);

    let (mut env, people) = guardian_env();
    let owner = env.kp(&env.owner);
    env.set_seat_backups(&owner, 2, [people.backups[2][0].pubkey(), d()]).unwrap();
    env.set_seat_monitors(2, [d(), d()]).unwrap(); // the other seats are held
    k2_is_refused(&mut env);
}

#[test]
fn r18_with_no_backup_at_all_the_seat_vacates_and_the_fallback_can_start() {
    let (mut env, _people) = guardian_env();
    let (k1, k2, owner) = (env.kid1.insecure_clone(), env.kid2.insecure_clone(), env.kp(&env.owner));
    env.set_fallback([k1.pubkey(), d(), d(), d()]).unwrap();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.set_seat_backups(&owner, 2, [d(), d()]).unwrap();
    env.set_seat_monitors(2, [d(), d()]).unwrap();
    env.claim_again();
    env.leave_one_survivor();
    env.report_seat_death(&k1, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&k2, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(2).unwrap();
    assert!(env.seat(2).vacant);
    env.start_fallback().unwrap();
}

#[test]
fn r18_a_check_in_does_not_revoke_the_confirmation_while_the_route_applies() {
    let (mut env, people) = unwatched_report();
    let k2 = env.kid2.insecure_clone();
    env.confirm_seat_death(&k2, 2).unwrap();
    warp(&mut env.svm, 1);
    env.heartbeat().unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    assert_eq!(env.seat(2).death_confirmed_by, k2.pubkey());
    // No account is needed and none can revoke it; one passed is ignored.
    let other = beneficiary_pda(&env.estate, &env.kid1.pubkey());
    env.finalize_succession_with(2, Some(other)).unwrap();
    assert_eq!(env.seat(2).holder, people.backups[2][0].pubkey());
}

#[test]
fn r18_removing_the_confirmer_revokes_the_confirmation() {
    let (mut env, _people) = unwatched_report();
    let k2 = env.kid2.insecure_clone();
    env.confirm_seat_death(&k2, 2).unwrap();
    warp(&mut env.svm, 1);
    env.remove_beneficiary(k2.pubkey()).unwrap();
    let s = env.seat(2);
    assert_eq!((s.holder, s.death_cert_hash, s.generation), (env.verifiers[2].pubkey(), [0u8; 32], 0));
}

#[test]
fn r18_refilling_another_seat_revokes_the_confirmation() {
    let (mut env, _people) = unwatched_report();
    let k2 = env.kid2.insecure_clone();
    env.confirm_seat_death(&k2, 2).unwrap();
    warp(&mut env.svm, 1);
    env.replace_seat(0, Keypair::new().pubkey()).unwrap();
    let s = env.seat(2);
    assert_eq!((s.holder, s.death_cert_hash), (env.verifiers[2].pubkey(), [0u8; 32]));
}

#[test]
fn r18_giving_the_seat_a_monitor_revokes_the_confirmation() {
    let (mut env, people) = unwatched_report();
    let k2 = env.kid2.insecure_clone();
    env.confirm_seat_death(&k2, 2).unwrap();
    env.set_seat_monitors(2, [people.monitors[0].pubkey(), d()]).unwrap();
    let s = env.seat(2);
    assert_eq!((s.death_cert_hash, s.death_confirmed_by, s.monitors[0]), ([0u8; 32], d(), people.monitors[0].pubkey()));
}

#[test]
fn r18_new_monitors_leave_other_confirmations_alone() {
    let (mut env, people) = guardian_env();
    let (k1, v1) = (env.kid1.insecure_clone(), env.v(1));
    env.set_seat_monitors(2, [d(), d()]).unwrap();
    env.report_seat_death(&k1, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&v1, 2).unwrap();
    env.set_seat_monitors(2, [people.monitors[0].pubkey(), d()]).unwrap();
    assert_eq!(env.seat(2).death_confirmed_by, v1.pubkey());
}

#[test]
fn r18_the_route_cannot_revive_a_replaced_persons_confirmation() {
    let (mut env, _people) = guardian_env();
    let (owner, k1, v0, v1) = (env.kp(&env.owner), env.kid1.insecure_clone(), env.v(0), env.v(1));
    let backup = funded(&mut env.svm).pubkey();
    env.set_seat_backups(&owner, 0, [backup, d()]).unwrap();
    env.set_seat_monitors(0, [d(), d()]).unwrap();
    for i in 1..3 {
        env.set_seat_backups(&owner, i, [d(), d()]).unwrap();
    }
    warp(&mut env.svm, 1);
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    warp(&mut env.svm, 1);
    env.replace_seat(1, Keypair::new().pubkey()).unwrap();
    // Cleared at once, so it can't count later when the other seats empty and seat 0 is one a beneficiary
    // could confirm.
    let s = env.seat(0);
    assert_eq!((s.holder, s.death_cert_hash), (v0.pubkey(), [0u8; 32]));
    env.succeed(1, &v0);
    env.succeed(2, &v0);
    expect_err(env.finalize_succession_with(0, None), HeirloomError::NoSuccessionPending);
}

// ------------------------------------------------------------------- R19 the agreed amount

#[test]
fn r19_a_lower_offer_cannot_be_swapped_in_under_a_co_signature() {
    let mut s = Sale::new();
    let agreed = FLOOR + 1_000 * USDT;
    s.place_offer(1, agreed).unwrap();
    s.withdraw_offer(1).unwrap();
    s.place_offer(1, FLOOR).unwrap();
    let v1 = s.env.v(1);
    expect_err(s.accept_offer_expecting(1, Some(&v1), agreed), HeirloomError::OfferChanged);
    assert_eq!(fetch::<Asset>(&s.env.svm, &s.asset).status, AssetStatus::Listed);
}

#[test]
fn r19_only_the_exact_amount_is_accepted() {
    let mut s = Sale::new();
    s.place_offer(1, FLOOR + 1).unwrap();
    let v1 = s.env.v(1);
    expect_err(s.accept_offer_expecting(1, Some(&v1), FLOOR), HeirloomError::OfferChanged);
    expect_err(s.accept_offer_expecting(1, Some(&v1), FLOOR + 2), HeirloomError::OfferChanged);
    s.accept_offer_expecting(1, Some(&v1), FLOOR + 1).unwrap();
    assert_eq!(fetch::<Asset>(&s.env.svm, &s.asset).status, AssetStatus::Sold);
}

// ------------------------------------------------------------------- R20 the hold's limits

/// Unlocked, paying by the fallback list [kid1, kid2], with no rules: the whole vault is sweepable.
fn sweep_env() -> Env {
    let (mut env, _people) = guardian_env();
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    env.set_fallback([k1, k2, d(), d()]).unwrap();
    env.unlock();
    env
}

#[test]
fn r20_the_hold_ends_after_twice_the_refute_wait() {
    let mut env = sweep_env();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    let k1 = env.kid1.pubkey();
    warp(&mut env.svm, 2 * FALLBACK_WAIT - 1);
    expect_err(env.sweep(k1, &[]), HeirloomError::DeathReportOpen);
    warp(&mut env.svm, 1);
    env.sweep(k1, &[]).unwrap();
    assert_eq!(balance(&env.svm, &env.vault()), 0);
}

#[test]
fn r20_a_report_replacing_an_expired_one_holds_nothing_until_it_is_approved() {
    let mut env = sweep_env();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, 2 * FALLBACK_WAIT);
    let (v0, k1) = (env.v(0), env.kid1.pubkey());
    env.report_fallback_death_by(&v0, 0, None, [7u8; 32]).unwrap();
    env.sweep(k1, &[]).unwrap();
}

#[test]
fn r20_an_unreviewed_report_holds_nothing() {
    let mut env = sweep_env();
    env.report_fallback_death(0).unwrap();
    let k1 = env.kid1.pubkey();
    env.sweep(k1, &[]).unwrap();
}

#[test]
fn r20_refuting_frees_the_sweep_at_once() {
    let mut env = sweep_env();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    let k1 = env.kid1.insecure_clone();
    env.resolve_fallback_death(&k1, 0, None, false).unwrap();
    env.sweep(k1.pubkey(), &[]).unwrap();
}

#[test]
fn r20_a_named_residual_recipient_is_not_held() {
    let (mut env, _people) = guardian_env();
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    env.set_fallback([k1, k2, d(), d()]).unwrap();
    env.set_residual(k2).unwrap();
    env.unlock();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    env.sweep(k2, &[]).unwrap();
}

#[test]
fn r20_a_report_on_an_earlier_list_holds_nothing() {
    let (mut env, _people) = guardian_env();
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    env.set_fallback([k1, k2, d(), d()]).unwrap();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    env.set_fallback([k2, d(), d(), d()]).unwrap();
    env.unlock();
    env.sweep(k2, &[]).unwrap();
}

#[test]
fn r20_a_report_on_a_later_recipient_holds_nothing() {
    let mut env = sweep_env();
    let v0 = env.v(0);
    env.report_fallback_death_by(&v0, 1, None, [7u8; 32]).unwrap();
    env.review_fallback_death(1, true).unwrap();
    let k1 = env.kid1.pubkey();
    env.sweep(k1, &[]).unwrap();
}

#[test]
fn r20_the_report_account_cannot_be_substituted() {
    let mut env = sweep_env();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    let (k1, estate) = (env.kid1.pubkey(), env.estate);
    for other in [fallback_report_pda(&estate, 1), fallback_report_pda(&estate, 255)] {
        let e = env.sweep_with(k1, &[], other).expect_err("another report account must be refused");
        assert!(e.contains("Custom(2006)"), "expected ConstraintSeeds, got {e}");
    }
}

#[test]
fn r20_without_a_guard_the_index_is_255() {
    let mut env = Env::configured();
    let heir = env.kid2.pubkey();
    env.set_residual(heir).unwrap();
    env.unlock();
    let estate = env.estate;
    assert!(env.sweep_with(heir, &[], fallback_report_pda(&estate, 0)).is_err());
    env.sweep_with(heir, &[], fallback_report_pda(&estate, 255)).unwrap();
}

// ------------------------------------------------------------------- R21 refusal and release

#[test]
fn r21_a_second_hardship_waits_even_if_it_had_a_vote_first() {
    let mut s = Sale::new();
    let second = s.second_hardship();
    s.approve_hardship(second, 0).unwrap(); // nothing stands yet
    s.approved_hardship();
    expect_err(s.approve_hardship(second, 1), HeirloomError::BadStatus);
}

#[test]
fn r21_an_upheld_objection_frees_the_asset_for_another_hardship() {
    let mut s = Sale::build(true);
    let people = s.people.take().unwrap();
    s.approved_hardship();
    let second = s.second_hardship();
    let (asset, first) = (s.asset, hardship_pda(&s.asset, &s.env.kid2.pubkey()));
    s.env.object(&people, TargetKind::Hardship, first, 0, Some(first), Some(asset)).unwrap();
    expect_err(s.approve_hardship(second, 0), HeirloomError::BadStatus);
    let (v1, v2) = (s.env.v(1), s.env.v(2));
    s.env.vote_objection(&v1, first, true, None, Some(first), Some(asset)).unwrap();
    s.env.vote_objection(&v2, first, true, None, Some(first), Some(asset)).unwrap();

    s.approve_hardship(second, 0).unwrap();
    s.approve_hardship(second, 1).unwrap();
    let a: Asset = fetch(&s.env.svm, &asset);
    assert_eq!(a.hardship_beneficiary, Some(s.env.kid1.pubkey()));
}

// ------------------------------------------------------------------- R22 who may, and when

#[test]
fn r22_the_owner_sets_the_photos_only_while_active() {
    let mut env = Env::configured();
    let nft_mint = env.registered_title();
    let asset = asset_pda(&env.estate, &nft_mint);
    let set = |env: &mut Env, who: &Keypair| {
        let i = ix(
            heirloom::accounts::SetAssetMedia {
                authority: who.pubkey(),
                estate: env.estate,
                asset,
                media: media_pda(&asset),
                system_program: system_program(),
            },
            heirloom::instruction::SetAssetMedia { kind: AssetKind::Car, photos_root: [9u8; 32], photo_count: 2 },
        );
        send(&mut env.svm, i, &[who])
    };
    let (owner, agent) = (env.owner.insecure_clone(), env.agent.insecure_clone());
    expect_err(set(&mut env, &agent), HeirloomError::NotOwner);
    set(&mut env, &owner).unwrap();
    assert_eq!(fetch::<AssetMedia>(&env.svm, &media_pda(&asset)).photo_count, 2);
    env.death_pending();
    expect_err(set(&mut env, &owner), HeirloomError::NotOwner);
}

#[test]
fn r18_the_confirmers_account_is_ignored_when_it_is_not_needed() {
    let (mut env, people) = guardian_env();
    let (k1, v0) = (env.kid1.insecure_clone(), env.v(0));
    warp(&mut env.svm, 1);
    env.report_seat_death(&k1, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&v0, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    let not_needed = beneficiary_pda(&env.estate, &v0.pubkey());
    env.finalize_succession_with(2, Some(not_needed)).unwrap();
    assert_eq!(env.seat(2).holder, people.backups[2][0].pubkey());
}

// =================================================================== independent review (plan 18.10)
// Each `bug_` probe of the review became the test of its corrected behaviour below; `held_` probes are carried
// in as they were. RT (recovery timeout) = 4 waiting periods.

const LONG: i64 = 30 * DAY;
const RT: i64 = 4 * WAITING;

/// Several instructions in one transaction; `signers[0]` pays the fee.
fn send_all(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> Result<u64, String> {
    let payer = signers[0].pubkey();
    let mut unique: Vec<&Keypair> = Vec::new();
    for s in signers {
        if !unique.iter().any(|u| u.pubkey() == s.pubkey()) {
            unique.push(s);
        }
    }
    let msg = Message::new_with_blockhash(ixs, Some(&payer), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &unique).unwrap();
    let res = svm.send_transaction(tx);
    svm.expire_blockhash();
    res.map(|m| m.compute_units_consumed).map_err(|e| format!("{:?}", e.err))
}

fn err_code(e: HeirloomError) -> String {
    format!("Custom({})", 6000 + e as u32)
}

impl Env {
    fn guard_with(&mut self, window: i64, succession: i64, fallback: i64) {
        let i = ix(
            heirloom::accounts::InitGuard {
                authority: self.owner.pubkey(),
                estate: self.estate,
                guard: guard_pda(&self.estate),
                system_program: system_program(),
            },
            heirloom::instruction::InitGuard { objection_window_secs: window, succession_wait_secs: succession, fallback_wait_secs: fallback },
        );
        send(&mut self.svm, i, &[&self.owner]).unwrap();
    }

    fn check_in(&mut self) -> Result<(), String> {
        self.heartbeat()
    }

    /// Edits the stored Estate, to model what the deployed program left behind.
    fn edit_estate(&mut self, f: impl FnOnce(&mut Estate)) {
        let mut e = self.estate_state();
        f(&mut e);
        let address = self.estate;
        self.plant(address, &e);
    }

    fn death_claim_by(&mut self, who: &Keypair, cert_hash: [u8; 32]) -> Result<(), String> {
        let i = ix(
            heirloom::accounts::SubmitDeathClaim {
                beneficiary: who.pubkey(),
                estate: self.estate,
                beneficiary_account: self.member_account(&who.pubkey()),
                guard: None,
                objection: objection_pda(&self.estate),
            },
            heirloom::instruction::SubmitDeathClaim { cert_hash },
        );
        send(&mut self.svm, i, &[who])
    }

    fn succeed_by(&mut self, index: u8, reporter: &Keypair, confirmer: &Keypair) {
        self.report_seat_death(reporter, index).unwrap();
        self.review_seat_death(index, true).unwrap();
        self.confirm_seat_death(confirmer, index).unwrap();
        warp(&mut self.svm, SUCCESSION_WAIT);
        self.finalize_succession(index).unwrap();
    }

    /// execute_fallback paying into `account` (the recipient's ATA or another account they own).
    fn execute_fallback_into(&mut self, recipient: Pubkey, account: Pubkey) -> Result<(), String> {
        let e = self.estate;
        let guard = guard_pda(&e);
        let i = ix(
            heirloom::accounts::ExecuteFallback {
                payer: self.stranger.pubkey(),
                estate: e,
                guard,
                seat0: seat_pda(&e, 0),
                seat1: seat_pda(&e, 1),
                seat2: seat_pda(&e, 2),
                objection: objection_pda(&guard),
                fallback_report: fallback_report_pda(&e, fetch::<Guard>(&self.svm, &guard).next_fallback_index()),
                recipient,
                usdt_mint: self.usdt_mint,
                vault: self.vault(),
                recipient_usdt: account,
                token_program: token_program(),
                associated_token_program: ata_program(),
                system_program: system_program(),
                unlock_objection: objection_pda(&e),
            },
            heirloom::instruction::ExecuteFallback {},
        );
        let s = self.stranger.insecure_clone();
        send(&mut self.svm, i, &[&s])
    }

    fn resolve_dispute_by_owner(&mut self, target: Pubkey, uphold: bool, is_claim: bool) -> Result<(), String> {
        let owner = self.owner.insecure_clone();
        self.resolve_dispute(&owner, target, uphold, is_claim)
    }
}

/// Guarded estate whose seats have the given backups and monitors.
fn estate_with_seats(waiting: i64, fallback_wait: i64, backups: [[Pubkey; 2]; 3], monitors: [[Pubkey; 2]; 3]) -> Env {
    let mut env = Env::new();
    let i = env.create_estate_ix(env.verifier_keys(), 2, 1, 2, waiting);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let (k1, k2, uni) = (env.kid1.pubkey(), env.kid2.pubkey(), env.university.pubkey());
    env.add_beneficiary(k1, "Child 1");
    env.add_beneficiary(k2, "Child 2");
    env.add_payee(uni, PayeeKind::University, "University");
    let i = env.deposit_ix(ata(&env.owner.pubkey(), &env.usdt_mint), 5_000 * USDT);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    env.guard_with(WINDOW, SUCCESSION_WAIT, fallback_wait);
    for s in 0..3 {
        env.init_seat(s as u8, backups[s], monitors[s]).unwrap();
    }
    env
}

fn list_ix(s: &Sale, authority: Pubkey) -> Instruction {
    ix(
        heirloom::accounts::ListAsset { authority, estate: s.env.estate, asset: s.asset },
        heirloom::instruction::ListAsset { duration_secs: 3 * DAY },
    )
}

fn accept_ix(s: &Sale, co: Pubkey, hardship: Option<Pubkey>, amount: u64) -> Instruction {
    let buyer = s.env.buyer1.pubkey();
    let offer = offer_pda(&s.asset, &buyer);
    let recipient = hardship.unwrap_or(s.env.executor.pubkey());
    ix(
        heirloom::accounts::AcceptOffer {
            agent: s.env.agent.pubkey(),
            estate: s.env.estate,
            asset: s.asset,
            offer,
            buyer,
            recipient,
            usdt_mint: s.env.usdt_mint,
            offer_escrow: ata(&offer, &s.env.usdt_mint),
            recipient_usdt: ata(&recipient, &s.env.usdt_mint),
            nft_mint: s.nft_mint,
            nft_escrow: ata(&s.env.estate, &s.nft_mint),
            buyer_nft: ata(&buyer, &s.nft_mint),
            token_program: token_program(),
            associated_token_program: ata_program(),
            system_program: system_program(),
            objection: objection_pda(&s.asset),
            hardship_objection: hardship.map(|b| objection_pda(&hardship_pda(&s.asset, &b))).unwrap_or_else(system_program),
            co_signer: Some(co),
            guard: guard_pda(&s.env.estate),
            hardship_stamp: hardship.map(|b| stamp_pda(&hardship_pda(&s.asset, &b))).unwrap_or_else(system_program),
        },
        heirloom::instruction::AcceptOffer { expected_amount: amount },
    )
}

/// The spouse is trusted person 0 and the only beneficiary; seats 1 and 2 are vacant. The owner has died.
fn sole_trusted_spouse() -> (Env, Keypair) {
    let mut env = Env::new();
    let spouse = env.kid1.insecure_clone();
    let keys = [spouse.pubkey(), env.verifiers[1].pubkey(), env.verifiers[2].pubkey()];
    let i = env.create_estate_ix(keys, 2, 1, 2, WAITING);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    env.add_beneficiary(spouse.pubkey(), "Spouse");
    env.add_payee(env.university.pubkey(), PayeeKind::University, "University");
    let i = env.deposit_ix(ata(&env.owner.pubkey(), &env.usdt_mint), 5_000 * USDT);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    env.guard_with(WINDOW, SUCCESSION_WAIT, FALLBACK_WAIT);
    for s in 0..3 {
        env.init_seat(s, [d(); 2], [d(); 2]).unwrap();
    }
    env.set_fallback([spouse.pubkey(), d(), d(), d()]).unwrap();
    let owner = env.owner.insecure_clone();
    env.succeed_by(1, &owner, &spouse);
    env.succeed_by(2, &owner, &spouse);
    warp(&mut env.svm, 1);
    (env, spouse)
}

// ------------------------------------------------------------------- H1 a duplicated account

#[test]
fn h1_an_upheld_sale_objection_cannot_be_undone_by_passing_the_asset_twice() {
    let mut s = Sale::build(true);
    s.place_offer(1, FLOOR).unwrap();
    let m = s.people.as_ref().unwrap().monitors[0].insecure_clone();
    let (asset, seat) = (s.asset, seat_pda(&s.env.estate, 0));
    s.env.raise_objection(&m, TargetKind::Sale, asset, 0, Some(seat), false, Some(asset), None).unwrap();
    let (v1, v2) = (s.env.v(1), s.env.v(2));
    s.env.vote_objection(&v1, asset, true, None, Some(asset), None).unwrap();
    expect_err(s.env.vote_objection(&v2, asset, true, None, Some(asset), Some(asset)), HeirloomError::BadStatus);
    s.env.vote_objection(&v2, asset, true, None, Some(asset), None).unwrap();
    assert_eq!(fetch::<Asset>(&s.env.svm, &asset).status, AssetStatus::Held);
    warp(&mut s.env.svm, WINDOW);
    expect_err(s.accept_offer_with(1, Some(&v2)), HeirloomError::BadStatus);
}

#[test]
fn held_control_upheld_sale_objection_cancels_when_not_duplicated() {
    let mut s = Sale::build(true);
    s.place_offer(1, FLOOR).unwrap();
    let m = s.people.as_ref().unwrap().monitors[0].insecure_clone();
    let (asset, seat) = (s.asset, seat_pda(&s.env.estate, 0));
    s.env.raise_objection(&m, TargetKind::Sale, asset, 0, Some(seat), false, Some(asset), None).unwrap();
    for v in [s.env.v(1), s.env.v(2)] {
        s.env.vote_objection(&v, asset, true, None, Some(asset), None).unwrap();
    }
    assert_eq!(fetch::<Asset>(&s.env.svm, &asset).status, AssetStatus::Held);
    expect_err(s.accept_offer(1), HeirloomError::BadStatus);
}

#[test]
fn h1_the_asset_slot_is_refused_for_every_kind_but_hardship() {
    let (mut env, people, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    env.object(&people, TargetKind::Claim, claim, 0, Some(claim), None).unwrap();
    let v1 = env.v(1);
    // A claim is no Asset (the typed slot refuses it); passing any real Asset there is refused by the program.
    assert!(env.vote_objection(&v1, claim, true, None, Some(claim), Some(claim)).is_err());
    env.vote_objection(&v1, claim, true, None, Some(claim), None).unwrap();
}

// ------------------------------------------------------------------- H2 a backup who already holds a seat

#[test]
fn h2_a_shared_backup_who_took_a_seat_confirms_the_next_death() {
    let shared = Keypair::new();
    let s = shared.pubkey();
    let watcher = Keypair::new();
    let mut env = estate_with_seats(WAITING, FALLBACK_WAIT, [[s, d()]; 3], [[watcher.pubkey(), d()]; 3]);
    env.svm.airdrop(&s, 10_000_000_000).unwrap();
    env.svm.airdrop(&watcher.pubkey(), 10_000_000_000).unwrap();
    let heir = env.kid1.pubkey();
    env.set_fallback([heir, d(), d(), d()]).unwrap();
    let (k1, v0, v2) = (env.kid1.insecure_clone(), env.v(0), env.v(2));
    env.succeed_by(1, &k1, &v2);
    assert_eq!(env.seat(1).holder, s);
    env.succeed_by(2, &k1, &v0);
    assert!(env.seat(2).vacant);
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&shared, 0).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(0).unwrap();
    assert!(env.seat(0).vacant, "the shared backup holds another seat, so this one has nobody to promote");

    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.attest_death_by(&shared).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);
    warp(&mut env.svm, WAITING);
    env.finalize_unlock().unwrap();
}

#[test]
fn h2_a_first_backup_who_holds_no_seat_still_cannot_confirm_their_own_promotion() {
    let (mut env, people) = guardian_env();
    let (k1, b0) = (env.kid1.insecure_clone(), env.kp(&people.backups[0][0]));
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    warp(&mut env.svm, 10 * RT);
    expect_err(env.confirm_seat_death(&b0, 0), HeirloomError::NotConfirmer);
}

// ------------------------------------------------------------------- H3 the recovery route

#[test]
fn h3_when_every_holder_dies_at_once_watchers_confirm_after_the_recovery_timeout() {
    let (mut env, p) = guardian_env();
    let heir = env.kid1.pubkey();
    env.set_fallback([heir, d(), d(), d()]).unwrap();
    let (k1, k2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone());
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    for i in 0..3u8 {
        env.report_seat_death(&k1, i).unwrap();
        env.review_seat_death(i, true).unwrap();
    }
    warp(&mut env.svm, RT - 1);
    for i in 0..3usize {
        expect_err(env.confirm_seat_death(&p.monitors[i], i as u8), HeirloomError::NotConfirmer);
        expect_err(env.confirm_seat_death(&k2, i as u8), HeirloomError::NotConfirmer);
    }
    warp(&mut env.svm, 1);
    for i in 0..3usize {
        // The first backup still never confirms their own promotion.
        expect_err(env.confirm_seat_death(&p.backups[i][0], i as u8), HeirloomError::NotConfirmer);
    }
    env.confirm_seat_death(&p.monitors[0], 0).unwrap();
    env.confirm_seat_death(&p.backups[1][1], 1).unwrap();
    env.confirm_seat_death(&k2, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    for i in 0..3u8 {
        env.finalize_succession(i).unwrap();
        assert_eq!(env.seat(i).holder, p.backups[i as usize][0].pubkey());
    }
}

#[test]
fn h3_with_no_backups_the_seats_vacate_and_the_fallback_opens() {
    let (mut env, p) = guardian_env();
    let owner = env.kp(&env.owner);
    for i in 0..3 {
        env.set_seat_backups(&owner, i, [d(), d()]).unwrap();
    }
    let heir = env.kid1.pubkey();
    env.set_fallback([heir, d(), d(), d()]).unwrap();
    warp(&mut env.svm, 1);
    let k1 = env.kid1.insecure_clone();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    for i in 0..3u8 {
        env.report_seat_death(&k1, i).unwrap();
        env.review_seat_death(i, true).unwrap();
    }
    warp(&mut env.svm, RT);
    for i in 0..3usize {
        env.confirm_seat_death(&p.monitors[i], i as u8).unwrap();
    }
    warp(&mut env.svm, SUCCESSION_WAIT);
    for i in 0..3u8 {
        env.finalize_succession(i).unwrap();
    }
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    env.execute_fallback(heir).unwrap();
}

#[test]
fn h3_a_monitor_who_is_the_first_backup_does_not_close_the_beneficiaries_route() {
    let both = Keypair::new();
    let b = both.pubkey();
    let mut env = estate_with_seats(WAITING, FALLBACK_WAIT, [[d(); 2], [d(); 2], [b, d()]], [[d(); 2], [d(); 2], [b, d()]]);
    env.svm.airdrop(&b, 10_000_000_000).unwrap();
    let (k1, k2, v1, v2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone(), env.v(1), env.v(2));
    env.succeed_by(0, &k1, &v1);
    env.succeed_by(1, &k1, &v2);
    env.report_seat_death(&k1, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    expect_err(env.confirm_seat_death(&both, 2), HeirloomError::NotConfirmer);
    env.confirm_seat_death(&k2, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(2).unwrap();
    assert_eq!(env.seat(2).holder, b);
}

#[test]
fn h3_a_last_seat_with_a_dead_monitor_opens_to_beneficiaries_after_the_timeout() {
    let dead_monitor = Keypair::new().pubkey();
    let mut env = estate_with_seats(WAITING, FALLBACK_WAIT, [[d(); 2]; 3], [[d(); 2], [d(); 2], [dead_monitor, d()]]);
    let heir = env.kid1.pubkey();
    env.set_fallback([heir, d(), d(), d()]).unwrap();
    let (k1, k2, v1, v2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone(), env.v(1), env.v(2));
    env.succeed_by(0, &k1, &v1);
    env.succeed_by(1, &k1, &v2);
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.report_seat_death(&k1, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    expect_err(env.confirm_seat_death(&k2, 2), HeirloomError::NotConfirmer);
    warp(&mut env.svm, RT);
    env.confirm_seat_death(&k2, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(2).unwrap();
    env.start_fallback().unwrap();
}

#[test]
fn h3_one_beneficiary_and_one_backup_reach_a_succession_after_the_timeout() {
    let backup = Keypair::new();
    let b = backup.pubkey();
    let mut env = estate_with_seats(WAITING, FALLBACK_WAIT, [[d(); 2], [d(); 2], [b, d()]], [[d(); 2]; 3]);
    env.svm.airdrop(&b, 10_000_000_000).unwrap();
    let (k1, k2, v1, v2) = (env.kid1.insecure_clone(), env.kid2.pubkey(), env.v(1), env.v(2));
    env.succeed_by(0, &k1, &v1);
    env.succeed_by(1, &k1, &v2);
    env.remove_beneficiary(k2).unwrap(); // one child
    warp(&mut env.svm, 1);
    env.report_seat_death(&backup, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&k1, 2).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    expect_err(env.finalize_succession(2), HeirloomError::WaitingPeriodNotOver);
    assert!(env.seat(2).succession_pending(), "not cleared for a report nobody else could make");
    warp(&mut env.svm, RT - SUCCESSION_WAIT);
    env.finalize_succession(2).unwrap();
    assert_eq!(env.seat(2).holder, b);
}

#[test]
fn h3_attack_the_reporter_and_the_agent_cannot_confirm_even_after_the_timeout() {
    // A compromised agent plus one person: the reporter, also a monitor and a beneficiary, can't confirm.
    let (mut env, _p) = guardian_env();
    let k1 = env.kid1.insecure_clone();
    env.set_seat_monitors(0, [k1.pubkey(), d()]).unwrap();
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    warp(&mut env.svm, 10 * RT);
    expect_err(env.confirm_seat_death(&k1, 0), HeirloomError::NotConfirmer);
    let agent = env.agent.insecure_clone();
    env.add_beneficiary(agent.pubkey(), "Agent");
    expect_err(env.confirm_seat_death(&agent, 0), HeirloomError::NotConfirmer);
}

#[test]
fn h3_attack_a_living_holder_vetoes_a_timed_out_report() {
    let (mut env, _p) = guardian_env();
    let (k1, k2, v0) = (env.kid1.insecure_clone(), env.kid2.insecure_clone(), env.v(0));
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    warp(&mut env.svm, RT);
    env.confirm_seat_death(&k2, 0).unwrap();
    env.veto_seat_death(&v0, 0).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    expect_err(env.finalize_succession(0), HeirloomError::NoSuccessionPending);
    assert_eq!(env.seat(0).holder, v0.pubkey());
}

#[test]
fn h3_attack_a_report_cannot_be_refreshed_to_hold_the_route_shut() {
    // A reviewed seat report keeps its place for RT + 2 waiting periods, so replacing it can't keep resetting the
    // timeout.
    let (mut env, _p) = guardian_env();
    let (k1, k2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone());
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    warp(&mut env.svm, RT);
    expect_err(env.report_seat_death(&k2, 0), HeirloomError::SuccessionPending);
    env.confirm_seat_death(&k2, 0).unwrap();
}

// ------------------------------------------------------------------- H4 the only trusted person who gains

#[test]
fn h4_the_sole_trusted_person_who_is_the_sole_beneficiary_unlocks_after_twice_the_wait() {
    let (mut env, spouse) = sole_trusted_spouse();
    env.death_claim_by(&spouse, [7; 32]).unwrap();
    env.review_death(true).unwrap();
    env.attest_death_by(&spouse).unwrap();
    let e = env.estate_state();
    assert_eq!(e.status, EstateStatus::DeathPending);
    assert_ne!(e.death_attestations & heirloom::DECIDED_ALONE, 0);
    warp(&mut env.svm, WAITING);
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, WAITING);
    env.finalize_unlock().unwrap();
}

#[test]
fn h4_a_referred_death_is_never_decided_alone() {
    let (mut env, spouse) = sole_trusted_spouse();
    env.death_claim_by(&spouse, [7; 32]).unwrap();
    env.refer_death().unwrap();
    expect_err(env.attest_death_by(&spouse), HeirloomError::OwnApproval);
}

#[test]
fn h4_the_lone_claimant_approves_their_own_claim_with_twice_the_window() {
    let (mut env, spouse) = sole_trusted_spouse();
    let (uni, until) = (env.university.pubkey(), now(&env.svm) + YEAR);
    let rule = env.add_rule(0, spouse.pubkey(), PayeeKind::University, 600 * USDT, 1_000 * USDT, until);
    env.death_claim_by(&spouse, [7; 32]).unwrap();
    env.review_death(true).unwrap();
    env.attest_death_by(&spouse).unwrap();
    warp(&mut env.svm, 2 * WAITING);
    env.finalize_unlock().unwrap();
    let claim = env.submit_claim_by(&spouse, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim_by(&spouse, claim).unwrap();
    warp(&mut env.svm, WINDOW);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
    // A referred claim is never decided alone.
    let other = env.submit_claim_by(&spouse, rule, uni, 100 * USDT).unwrap();
    env.refer_claim(other).unwrap();
    expect_err(env.approve_claim_by(&spouse, other), HeirloomError::OwnApproval);
}

#[test]
fn h4_attack_a_living_owner_who_checks_in_stops_it() {
    let (mut env, spouse) = sole_trusted_spouse();
    env.death_claim_by(&spouse, [7; 32]).unwrap();
    env.review_death(true).unwrap();
    env.attest_death_by(&spouse).unwrap();
    warp(&mut env.svm, WAITING + 1);
    env.check_in().unwrap();
    warp(&mut env.svm, WAITING);
    expect_err(env.finalize_unlock(), HeirloomError::BadStatus);
}

#[test]
fn h4_attack_not_while_another_trusted_person_lives() {
    // A compromised agent plus the one person who gains: with another seat held, they can't decide.
    let mut env = Env::configured();
    let v0 = env.v(0);
    env.add_beneficiary(v0.pubkey(), "Trusted child");
    env.death_claim_by(&v0, [7; 32]).unwrap();
    env.review_death(true).unwrap();
    expect_err(env.attest_death_by(&v0), HeirloomError::OwnApproval);
}

#[test]
fn h4_attack_a_living_holder_who_vetoes_keeps_the_route_shut() {
    let (mut env, _p) = guardian_env();
    let (v0, v1, v2, owner) = (env.v(0), env.v(1), env.v(2), env.kp(&env.owner));
    env.add_beneficiary(v0.pubkey(), "Trusted child");
    for i in 1..3 {
        env.set_seat_backups(&owner, i, [d(), d()]).unwrap();
    }
    let k1 = env.kid1.insecure_clone();
    // Someone tries to empty the other seats; their holders say "I'm still here".
    for (i, holder) in [(1u8, &v1), (2u8, &v2)] {
        env.report_seat_death(&k1, i).unwrap();
        env.review_seat_death(i, true).unwrap();
        env.confirm_seat_death(&v0, i).unwrap();
        env.veto_seat_death(holder, i).unwrap();
    }
    env.death_claim_by(&v0, [7; 32]).unwrap();
    env.review_death(true).unwrap();
    expect_err(env.attest_death_by(&v0), HeirloomError::OwnApproval);
}

// ------------------------------------------------------------------- H5 a dismissed dispute

#[test]
fn h5_a_dismissed_dispute_holds_the_claim_only_the_window_after_it_was_resolved() {
    let (mut env, _p, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    warp(&mut env.svm, 10);
    for v in [env.v(1), env.v(2)] {
        env.resolve_dispute(&v, claim, false, true).unwrap();
    }
    assert_eq!(env.objection(&claim).status, ObjectionStatus::Dismissed);
    warp(&mut env.svm, WINDOW - 1);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, 1);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn h5_a_dismissed_dispute_does_not_hand_a_siblings_claim_to_the_residual_heir() {
    let (mut env, _p) = guardian_env();
    let (k1, k2, uni) = (env.kid1.pubkey(), env.kid2.pubkey(), env.university.pubkey());
    let until = now(&env.svm) + WAITING + 150;
    let rule = env.add_rule(0, k1, PayeeKind::University, 1_000 * USDT, 1_000 * USDT, until);
    env.set_residual(k2).unwrap();
    env.unlock();
    let claim = env.submit_claim(true, rule, uni, 1_000 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    for v in [env.v(1), env.v(2)] {
        env.resolve_dispute(&v, claim, false, true).unwrap();
    }
    warp(&mut env.svm, 150);
    env.execute_claim(rule, claim).unwrap();
    assert_eq!(balance(&env.svm, &ata(&uni, &env.usdt_mint)), 1_000 * USDT);
}

#[test]
fn held_control_undisputed_claim_pays_before_the_same_expiry() {
    let (mut env, _p) = guardian_env();
    let (k1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let until = now(&env.svm) + WAITING + 150;
    let rule = env.add_rule(0, k1, PayeeKind::University, 1_000 * USDT, 1_000 * USDT, until);
    env.unlock();
    let claim = env.submit_claim(true, rule, uni, 1_000 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
}

// ------------------------------------------------------------------- H6 the fallback's waits

#[test]
fn h6_a_zero_fallback_wait_still_leaves_the_death_its_waiting_period() {
    let mut env = Env::configured();
    let p = People::new(&mut env.svm);
    env.guard_with(0, SUCCESSION_WAIT, 0);
    for i in 0..3usize {
        env.init_seat(i as u8, [d(); 2], [p.monitors[i].pubkey(), d()]).unwrap();
    }
    vacate_all(&mut env, &p);
    let k1 = env.kid1.pubkey();
    env.set_fallback([k1, d(), d(), d()]).unwrap();
    warp(&mut env.svm, 1);
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.start_fallback().unwrap();
    expect_err(env.execute_fallback(k1), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, 60);
    expect_err(env.execute_fallback(k1), HeirloomError::WaitingPeriodNotOver);
    // A living owner checks in within the waiting period: void.
    env.check_in().unwrap();
    warp(&mut env.svm, WAITING);
    expect_err(env.execute_fallback(k1), HeirloomError::FallbackNotReady);
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

#[test]
fn h6_the_fallback_waits_for_a_pending_unlock_and_its_open_challenge() {
    let m = Keypair::new();
    let mut env = estate_with_seats(LONG, FALLBACK_WAIT, [[d(); 2]; 3], [[d(); 2], [d(); 2], [m.pubkey(), d()]]);
    env.svm.airdrop(&m.pubkey(), 10_000_000_000).unwrap();
    let k1 = env.kid1.pubkey();
    env.set_fallback([k1, d(), d(), d()]).unwrap();
    env.death_pending();
    let estate = env.estate;
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    let (kid, v1, v2) = (env.kid1.insecure_clone(), env.v(1), env.v(2));
    env.succeed_by(0, &kid, &v1);
    env.succeed_by(1, &kid, &v2);
    env.succeed_by(2, &kid, &m);
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    expect_err(env.execute_fallback(k1), HeirloomError::WaitingPeriodNotOver);
    // Late in the wait the monitor takes the dispute's place (M3); it still holds when the wait ends.
    warp(&mut env.svm, LONG - FALLBACK_WAIT - 4 * SUCCESSION_WAIT - DAY);
    let seat = Some(seat_pda(&env.estate, 2));
    env.raise_objection(&m, TargetKind::Unlock, estate, 2, seat, false, None, None).unwrap();
    warp(&mut env.svm, 2 * DAY);
    expect_err(env.execute_fallback(k1), HeirloomError::ObjectionOpen);
    warp(&mut env.svm, 2 * LONG);
    env.execute_fallback(k1).unwrap();
}

// ------------------------------------------------------------------- H7 a lost agent

#[test]
fn h7_a_lost_agent_and_one_lost_trusted_key_are_replaced_after_the_recovery_timeout() {
    let (mut env, _p) = guardian_env();
    let candidate = Keypair::new();
    let (v0, v1, k1) = (env.v(0), env.v(1), env.kid1.insecure_clone());
    env.submit_death_claim(1).unwrap();
    env.vote_agent(&v0, candidate.pubkey()).unwrap();
    env.vote_agent(&v1, candidate.pubkey()).unwrap();
    assert_eq!(env.estate_state().agent, env.agent.pubkey());
    env.report_seat_death(&k1, 2).unwrap();
    warp(&mut env.svm, RT);
    env.vote_agent(&v0, candidate.pubkey()).unwrap();
    assert_eq!(env.estate_state().agent, candidate.pubkey());
    env.agent = candidate.insecure_clone();
    env.svm.airdrop(&candidate.pubkey(), 1_000_000_000).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    env.attest_death(1).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);
}

#[test]
fn h7_one_living_seat_replaces_a_lost_agent_with_a_death_claim_open() {
    let mut env = estate_with_seats(WAITING, FALLBACK_WAIT, [[d(); 2]; 3], [[d(); 2]; 3]);
    let (k1, v1, v2) = (env.kid1.insecure_clone(), env.v(1), env.v(2));
    env.succeed_by(0, &k1, &v1);
    env.succeed_by(1, &k1, &v2);
    let candidate = Keypair::new().pubkey();
    env.vote_agent(&v2, candidate).unwrap();
    assert_eq!(env.estate_state().agent, env.agent.pubkey(), "no death claim: still all of them");
    env.submit_death_claim(1).unwrap();
    warp(&mut env.svm, RT);
    env.vote_agent(&v2, candidate).unwrap();
    assert_eq!(env.estate_state().agent, candidate);
}

#[test]
fn h7_attack_a_living_owner_who_checks_in_keeps_the_agent() {
    let (mut env, _p) = guardian_env();
    let candidate = Keypair::new().pubkey();
    let (v0, v1) = (env.v(0), env.v(1));
    warp(&mut env.svm, RT);
    env.check_in().unwrap();
    env.submit_death_claim(1).unwrap();
    warp(&mut env.svm, RT - 1);
    env.vote_agent(&v0, candidate).unwrap();
    env.vote_agent(&v1, candidate).unwrap();
    assert_eq!(env.estate_state().agent, env.agent.pubkey());
}

#[test]
fn h7_attack_a_fresh_death_claim_does_not_open_it_at_once() {
    // The owner has not checked in for long, but the claim must stand unreviewed for RT first (N1).
    let (mut env, _p) = guardian_env();
    let candidate = Keypair::new().pubkey();
    let (v0, v1) = (env.v(0), env.v(1));
    warp(&mut env.svm, 10 * RT);
    env.submit_death_claim(1).unwrap();
    env.vote_agent(&v0, candidate).unwrap();
    env.vote_agent(&v1, candidate).unwrap();
    assert_eq!(env.estate_state().agent, env.agent.pubkey());
    warp(&mut env.svm, WAITING);
    expect_err(env.vote_agent(&v1, candidate), HeirloomError::AlreadyApproved);
    warp(&mut env.svm, RT - WAITING);
    env.vote_agent(&v1, candidate).unwrap();
    assert_eq!(env.estate_state().agent, candidate);
}

#[test]
fn h7_attack_a_compromised_agent_and_one_person_cannot_replace_it() {
    let (mut env, _p) = guardian_env();
    let candidate = Keypair::new().pubkey();
    let v0 = env.v(0);
    env.submit_death_claim(1).unwrap();
    warp(&mut env.svm, 10 * RT);
    env.vote_agent(&v0, candidate).unwrap();
    assert_eq!(env.estate_state().agent, env.agent.pubkey());
}

// ------------------------------------------------------------------- M1 the living owner is not dead

#[test]
fn m1_the_owner_resetting_the_fallback_list_is_proof_of_life() {
    let (mut env, p) = fallback_env();
    vacate_all(&mut env, &p);
    env.start_fallback().unwrap();
    warp(&mut env.svm, 10);
    let list = env.guard().fallback;
    env.set_fallback(list).unwrap();
    assert_eq!(env.guard().fallback_started_at, 0);
    expect_err(env.start_fallback(), HeirloomError::FallbackNotReady);
    assert_eq!(env.estate_state().death_cert_hash, [0u8; 32]);
}

#[test]
fn m1_the_owner_upholding_a_fallback_objection_is_proof_of_life() {
    let (mut env, p) = fallback_env();
    vacate_all(&mut env, &p);
    env.start_fallback().unwrap();
    let (k2, owner, guard) = (env.kid2.insecure_clone(), env.owner.insecure_clone(), guard_pda(&env.estate));
    env.raise_objection(&k2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();
    warp(&mut env.svm, 5);
    env.vote_objection(&owner, guard, true, None, None, None).unwrap();
    assert_eq!(env.objection(&guard).status, ObjectionStatus::Upheld);
    expect_err(env.start_fallback(), HeirloomError::FallbackNotReady);
}

#[test]
fn m10_an_agent_who_is_a_beneficiary_cannot_report_the_owners_death() {
    let (mut env, p) = guardian_env();
    let heir = env.executor.pubkey();
    vacate_all(&mut env, &p);
    let owner = env.owner.insecure_clone();
    let k1 = env.kid1.insecure_clone();
    env.set_agent(&owner, k1.pubkey()).unwrap();
    env.agent = k1.insecure_clone();
    env.set_fallback([heir, d(), d(), d()]).unwrap();
    warp(&mut env.svm, 1);
    expect_err(env.submit_death_claim(1), HeirloomError::NotParticipant);
    env.submit_death_claim(2).unwrap();
    env.review_death(true).unwrap();
}

#[test]
fn m10_the_agent_cannot_review_a_death_it_reported_before_it_became_the_agent() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    // As left by an agent change that kept the claim (an older program, or a vote before this one).
    let k1 = env.kid1.pubkey();
    env.edit_estate(|e| e.agent = k1);
    env.agent = env.kid1.insecure_clone();
    expect_err(env.review_death(true), HeirloomError::OwnApproval);
}

// ------------------------------------------------------------------- M2 a check-in under the old program

#[test]
fn m2_a_check_in_under_the_old_program_disproves_the_pending_death() {
    let (mut env, p) = guardian_env();
    env.death_pending();
    warp(&mut env.svm, 1);
    let estate = env.estate;
    env.object(&p, TargetKind::Unlock, estate, 2, None, None).unwrap();
    warp(&mut env.svm, 10);
    let t = now(&env.svm);
    env.edit_estate(|e| e.last_heartbeat = t);
    warp(&mut env.svm, WAITING);
    expect_err(env.finalize_unlock(), HeirloomError::DeathDisproved);
    // It can be replaced at once, by anyone in the plan.
    env.submit_death_claim(2).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::Active);
}

#[test]
fn m2_a_claim_older_than_a_check_in_cannot_be_attested() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    warp(&mut env.svm, 10);
    let t = now(&env.svm);
    env.edit_estate(|e| {
        e.death_pending_since = 0;
        e.last_heartbeat = t;
    });
    expect_err(env.attest_death(0), HeirloomError::DeathDisproved);
}

#[test]
fn l3_a_zero_waiting_period_from_before_the_bound_reads_as_sixty_seconds() {
    let mut env = Env::configured();
    env.edit_estate(|e| e.waiting_period_secs = 0);
    env.death_pending();
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, 60);
    env.finalize_unlock().unwrap();
}

// ------------------------------------------------------------------- M3 the challenge slot

#[test]
fn m3_one_attesters_dispute_cannot_shut_the_monitors_out_of_the_unlock_wait() {
    let (mut env, p) = guardian_env();
    env.death_pending();
    let v1 = env.v(1);
    let estate = env.estate;
    env.raise_dispute(&v1, TargetKind::Unlock, estate, false, [5; 32]).unwrap();
    env.object(&p, TargetKind::Unlock, estate, 2, None, None).unwrap();
    warp(&mut env.svm, WAITING);
    expect_err(env.finalize_unlock(), HeirloomError::ObjectionOpen);
}

// ------------------------------------------------------------------- M4 a removed monitor

#[test]
fn m4_a_removed_monitors_confirmation_no_longer_replaces_the_holder() {
    let (m, b) = (Keypair::new(), Keypair::new().pubkey());
    let mut env = estate_with_seats(WAITING, FALLBACK_WAIT, [[d(); 2], [d(); 2], [b, d()]], [[d(); 2], [d(); 2], [m.pubkey(), d()]]);
    env.svm.airdrop(&m.pubkey(), 10_000_000_000).unwrap();
    let (k1, v1, v2) = (env.kid1.insecure_clone(), env.v(1), env.v(2));
    env.succeed_by(0, &k1, &v1);
    env.succeed_by(1, &k1, &v2);
    env.report_seat_death(&k1, 2).unwrap();
    env.review_seat_death(2, true).unwrap();
    env.confirm_seat_death(&m, 2).unwrap();
    warp(&mut env.svm, 1);
    env.set_seat_monitors(2, [d(); 2]).unwrap();
    assert!(!env.seat(2).succession_pending());
    warp(&mut env.svm, SUCCESSION_WAIT);
    expect_err(env.finalize_succession(2), HeirloomError::NoSuccessionPending);
    assert_eq!(env.seat(2).holder, v2.pubkey());
}

// ------------------------------------------------------------------- M5 revoked challengers

#[test]
fn m5_the_living_owner_decides_a_dispute_and_a_replaced_persons_vote_never_counts() {
    let (mut env, _p) = guardian_env();
    let (k1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let i = env.add_rule_ix(0, k1, PayeeKind::University, 600 * USDT, 1_000 * USDT, now(&env.svm) + YEAR, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.owner_approve_claim(rule, claim).unwrap();
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    let v0 = env.v(0);
    expect_err(env.resolve_dispute(&v0, claim, true, true), HeirloomError::NotOwner);
    env.resolve_dispute_by_owner(claim, false, true).unwrap();
    assert_eq!(fetch::<Claim>(&env.svm, &claim).status, ClaimStatus::Open);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn m5_a_removed_beneficiarys_dispute_is_dismissed_by_the_owner() {
    let mut env = Env::configured();
    let (k1, k2, uni) = (env.kid1.pubkey(), env.kid2.pubkey(), env.university.pubkey());
    let i = env.add_rule_ix(0, k1, PayeeKind::University, 600 * USDT, 1_000 * USDT, now(&env.svm) + YEAR, true, 0, 0, 0, None);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let rule = rule_pda(&env.estate, 0);
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.owner_approve_claim(rule, claim).unwrap();
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    warp(&mut env.svm, 1);
    env.remove_beneficiary(k2).unwrap();
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionOpen);
    env.resolve_dispute_by_owner(claim, false, true).unwrap();
    env.execute_claim(rule, claim).unwrap();
}

// ------------------------------------------------------------------- M6 a replaced agent's reviews

#[test]
fn m6_a_replaced_agents_seat_death_review_goes_back_for_the_new_one() {
    let (mut env, p) = guardian_env();
    let k1 = env.kid1.insecure_clone();
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    let owner = env.owner.insecure_clone();
    warp(&mut env.svm, 1);
    let next = Keypair::new();
    env.svm.airdrop(&next.pubkey(), 1_000_000_000).unwrap();
    env.set_agent(&owner, next.pubkey()).unwrap();
    assert_eq!(env.seat(0).death_verdict, Verdict::Pending);
    let v1 = env.v(1);
    expect_err(env.confirm_seat_death(&v1, 0), HeirloomError::AgentNotApproved);
    env.agent = next;
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(0).unwrap();
    assert_eq!(env.seat(0).holder, p.backups[0][0].pubkey());
}

#[test]
fn m6_a_voted_out_agents_death_review_goes_back_for_the_new_one() {
    let mut env = Env::configured();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    let next = Keypair::new().pubkey();
    for i in 0..3 {
        let v = env.v(i);
        env.vote_agent(&v, next).unwrap();
    }
    let e = env.estate_state();
    assert_eq!((e.agent, e.death_verdict), (next, Verdict::Pending));
    expect_err(env.attest_death(0), HeirloomError::AgentNotApproved);
}

#[test]
fn m6_a_replaced_agents_fallback_death_review_goes_back_for_the_new_one() {
    let (mut env, _p) = fallback_env();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    let owner = env.owner.insecure_clone();
    env.set_agent(&owner, Keypair::new().pubkey()).unwrap();
    assert_eq!(fetch::<FallbackReport>(&env.svm, &fallback_report_pda(&env.estate, 0)).verdict, Verdict::Pending);
    warp(&mut env.svm, FALLBACK_WAIT);
    let v0 = env.v(0);
    expect_err(env.resolve_fallback_death(&v0, 0, None, true), HeirloomError::AgentNotApproved);
}

#[test]
fn l4_limit_void_agent_votes_revive_when_the_agent_returns() {
    // Documented, not fixed: telling the rounds apart needs a field in AgentVote or Estate (a layout change).
    let mut env = Env::configured();
    let (owner, a, b, x) = (env.owner.insecure_clone(), env.agent.pubkey(), Keypair::new().pubkey(), Keypair::new().pubkey());
    let (v0, v1, v2) = (env.v(0), env.v(1), env.v(2));
    env.vote_agent(&v0, x).unwrap();
    env.vote_agent(&v1, x).unwrap();
    env.set_agent(&owner, b).unwrap();
    env.set_agent(&owner, a).unwrap();
    env.vote_agent(&v2, x).unwrap();
    assert_eq!(env.estate_state().agent, x);
}

#[test]
fn l5_two_votes_during_a_false_death_do_not_change_the_agent() {
    let mut env = Env::configured();
    let x = Keypair::new().pubkey();
    env.death_pending();
    let (v0, v1) = (env.v(0), env.v(1));
    env.vote_agent(&v0, x).unwrap();
    env.vote_agent(&v1, x).unwrap();
    env.veto_death().unwrap();
    assert_eq!(env.estate_state().agent, env.agent.pubkey());
}

// ------------------------------------------------------------------- M7 challenges bound to a report

#[test]
fn m7_votes_on_a_rejected_death_claim_do_not_clear_the_next_one() {
    let (mut env, p) = guardian_env();
    let (estate, k1, k2, v0, v1) = (env.estate, env.kid1.insecure_clone(), env.kid2.insecure_clone(), env.v(0), env.v(1));
    env.death_claim_by(&k1, [0xAA; 32]).unwrap();
    env.object(&p, TargetKind::Unlock, estate, 2, None, None).unwrap();
    env.vote_objection(&v0, estate, true, None, None, None).unwrap();
    env.review_death(false).unwrap();
    warp(&mut env.svm, 1);
    env.death_claim_by(&k2, [0xBB; 32]).unwrap();
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    env.attest_death(2).unwrap();
    expect_err(env.vote_objection(&v1, estate, true, None, None, None), HeirloomError::ObjectionLapsed);
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);
}

#[test]
fn m7_an_objection_to_a_vetoed_seat_report_does_not_block_the_next_one() {
    let (mut env, p) = guardian_env();
    let seat = seat_pda(&env.estate, 0);
    let (k1, v0, v1) = (env.kid1.insecure_clone(), env.v(0), env.v(1));
    env.report_seat_death(&k1, 0).unwrap();
    env.object(&p, TargetKind::Succession, seat, 0, None, None).unwrap();
    env.veto_seat_death(&v0, 0).unwrap();
    warp(&mut env.svm, 1);
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(0).unwrap();
}

#[test]
fn m7_a_dismissed_objection_to_an_old_report_does_not_shut_the_monitors_out_of_a_new_one() {
    let (mut env, p) = guardian_env();
    let seat = seat_pda(&env.estate, 0);
    let (k1, v0, v1, v2) = (env.kid1.insecure_clone(), env.v(0), env.v(1), env.v(2));
    env.report_seat_death(&k1, 0).unwrap();
    env.object(&p, TargetKind::Succession, seat, 0, None, None).unwrap();
    for v in [&v1, &v2] {
        env.vote_objection(v, seat, false, None, None, None).unwrap();
    }
    env.veto_seat_death(&v0, 0).unwrap();
    warp(&mut env.svm, 1);
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    env.object(&p, TargetKind::Succession, seat, 0, None, None).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    expect_err(env.finalize_succession(0), HeirloomError::ObjectionOpen);
}

#[test]
fn l6_a_review_is_bound_to_the_person_it_was_read_for() {
    let (mut env, _p) = guardian_env();
    let (k1, k2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone());
    env.report_seat_death(&k1, 0).unwrap();
    let (read, holder) = (env.seat(0).death_cert_hash, env.seat(0).holder);
    let i = ix(
        heirloom::accounts::ReviewSeatDeath { agent: env.agent.pubkey(), estate: env.estate, seat: seat_pda(&env.estate, 0) },
        heirloom::instruction::ReviewSeatDeath { index: 0, approve: true, report_hash: [9; 32], cert_hash: read, holder },
    );
    let newcomer = Keypair::new().pubkey();
    env.replace_seat(0, newcomer).unwrap();
    env.report_seat_death(&k2, 0).unwrap(); // the same public hash
    expect_err(send(&mut env.svm, i, &[&env.agent]), HeirloomError::ReportChanged);
    assert_eq!(env.seat(0).death_verdict, Verdict::Pending);
}

// ------------------------------------------------------------------- M8 time to challenge a sale

#[test]
fn m8_an_upheld_sale_cannot_be_relisted_and_sold_to_the_old_offer() {
    let mut s = Sale::build(true);
    s.place_offer(1, FLOOR).unwrap();
    let m = s.people.as_ref().unwrap().monitors[0].insecure_clone();
    let (asset, seat) = (s.asset, seat_pda(&s.env.estate, 0));
    s.env.raise_objection(&m, TargetKind::Sale, asset, 0, Some(seat), false, Some(asset), None).unwrap();
    for v in [s.env.v(1), s.env.v(2)] {
        s.env.vote_objection(&v, asset, true, None, Some(asset), None).unwrap();
    }
    warp(&mut s.env.svm, WINDOW);
    let (agent, v0) = (s.env.agent.insecure_clone(), s.env.v(0));
    let ixs = [list_ix(&s, agent.pubkey()), accept_ix(&s, v0.pubkey(), None, FLOOR)];
    let e = send_all(&mut s.env.svm, &ixs, &[&agent, &v0]).unwrap_err();
    assert!(e.contains(&err_code(HeirloomError::OfferTooOld)), "{e}");
    assert_eq!(fetch::<Asset>(&s.env.svm, &asset).status, AssetStatus::Held);
}

#[test]
fn m8_a_hardship_quorum_and_a_sale_in_one_transaction_wait_out_the_window() {
    let mut s = Sale::build(true);
    s.place_offer(1, HARDSHIP_FLOOR).unwrap();
    let h = s.submit_hardship().unwrap();
    s.review_hardship(h, true).unwrap();
    s.approve_hardship(h, 0).unwrap();
    warp(&mut s.env.svm, WINDOW); // the offer has waited; the quorum has not
    let (agent, v2, kid) = (s.env.agent.insecure_clone(), s.env.v(2), s.env.kid2.pubkey());
    let approve = ix(
        heirloom::accounts::ApproveHardship {
            verifier: v2.pubkey(),
            estate: s.env.estate,
            asset: s.asset,
            hardship: h,
            payer: v2.pubkey(),
            approval_stamp: stamp_pda(&h),
            system_program: system_program(),
        },
        heirloom::instruction::ApproveHardship {},
    );
    let ixs = [approve, accept_ix(&s, v2.pubkey(), Some(kid), HARDSHIP_FLOOR)];
    let e = send_all(&mut s.env.svm, &ixs, &[&agent, &v2]).unwrap_err();
    assert!(e.contains(&err_code(HeirloomError::ObjectionWindowOpen)), "{e}");
    s.approve_hardship(h, 2).unwrap();
    warp(&mut s.env.svm, WINDOW);
    let i = accept_ix(&s, v2.pubkey(), Some(kid), HARDSHIP_FLOOR);
    send_all(&mut s.env.svm, &[i], &[&agent, &v2]).unwrap();
    assert_eq!(balance(&s.env.svm, &ata(&kid, &s.env.usdt_mint)), HARDSHIP_FLOOR);
}

#[test]
fn m8_with_a_guard_an_offer_waits_out_the_objection_window() {
    let mut s = Sale::build(true);
    s.place_offer(1, FLOOR).unwrap();
    expect_err(s.accept_offer(1), HeirloomError::ObjectionWindowOpen);
    warp(&mut s.env.svm, WINDOW);
    s.accept_offer(1).unwrap();
}

#[test]
fn l7_a_hardship_the_agent_rejected_can_be_asked_for_again() {
    let mut s = Sale::new();
    let h = s.submit_hardship().unwrap();
    s.review_hardship(h, false).unwrap();
    warp(&mut s.env.svm, YEAR);
    s.submit_hardship().unwrap();
    s.review_hardship(h, true).unwrap();
    // One upheld by people stays final.
    let mut hs: Hardship = fetch(&s.env.svm, &h);
    hs.status = HardshipStatus::Rejected;
    hs.agent_verdict = Verdict::Approved;
    s.env.plant(h, &hs);
    expect_err(s.submit_hardship(), HeirloomError::BadStatus);
}

#[test]
fn m10_the_agent_never_reviews_its_own_claim_or_hardship() {
    let mut s = Sale::new();
    let agent = s.env.agent.pubkey();
    let mut e = s.env.estate_state();
    e.agent = s.env.kid2.pubkey();
    let estate = s.env.estate;
    s.env.plant(estate, &e);
    let h = s.submit_hardship().unwrap();
    s.env.agent = s.env.kid2.insecure_clone();
    expect_err(s.review_hardship(h, true), HeirloomError::OwnApproval);
    let _ = agent;
}

// ------------------------------------------------------------------- M9, M10, L1, L2 the fallback's ends

#[test]
fn m9_proceeds_after_the_fallback_go_to_the_list_not_to_dead_rules() {
    let (mut env, p) = guardian_env();
    let (k1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let rule = env.add_rule(0, k1, PayeeKind::University, 600 * USDT, 1_000 * USDT, i64::MAX);
    env.set_fallback([k1, d(), d(), d()]).unwrap();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    vacate_all(&mut env, &p);
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    env.execute_fallback(k1).unwrap();
    let (estate, mint) = (env.estate, env.usdt_mint);
    fund_ata(&mut env.svm, &estate, &mint, 900 * USDT);
    env.sweep(k1, &[rule]).unwrap();
    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 5_900 * USDT);
    let _ = uni;
}

#[test]
fn m10_with_no_beneficiary_left_a_trusted_person_reports_the_owners_death() {
    let (mut env, _p) = guardian_env();
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    env.remove_beneficiary(k1).unwrap();
    env.remove_beneficiary(k2).unwrap();
    warp(&mut env.svm, 1);
    let v0 = env.v(0);
    env.death_claim_by(&v0, [7; 32]).unwrap();
    env.review_death(true).unwrap();
    expect_err(env.attest_death(0), HeirloomError::OwnApproval);
    env.attest_death(1).unwrap();
    env.attest_death(2).unwrap();
    assert_eq!(env.estate_state().status, EstateStatus::DeathPending);
}

#[test]
fn m10_a_listed_fallback_recipient_reports_the_owners_death() {
    let (mut env, _p) = guardian_env();
    let heir = env.executor.insecure_clone();
    env.svm.airdrop(&heir.pubkey(), 1_000_000_000).unwrap();
    env.set_fallback([heir.pubkey(), d(), d(), d()]).unwrap();
    let stranger = env.stranger.insecure_clone();
    let claim = |env: &Env, who: &Keypair| {
        ix(
            heirloom::accounts::SubmitDeathClaim {
                beneficiary: who.pubkey(),
                estate: env.estate,
                beneficiary_account: None,
                guard: Some(guard_pda(&env.estate)),
                objection: objection_pda(&env.estate),
            },
            heirloom::instruction::SubmitDeathClaim { cert_hash: [7; 32] },
        )
    };
    let i = claim(&env, &stranger);
    expect_err(send(&mut env.svm, i, &[&stranger]), HeirloomError::NotBeneficiary);
    let i = claim(&env, &heir);
    send(&mut env.svm, i, &[&heir]).unwrap();
}

#[test]
fn l1_the_estate_itself_is_never_a_fallback_recipient() {
    let (mut env, p) = guardian_env();
    let (e, k1) = (env.estate, env.kid1.pubkey());
    expect_err(env.set_fallback([e, d(), d(), d()]), HeirloomError::BadFallback);
    env.set_fallback([k1, d(), d(), d()]).unwrap();
    // A list an older program accepted: the estate is skipped.
    let mut g = env.guard();
    g.fallback = [e, k1, d(), d()];
    let address = guard_pda(&env.estate);
    env.plant(address, &g);
    warp(&mut env.svm, 1);
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    vacate_all(&mut env, &p);
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    env.execute_fallback(k1).unwrap();
    assert_eq!(balance(&env.svm, &ata(&k1, &env.usdt_mint)), 5_000 * USDT);
}

#[test]
fn l2_a_recipient_who_moved_their_token_account_cannot_wedge_the_plan() {
    let (mut env, p) = fallback_env();
    vacate_all(&mut env, &p);
    let (k1, mint) = (env.kid1.insecure_clone(), env.usdt_mint);
    let account = fund_ata(&mut env.svm, &k1.pubkey(), &mint, 0);
    let mut data = vec![6u8, 2, 1];
    data.extend_from_slice(Keypair::new().pubkey().as_ref());
    let i = Instruction::new_with_bytes(
        token_program(),
        &data,
        vec![AccountMeta::new(account, false), AccountMeta::new_readonly(k1.pubkey(), true)],
    );
    send(&mut env.svm, i, &[&k1]).unwrap();
    env.start_fallback().unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    expect_err(env.execute_fallback_into(k1.pubkey(), account), HeirloomError::WrongMint);
    // Any token account they own works.
    let other = Pubkey::new_unique();
    set_token_state(&mut env.svm, other, pack_token_account(&mint, &k1.pubkey(), 0));
    env.execute_fallback_into(k1.pubkey(), other).unwrap();
    assert_eq!(balance(&env.svm, &other), 5_000 * USDT);
}

// ------------------------------------------------------------------- the other lows

#[test]
fn l8_a_quorum_regained_by_a_vacancy_needs_a_fresh_approval_and_window() {
    let mut env = Env::new();
    let i = env.create_estate_ix(env.verifier_keys(), 2, 2, 2, WAITING);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let (k1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    env.add_beneficiary(k1, "Child");
    env.add_payee(uni, PayeeKind::University, "University");
    let i = env.deposit_ix(ata(&env.owner.pubkey(), &env.usdt_mint), 5_000 * USDT);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    env.guard_with(WINDOW, SUCCESSION_WAIT, FALLBACK_WAIT);
    for s in 0..3 {
        env.init_seat(s, [d(); 2], [d(); 2]).unwrap();
    }
    let rule = env.add_rule(0, k1, PayeeKind::University, 600 * USDT, 1_000 * USDT, now(&env.svm) + YEAR);
    env.unlock();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    env.approve_claim(claim, 1).unwrap();
    let stamped = fetch::<ApprovalStamp>(&env.svm, &stamp_pda(&claim)).approved_at;
    let (kid, v0, v2) = (env.kid1.insecure_clone(), env.v(0), env.v(2));
    env.succeed_by(1, &kid, &v2);
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    env.succeed_by(2, &kid, &v0);
    expect_err(env.execute_claim(rule, claim), HeirloomError::InsufficientApprovals);
    env.approve_claim(claim, 0).unwrap();
    let restamped = fetch::<ApprovalStamp>(&env.svm, &stamp_pda(&claim)).approved_at;
    assert!(restamped > stamped);
    expect_err(env.execute_claim(rule, claim), HeirloomError::ObjectionWindowOpen);
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn l9_the_agent_cannot_be_anyones_backup() {
    let backup = Keypair::new().pubkey();
    let mut env = estate_with_seats(WAITING, FALLBACK_WAIT, [[backup, d()], [d(); 2], [d(); 2]], [[d(); 2]; 3]);
    let owner = env.owner.insecure_clone();
    expect_err(env.set_agent(&owner, backup), HeirloomError::BadAgent);
    let v = [env.v(0), env.v(1), env.v(2)];
    for voter in &v {
        expect_err(env.vote_agent(voter, backup), HeirloomError::BadAgent);
    }
}

#[test]
fn l10_a_first_backup_who_reports_stays_a_backup() {
    let (mut env, p) = guardian_env();
    let (b0, v1) = (p.backups[0][0].insecure_clone(), env.v(1));
    env.report_seat_death(&b0, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(0).unwrap();
    assert_eq!((env.seat(0).holder, env.seat(0).backups), (p.backups[0][1].pubkey(), [b0.pubkey(), d()]));
}

#[test]
fn l11_a_void_fallback_objection_does_not_block_a_new_one() {
    let (mut env, p) = fallback_env();
    vacate_all(&mut env, &p);
    env.start_fallback().unwrap();
    let (k2, guard) = (env.kid2.insecure_clone(), guard_pda(&env.estate));
    env.raise_objection(&k2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();
    warp(&mut env.svm, 1);
    env.check_in().unwrap();
    warp(&mut env.svm, 1);
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    env.start_fallback().unwrap();
    env.raise_objection(&k2, TargetKind::Fallback, guard, 255, None, true, None, None).unwrap();
    assert_eq!(env.guard().open_objections, 1);
}

#[test]
fn l12_a_junk_fallback_report_cannot_outlast_the_countdown() {
    let m = Keypair::new();
    let mut env = estate_with_seats(LONG, FALLBACK_WAIT, [[d(); 2]; 3], [[d(); 2], [d(); 2], [m.pubkey(), d()]]);
    env.svm.airdrop(&m.pubkey(), 10_000_000_000).unwrap();
    let k1 = env.kid1.pubkey();
    env.set_fallback([k1, d(), d(), d()]).unwrap();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    let (kid, k2, v1, v2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone(), env.v(1), env.v(2));
    env.succeed_by(0, &kid, &v1);
    env.succeed_by(1, &kid, &v2);
    env.succeed_by(2, &kid, &m);
    env.start_fallback().unwrap();
    env.report_fallback_death_by(&k2, 0, None, [0xEE; 32]).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT / 2);
    // Half the refute wait in, a real report takes the junk one's place, in time to be confirmed.
    env.report_fallback_death_by(&m, 0, Some(2), [7; 32]).unwrap();
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    env.resolve_fallback_death(&k2, 0, None, true).unwrap();
    assert_eq!(env.guard().fallback_dead, 0b1);
    let _ = k1;
}

#[test]
fn l13_the_open_objections_count_drops_when_a_dispute_takes_a_lapsed_objections_place() {
    let (mut env, p) = guardian_env();
    let estate = env.estate;
    env.submit_death_claim(1).unwrap();
    env.object(&p, TargetKind::Unlock, estate, 2, None, None).unwrap();
    warp(&mut env.svm, 2 * WAITING);
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    env.attest_death(1).unwrap();
    warp(&mut env.svm, 1);
    env.kid_disputes(TargetKind::Unlock, estate).unwrap();
    assert_eq!(env.guard().open_objections, 0);
}

#[test]
fn l14_limit_a_referred_claim_with_one_trusted_person_left_is_paid_by_that_person() {
    // As designed (R8): the quorum is min(needed, eligible). The README's "needs two" is true only while two may
    // decide; the docs say so.
    let mut env = estate_with_seats(WAITING, FALLBACK_WAIT, [[d(); 2]; 3], [[d(); 2]; 3]);
    let (k1, uni) = (env.kid1.pubkey(), env.university.pubkey());
    let rule = env.add_rule(0, k1, PayeeKind::University, 600 * USDT, 1_000 * USDT, now(&env.svm) + YEAR);
    env.unlock();
    let (kid, v1, v2) = (env.kid1.insecure_clone(), env.v(1), env.v(2));
    env.succeed_by(0, &kid, &v1);
    env.succeed_by(1, &kid, &v2);
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.refer_claim(claim).unwrap();
    env.approve_claim(claim, 2).unwrap();
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn l15_a_check_in_keeps_a_dead_confirmers_confirmation() {
    let (mut env, p) = guardian_env();
    let (k1, v1, v2) = (env.kid1.insecure_clone(), env.v(1), env.v(2));
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    env.confirm_seat_death(&v1, 0).unwrap();
    env.succeed_by(1, &k1, &v2);
    env.check_in().unwrap();
    env.finalize_succession(0).unwrap();
    assert_eq!(env.seat(0).holder, p.backups[0][0].pubkey());
}

#[test]
fn l16_setting_the_list_again_voids_an_approved_death_report() {
    let (mut env, _p) = fallback_env();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    warp(&mut env.svm, 1);
    let list = env.guard().fallback;
    env.set_fallback(list).unwrap();
    warp(&mut env.svm, FALLBACK_WAIT);
    let v0 = env.v(0);
    expect_err(env.resolve_fallback_death(&v0, 0, None, true), HeirloomError::NoFallbackRecipient);
    assert_eq!(env.guard().fallback_dead, 0);
}

#[test]
fn tradeoff_sweep_pays_the_list_without_the_fallback_countdown() {
    let (mut env, p) = fallback_env();
    vacate_all(&mut env, &p);
    let k1 = env.kid1.pubkey();
    env.edit_estate(|e| e.status = EstateStatus::Unlocked); // as after a quorum unlock
    env.sweep(k1, &[]).unwrap();
    assert_eq!(balance(&env.svm, &env.vault()), 0);
}

#[test]
fn c1_the_old_add_rule_name_fails_closed() {
    let mut env = Env::configured();
    let (kid, until) = (env.kid1.pubkey(), now(&env.svm) + YEAR);
    let mut i = env.add_rule_ix(0, kid, PayeeKind::University, USDT, USDT, until, false, 0, 0, 0, None);
    i.data[..8].copy_from_slice(&[26, 241, 95, 174, 205, 5, 235, 77]); // add_rule's discriminator
    let e = send(&mut env.svm, i, &[&env.owner]).unwrap_err();
    assert!(e.contains("Custom(101)"), "expected InstructionFallbackNotFound, got {e}");
}

// ------------------------------------------------------------------- attacks that held

#[test]
fn held_a_claim_pays_once_in_one_transaction() {
    let (mut env, _p, rule) = guarded_claims();
    let claim = approved_claim(&mut env, rule);
    warp(&mut env.svm, WINDOW);
    let c: Claim = fetch(&env.svm, &claim);
    let i = env.execute_claim_ix(rule, claim, beneficiary_pda(&env.estate, &c.beneficiary), payee_pda(&env.estate, &c.payee));
    let s = env.stranger.insecure_clone();
    let e = send_all(&mut env.svm, &[i.clone(), i], &[&s]).unwrap_err();
    assert!(e.contains(&err_code(HeirloomError::BadStatus)), "{e}");
    assert_eq!(balance(&env.svm, &env.vault()), 5_000 * USDT);
}

#[test]
fn held_end_reuse_and_recap_in_one_transaction_is_clean() {
    let (mut env, rule) = claims_env();
    env.set_yearly_cap(rule, 800 * USDT, 0).unwrap();
    let k2 = env.kid2.pubkey();
    let end = ix(
        heirloom::accounts::EndRule { owner: env.owner.pubkey(), estate: env.estate, rule },
        heirloom::instruction::EndRule {},
    );
    let add = env.add_rule_ix(0, k2, PayeeKind::Landlord, 50 * USDT, 90 * USDT, now(&env.svm) + YEAR, false, 0, 0, 0, None);
    let cap = ix(
        heirloom::accounts::SetYearlyCap {
            owner: env.owner.pubkey(),
            estate: env.estate,
            rule,
            year_cap: year_cap_pda(&rule),
            system_program: system_program(),
        },
        heirloom::instruction::SetYearlyCap { cap: 70 * USDT, period_start: 0 },
    );
    let owner = env.owner.insecure_clone();
    send_all(&mut env.svm, &[end, add, cap], &[&owner]).unwrap();
    let r: Rule = fetch(&env.svm, &rule);
    assert_eq!((r.spent_total, r.claim_count, r.beneficiary), (0, 65_536, k2));
    assert_eq!((env.year_cap(&rule).cap, env.year_cap(&rule).period_spent), (70 * USDT, 0));
    assert_eq!(env.estate_state().rule_count, 1);
}

#[test]
fn held_refute_then_report_again_in_one_transaction_resets_everything() {
    let (mut env, _p) = fallback_env();
    env.report_fallback_death(0).unwrap();
    env.review_fallback_death(0, true).unwrap();
    let report = fallback_report_pda(&env.estate, 0);
    let (k1, v0) = (env.kid1.insecure_clone(), env.v(0));
    let refute = ix(
        heirloom::accounts::ResolveFallbackDeath {
            signer: k1.pubkey(),
            estate: env.estate,
            guard: guard_pda(&env.estate),
            fallback_report: report,
            rent_to: env.kid2.pubkey(),
            signer_seat: None,
            beneficiary_account: None,
        },
        heirloom::instruction::ResolveFallbackDeath { index: 0, dead: false },
    );
    let again = ix(
        heirloom::accounts::ReportFallbackDeath {
            reporter: v0.pubkey(),
            estate: env.estate,
            guard: guard_pda(&env.estate),
            fallback_report: report,
            signer_seat: None,
            beneficiary_account: None,
            system_program: system_program(),
        },
        heirloom::instruction::ReportFallbackDeath { index: 0, cert_hash: [3; 32] },
    );
    send_all(&mut env.svm, &[refute, again], &[&v0, &k1]).unwrap();
    let r: FallbackReport = fetch(&env.svm, &report);
    assert_eq!((r.verdict, r.rent_payer), (Verdict::Pending, v0.pubkey()));
}

#[test]
fn held_prefunded_pdas_block_nothing() {
    let (mut env, _p, rule) = guarded_claims();
    let claim = claim_pda(&rule, 0);
    for a in [claim, stamp_pda(&claim), objection_pda(&claim), year_cap_pda(&rule)] {
        env.svm.airdrop(&a, 1_000_000).unwrap();
    }
    let claim = approved_claim(&mut env, rule);
    warp(&mut env.svm, WINDOW);
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn held_sweep_rules_cannot_be_omitted_repeated_or_faked() {
    let mut env = Env::configured();
    let (k1, k2) = (env.kid1.pubkey(), env.kid2.pubkey());
    let until = now(&env.svm) + YEAR;
    let a = env.add_rule(0, k1, PayeeKind::University, USDT, 10 * USDT, until);
    let b = env.add_rule(1, k1, PayeeKind::University, USDT, 10 * USDT, until);
    env.set_residual(k2).unwrap();
    env.unlock();
    for bad in [vec![], vec![a], vec![a, a], vec![b, a], vec![a, b, b]] {
        expect_err(env.sweep(k2, &bad), HeirloomError::RulesIncomplete);
    }
    let e = env.estate;
    assert!(env.sweep(k2, &[a, e]).is_err());
    expect_err(env.sweep(k1, &[a, b]), HeirloomError::NoResidualRecipient);
    env.sweep(k2, &[a, b]).unwrap();
    assert_eq!(balance(&env.svm, &env.vault()), 20 * USDT);
}

#[test]
fn held_accounts_of_another_estate_are_refused() {
    let (mut env, rule) = claims_env();
    let (home, me) = (env.estate, env.owner.insecure_clone());
    let attacker = env.stranger.insecure_clone();
    env.owner = attacker.insecure_clone();
    env.estate = estate_pda(&attacker.pubkey());
    let real = env.verifier_keys();
    let theirs = [env.buyer1.pubkey(), env.buyer2.pubkey(), Keypair::new().pubkey()];
    let i = env.create_estate_ix(theirs, 1, 1, 1, WAITING);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let x = env.buyer2.pubkey();
    env.add_beneficiary(x, "x");
    let foreign_ben = beneficiary_pda(&env.estate, &x);
    let foreign_estate = env.estate;
    env.owner = me;
    env.estate = home;
    env.unlock();
    let uni = env.university.pubkey();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    let b1 = env.buyer1.insecure_clone();
    expect_err(env.approve_claim_by(&b1, claim), HeirloomError::NotVerifier);
    let i = ix(
        heirloom::accounts::ApproveClaim {
            verifier: b1.pubkey(),
            estate: foreign_estate,
            claim,
            payer: b1.pubkey(),
            approval_stamp: stamp_pda(&claim),
            system_program: system_program(),
        },
        heirloom::instruction::ApproveClaim {},
    );
    assert!(send(&mut env.svm, i, &[&b1]).is_err());
    let b2 = env.buyer2.insecure_clone();
    let i = ix(
        heirloom::accounts::RaiseDispute {
            disputer: b2.pubkey(),
            estate: home,
            beneficiary_account: Some(foreign_ben),
            target_account: Some(claim),
            objection: objection_pda(&claim),
            system_program: system_program(),
            guard: guard_pda(&home),
        },
        heirloom::instruction::RaiseDispute { kind: TargetKind::Claim, target: claim, reason_hash: [1; 32] },
    );
    expect_err(send(&mut env.svm, i, &[&b2]), HeirloomError::NotDisputer);
    assert_eq!(env.verifier_keys(), real);
}

#[test]
fn held_agent_alone_or_with_itself_cannot_sell() {
    let mut s = Sale::build(true);
    s.place_offer(1, ASKING).unwrap();
    warp(&mut s.env.svm, WINDOW);
    expect_err(s.accept_offer_with(1, None), HeirloomError::CoSignerRequired);
    let agent = s.env.agent.insecure_clone();
    expect_err(s.accept_offer_with(1, Some(&agent)), HeirloomError::CoSignerRequired);
    let buyer = s.env.buyer1.insecure_clone();
    expect_err(s.accept_offer_with(1, Some(&buyer)), HeirloomError::CoSignerRequired);
}

#[test]
fn held_extreme_times_do_not_overflow() {
    let mut env = Env::new();
    let i = env.create_estate_ix(env.verifier_keys(), 3, 3, 3, YEAR);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    let (k1, k2, uni) = (env.kid1.pubkey(), env.kid2.pubkey(), env.university.pubkey());
    env.add_beneficiary(k1, "a");
    env.add_beneficiary(k2, "b");
    env.add_payee(uni, PayeeKind::University, "u");
    let i = env.deposit_ix(ata(&env.owner.pubkey(), &env.usdt_mint), 5_000 * USDT);
    send(&mut env.svm, i, &[&env.owner]).unwrap();
    env.guard_with(180 * DAY, 180 * DAY, 180 * DAY);
    let rule = env.add_rule(0, k1, PayeeKind::University, u64::MAX, u64::MAX, i64::MAX);
    env.set_residual(k2).unwrap();
    env.submit_death_claim(1).unwrap();
    env.review_death(true).unwrap();
    for v in 0..3 {
        env.attest_death(v).unwrap();
    }
    warp(&mut env.svm, YEAR);
    env.finalize_unlock().unwrap();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    for v in 0..3 {
        env.approve_claim(claim, v).unwrap();
    }
    env.kid_disputes(TargetKind::Claim, claim).unwrap();
    warp(&mut env.svm, YEAR + 180 * DAY);
    env.execute_claim(rule, claim).unwrap();
    expect_err(env.sweep(k2, &[rule]), HeirloomError::NothingToSweep);
}

#[test]
fn held_rule_expiry_is_exact_for_claim_and_sweep() {
    let mut env = Env::configured();
    let (k1, k2, uni) = (env.kid1.pubkey(), env.kid2.pubkey(), env.university.pubkey());
    let until = now(&env.svm) + WAITING + 10;
    let rule = env.add_rule(0, k1, PayeeKind::University, 100 * USDT, 1_000 * USDT, until);
    env.set_residual(k2).unwrap();
    env.unlock();
    let claim = env.submit_claim(true, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    env.approve_claim(claim, 0).unwrap();
    warp(&mut env.svm, 10);
    assert_eq!(now(&env.svm), until);
    env.sweep(k2, &[rule]).unwrap();
    assert_eq!(balance(&env.svm, &env.vault()), 1_000 * USDT, "still reserved at valid_until");
    env.execute_claim(rule, claim).unwrap();
}

#[test]
fn held_sale_proceeds_to_the_estate_reach_the_vault() {
    let mut s = Sale::build(true);
    let mut a: Asset = fetch(&s.env.svm, &s.asset);
    a.proceeds_to = s.env.estate;
    let asset = s.asset;
    s.env.plant(asset, &a);
    s.place_offer(1, FLOOR).unwrap();
    warp(&mut s.env.svm, WINDOW);
    s.accept_offer(1).unwrap();
    assert_eq!(balance(&s.env.svm, &s.env.vault()), 5_000 * USDT + FLOOR);
}

#[test]
fn held_heaviest_sizes_fit_when_sponsored() {
    let mut env = Env::configured();
    let (kid, until) = (env.kid1.pubkey(), now(&env.svm) + YEAR);
    let rules: Vec<Pubkey> = (0..16).map(|id| env.add_rule(id, kid, PayeeKind::University, USDT, USDT, until)).collect();
    let mut i = ix(
        heirloom::accounts::SweepResidual {
            payer: env.stranger.pubkey(),
            estate: env.estate,
            residual: residual_pda(&env.estate),
            guard: guard_pda(&env.estate),
            recipient: env.kid2.pubkey(),
            usdt_mint: env.usdt_mint,
            vault: env.vault(),
            recipient_usdt: ata(&env.kid2.pubkey(), &env.usdt_mint),
            token_program: token_program(),
            associated_token_program: ata_program(),
            system_program: system_program(),
            fallback_report: fallback_report_pda(&env.estate, 255),
        },
        heirloom::instruction::SweepResidual {},
    );
    for r in &rules {
        i.accounts.push(AccountMeta::new_readonly(*r, false));
    }
    let mut with_budget = budget_ixs();
    with_budget.push(i.clone());
    let both = tx_size(&with_budget, &env.agent.pubkey());
    println!("SIZE sweep16 sponsored+budget={both}");
    assert!(both <= 1232);
}

#[test]
fn held_error_numbers_in_the_spec() {
    assert_eq!(6000 + HeirloomError::NotParticipant as u32, 6053);
    assert_eq!(6000 + HeirloomError::ClaimFromEndedRule as u32, 6060);
    assert_eq!(6000 + HeirloomError::OfferChanged as u32, 6061);
    assert_eq!(6000 + HeirloomError::DeathDisproved as u32, 6062);
    assert_eq!(6000 + HeirloomError::OfferTooOld as u32, 6063);
}

// =================================================================== re-review (plan 18.10 follow-up, N1-N7)

#[test]
fn n1_two_trusted_people_cannot_replace_an_agent_that_was_never_asked_to_review() {
    let (mut env, _p) = guardian_env();
    let (v0, v1) = (env.v(0), env.v(1));
    let theirs = funded(&mut env.svm);
    warp(&mut env.svm, RT);
    env.submit_death_claim(1).unwrap();
    warp(&mut env.svm, WAITING);
    env.vote_agent(&v0, theirs.pubkey()).unwrap();
    env.vote_agent(&v1, theirs.pubkey()).unwrap();
    assert_eq!(env.estate_state().agent, env.agent.pubkey(), "the claim has not stood unreviewed for RT");
    // The honest agent reviews in time: the route never opens.
    env.review_death(true).unwrap();
    warp(&mut env.svm, RT);
    env.vote_agent(&v1, theirs.pubkey()).unwrap_err();
    assert_eq!(env.estate_state().agent, env.agent.pubkey());
}

#[test]
fn n1_after_the_claim_stood_unreviewed_for_rt_two_may_replace_the_agent() {
    let (mut env, _p) = guardian_env();
    let (v0, v1) = (env.v(0), env.v(1));
    let next = funded(&mut env.svm);
    warp(&mut env.svm, RT);
    env.submit_death_claim(1).unwrap();
    env.vote_agent(&v0, next.pubkey()).unwrap();
    warp(&mut env.svm, RT - 1);
    env.vote_agent(&v1, next.pubkey()).unwrap();
    assert_eq!(env.estate_state().agent, env.agent.pubkey());
    warp(&mut env.svm, 1);
    env.vote_agent(&v1, next.pubkey()).unwrap();
    assert_eq!(env.estate_state().agent, next.pubkey());
}

#[test]
fn n1_control_a_check_in_during_the_wait_stops_it() {
    let (mut env, _p) = guardian_env();
    let (v0, v1) = (env.v(0), env.v(1));
    let theirs = funded(&mut env.svm);
    warp(&mut env.svm, RT);
    env.submit_death_claim(1).unwrap();
    warp(&mut env.svm, RT);
    env.vote_agent(&v0, theirs.pubkey()).unwrap();
    env.vote_agent(&v1, theirs.pubkey()).unwrap();
    env.agent = theirs.insecure_clone();
    env.review_death(true).unwrap();
    env.attest_death(0).unwrap();
    env.attest_death(1).unwrap();
    warp(&mut env.svm, WAITING - 1);
    env.check_in().unwrap();
    warp(&mut env.svm, 1);
    expect_err(env.finalize_unlock(), HeirloomError::BadStatus);
}

#[test]
fn n4_an_unreviewed_claim_cannot_be_replaced_so_the_recovery_clock_never_restarts() {
    let (mut env, _p) = guardian_env();
    let (v0, v1) = (env.v(0), env.v(1));
    let cand = Keypair::new().pubkey();
    warp(&mut env.svm, RT);
    env.submit_death_claim(1).unwrap();
    let first = env.estate_state().death_pending_since;
    env.vote_agent(&v0, cand).unwrap();
    warp(&mut env.svm, WAITING);
    expect_err(env.submit_death_claim(2), HeirloomError::BadStatus);
    warp(&mut env.svm, 10 * RT);
    expect_err(env.submit_death_claim(2), HeirloomError::BadStatus);
    assert_eq!(env.estate_state().death_pending_since, first);
    env.vote_agent(&v1, cand).unwrap();
    assert_eq!(env.estate_state().agent, cand);
}

#[test]
fn n3_limit_beneficiaries_replace_a_silent_living_trusted_person_after_rt() {
    // By design (H3): a trusted person who doesn't answer an approved report for RT, nor veto it during the
    // succession wait, is replaced on the confirmation of a beneficiary.
    let (mut env, p) = guardian_env();
    let (k1, k2, v0) = (env.kid1.insecure_clone(), env.kid2.insecure_clone(), env.v(0));
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    warp(&mut env.svm, RT);
    env.confirm_seat_death(&k2, 0).unwrap();
    warp(&mut env.svm, SUCCESSION_WAIT);
    env.finalize_succession(0).unwrap();
    assert_eq!(env.seat(0).holder, p.backups[0][0].pubkey());
    assert_ne!(env.seat(0).holder, v0.pubkey());
}

#[test]
fn n5_a_zero_succession_wait_still_gives_a_living_holder_sixty_seconds() {
    let mut env = Env::configured();
    env.guard_with(WINDOW, 0, FALLBACK_WAIT);
    for i in 0..3u8 {
        env.init_seat(i, [d(), d()], [d(), d()]).unwrap();
    }
    let (k1, v0, v1) = (env.kid1.insecure_clone(), env.v(0), env.v(1));
    env.report_seat_death(&k1, 1).unwrap();
    env.review_seat_death(1, true).unwrap();
    env.confirm_seat_death(&v0, 1).unwrap();
    expect_err(env.finalize_succession(1), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, 59);
    env.veto_seat_death(&v1, 1).unwrap();
    assert!(!env.seat(1).vacant);
}

#[test]
fn n6_new_monitors_clear_the_whole_report() {
    let (mut env, _p) = guardian_env();
    let (k1, k2) = (env.kid1.insecure_clone(), env.kid2.insecure_clone());
    env.report_seat_death(&k1, 0).unwrap();
    env.review_seat_death(0, true).unwrap();
    warp(&mut env.svm, RT);
    env.confirm_seat_death(&k2, 0).unwrap();
    let m = funded(&mut env.svm);
    env.set_seat_monitors(0, [m.pubkey(), d()]).unwrap();
    assert!(!env.seat(0).succession_pending(), "the report is cleared, not only the confirmation");
}

#[test]
fn held_h4_a_second_attestation_does_not_shorten_the_doubled_wait() {
    let (mut env, spouse) = sole_trusted_spouse();
    env.death_claim_by(&spouse, [7; 32]).unwrap();
    env.review_death(true).unwrap();
    env.attest_death_by(&spouse).unwrap();
    warp(&mut env.svm, WAITING);
    expect_err(env.finalize_unlock(), HeirloomError::WaitingPeriodNotOver);
    expect_err(env.attest_death_by(&spouse), HeirloomError::AlreadyApproved);
    warp(&mut env.svm, WAITING);
    env.finalize_unlock().unwrap();
}

// ------------------------------------------------------------------- N2 a lone voter who gains

/// Before the unlock the only trusted person left, who gains, can't install an agent by their own vote at RT; only
/// after the claim stood unreviewed for 2 x RT with no sign of life.
#[test]
fn n2_before_the_unlock_the_lone_heir_waits_two_recovery_timeouts() {
    let (mut env, spouse) = sole_trusted_spouse();
    let own = funded(&mut env.svm);
    warp(&mut env.svm, RT);
    env.death_claim_by(&spouse, [7; 32]).unwrap();
    warp(&mut env.svm, RT);
    expect_err(env.vote_agent(&spouse, own.pubkey()), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, RT - 1);
    expect_err(env.vote_agent(&spouse, own.pubkey()), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, 1);
    env.vote_agent(&spouse, own.pubkey()).unwrap();
    assert_eq!(env.estate_state().agent, own.pubkey());
}

/// A lone trusted person who gains nothing keeps the RT route; without their Beneficiary account the voter counts
/// as one who gains (fails closed).
#[test]
fn n2_a_lone_voter_who_gains_nothing_keeps_rt_and_a_missing_account_fails_closed() {
    let (mut env, spouse) = sole_trusted_spouse();
    let kid2 = env.kid2.insecure_clone();
    env.add_beneficiary(kid2.pubkey(), "Kid");
    env.remove_beneficiary(spouse.pubkey()).unwrap();
    let own = funded(&mut env.svm);
    warp(&mut env.svm, RT);
    env.death_claim_by(&kid2, [7; 32]).unwrap();
    warp(&mut env.svm, RT);
    expect_err(env.vote_agent_with(&spouse, own.pubkey(), &[]), HeirloomError::WaitingPeriodNotOver);
    let wrong = beneficiary_pda(&env.estate, &kid2.pubkey());
    expect_err(env.vote_agent_with(&spouse, own.pubkey(), &[wrong]), HeirloomError::WaitingPeriodNotOver);
    env.vote_agent(&spouse, own.pubkey()).unwrap();
    assert_eq!(env.estate_state().agent, own.pubkey());
}

/// Control: a check-in before 2 x RT stops it.
#[test]
fn n2_control_a_check_in_stops_the_lone_heir() {
    let (mut env, spouse) = sole_trusted_spouse();
    let own = funded(&mut env.svm);
    warp(&mut env.svm, RT);
    env.death_claim_by(&spouse, [7; 32]).unwrap();
    warp(&mut env.svm, 2 * RT - 1);
    env.check_in().unwrap();
    warp(&mut env.svm, 1);
    let _ = env.vote_agent(&spouse, own.pubkey());
    assert_ne!(env.estate_state().agent, own.pubkey());
    warp(&mut env.svm, 2 * RT);
    let _ = env.vote_agent(&spouse, own.pubkey());
    assert_ne!(env.estate_state().agent, own.pubkey(), "the claim was disproved; no recovery");
}

/// After the unlock a lone heir whose claim the agent referred can't install their own agent at once nor at RT;
/// only once that claim has stood unapproved for 2 x RT. Without such a claim, never alone.
#[test]
fn n2_after_the_unlock_the_lone_heir_replaces_a_referring_agent_only_after_two_recovery_timeouts() {
    let (mut env, spouse) = sole_trusted_spouse();
    let (uni, until) = (env.university.pubkey(), now(&env.svm) + YEAR);
    let rule = env.add_rule(0, spouse.pubkey(), PayeeKind::University, 600 * USDT, 1_000 * USDT, until);
    env.death_claim_by(&spouse, [7; 32]).unwrap();
    env.review_death(true).unwrap();
    env.attest_death_by(&spouse).unwrap();
    warp(&mut env.svm, 2 * WAITING);
    env.finalize_unlock().unwrap();
    let own = funded(&mut env.svm);
    let b = beneficiary_pda(&env.estate, &spouse.pubkey());
    expect_err(env.vote_agent(&spouse, own.pubkey()), HeirloomError::WaitingPeriodNotOver);
    let claim = env.submit_claim_by(&spouse, rule, uni, 100 * USDT).unwrap();
    env.refer_claim(claim).unwrap();
    expect_err(env.approve_claim_by(&spouse, claim), HeirloomError::OwnApproval);
    expect_err(env.vote_agent_with(&spouse, own.pubkey(), &[b, claim]), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, RT);
    expect_err(env.vote_agent_with(&spouse, own.pubkey(), &[b, claim]), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, RT - 1);
    expect_err(env.vote_agent_with(&spouse, own.pubkey(), &[b, claim]), HeirloomError::WaitingPeriodNotOver);
    expect_err(env.vote_agent(&spouse, own.pubkey()), HeirloomError::WaitingPeriodNotOver);
    warp(&mut env.svm, 1);
    env.vote_agent_with(&spouse, own.pubkey(), &[b, claim]).unwrap();
    assert_eq!(env.estate_state().agent, own.pubkey());
}

/// An approved claim is no clock: the agent is working.
#[test]
fn n2_an_approved_claim_does_not_start_the_clock() {
    let (mut env, spouse) = sole_trusted_spouse();
    let (uni, until) = (env.university.pubkey(), now(&env.svm) + YEAR);
    let rule = env.add_rule(0, spouse.pubkey(), PayeeKind::University, 600 * USDT, 1_000 * USDT, until);
    env.death_claim_by(&spouse, [7; 32]).unwrap();
    env.review_death(true).unwrap();
    env.attest_death_by(&spouse).unwrap();
    warp(&mut env.svm, 2 * WAITING);
    env.finalize_unlock().unwrap();
    let claim = env.submit_claim_by(&spouse, rule, uni, 100 * USDT).unwrap();
    env.review_claim(claim, true).unwrap();
    warp(&mut env.svm, 2 * RT);
    let own = funded(&mut env.svm);
    let b = beneficiary_pda(&env.estate, &spouse.pubkey());
    expect_err(env.vote_agent_with(&spouse, own.pubkey(), &[b, claim]), HeirloomError::WaitingPeriodNotOver);
}

/// Attack on N2 itself: a lone heir whose agent is truly lost is never locked out, before or after the unlock.
#[test]
fn n2_attack_the_lone_heir_with_a_lost_agent_still_recovers() {
    let (mut env, spouse) = sole_trusted_spouse();
    let (uni, until) = (env.university.pubkey(), now(&env.svm) + YEAR);
    let rule = env.add_rule(0, spouse.pubkey(), PayeeKind::University, 600 * USDT, 1_000 * USDT, until);
    // Before the unlock: the agent never reviews the death claim.
    warp(&mut env.svm, RT);
    env.death_claim_by(&spouse, [7; 32]).unwrap();
    warp(&mut env.svm, 2 * RT);
    let second = funded(&mut env.svm);
    env.vote_agent(&spouse, second.pubkey()).unwrap();
    env.agent = second.insecure_clone();
    env.review_death(true).unwrap();
    env.attest_death_by(&spouse).unwrap();
    warp(&mut env.svm, 2 * WAITING);
    env.finalize_unlock().unwrap();
    // After the unlock the new agent is lost too: the claim stands unreviewed.
    let claim = env.submit_claim_by(&spouse, rule, uni, 100 * USDT).unwrap();
    warp(&mut env.svm, 2 * RT);
    let third = funded(&mut env.svm);
    let b = beneficiary_pda(&env.estate, &spouse.pubkey());
    env.vote_agent_with(&spouse, third.pubkey(), &[b, claim]).unwrap();
    env.agent = third.insecure_clone();
    env.review_claim(claim, true).unwrap();
    env.approve_claim_by(&spouse, claim).unwrap();
    warp(&mut env.svm, 2 * WINDOW);
    env.execute_claim(rule, claim).unwrap();
}
