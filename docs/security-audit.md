# Heirloom: security audit report

**Program:** `b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY` (Solana devnet) · **Framework:** Anchor 1.2.2 ·
**Size:** 58 instructions, about 6,900 lines of Rust · **Report date:** 25 November 2026

> **What this is, and what it is not.** This is a structured internal audit: an adversarial review of the program and
> the app, the regression tests that prove each finding fixed, static analysis, a dependency audit, a verifiable
> build and a threat model. The reviews were run as separate reviewer passes that were not shown earlier findings.
> **It is not a third-party audit by a security firm.** One is planned before any mainnet launch (see the
> [roadmap](#before-mainnet)). Heirloom runs on devnet with a test USD₮ mint only.

## 1. Summary

| | |
|---|---|
| Findings in the program (R1–R22, H1–H7, M1–M10, L1–L16, N1–N6, C1) | **62**, all fixed or documented as limits |
| Third independent read (25 Nov, P1–P6, plan §22.1) | **6**: 1 medium (a faked unlock by the agent and one person), 5 low; P1–P5 fixed with tests that failed on the old binary first, P6 documented ([§5](#5-accepted-limits-disclosed-not-fixed)) |
| Critical / high findings open | **0** |
| Program tests (LiteSVM, run against the compiled program) | **348 pass** |
| Tests named after the finding they prove fixed | **214** |
| Attack probes re-run by the reviewer | **62**: 47 showed a defect (now fixed), 14 attacks held, 1 trade-off |
| End-to-end attack run on devnet | **20 attacks refused**, 92 steps ok, 14 scenarios (`scripts/rehearse-second-review.ts --send`) |
| Static analysis (clippy, incl. `arithmetic_side_effects`) | 0 errors; 10 warnings in the program, all triaged as not exploitable ([§4a](#4a-static-analysis-triage)) |
| Dependency audit (`cargo audit`, RustSec, 412 crates) | 0 advisories in the deployed program; 2 in the off-chain test harness only ([§4b](#4b-dependency-audit)) |
| App dependencies (`npm audit`, production) | 0 vulnerabilities (gate of 23 Nov) |
| Verifiable build | Devnet runs the Docker build from `solanafoundation/solana-verifiable-build:3.1.10`; on-chain hash `9d706ac2…269526` matches a clean rebuild ([§4c](#4c-verifiable-build)) |
| Upgrade authority | A **2-of-3 Squads v4 multisig** with a 10-minute time lock, not one key ([§4d](#4d-upgrade-authority-squads-multisig)) |

## 2. Scope and method

**In scope:** every instruction in `programs/heirloom/src`, the fee sponsor policy (`app/src/lib/sponsor/policy.ts`),
the agent's signing allow-list (`app/src/lib/agent/agent-wallet.ts`) and the server routes that sign or move money.

**Method, in order:**
1. **Specification first.** Every rule is written down in [program-spec.md](program-spec.md) before it is coded.
2. **Adversarial review, round 1 (22 Nov).** A reviewer with only the code and the spec looked for ways to steal,
   freeze or redirect funds. Result: "don't ship" (findings R1–R17).
3. **Fix with a failing test first.** Each fix got a test that failed on the old build (commit `fc693c3`) and passes
   on the new one.
4. **Adversarial review, round 2 (22 Nov).** A fresh reviewer, not shown round 1, wrote 62 probes. Result: "don't
   ship" (findings H1–H7, M1–M10, L1–L16). Each probe became a regression test.
5. **Diff-only re-review (23 Nov).** The fixes were checked again (findings N1–N6). Verdict: release.
6. **Reproducible release.** The lead rebuilt the program from a clean archive with a throwaway home directory and
   compared hashes before upgrading devnet; all 148 accounts on devnet were decoded with the new IDL first.
7. **Live attack run.** The same attacks were sent to the real devnet program from fresh wallets.
8. **Third read (25 Nov).** A reviewer not shown this report read the program cold and found P1–P6. The fixes shipped
   in the verifiable build above through the multisig (Squads proposal 1). New estates need 2 trusted people and a
   5-minute wait to unlock, a withdrawal counts as proof of life, and orphaned rules no longer lock the surplus.

## 3. Threat model

Who could attack, what they would try, and what stops them. Test names are in
[`programs/heirloom/tests/heirloom.rs`](../programs/heirloom/tests/heirloom.rs).

| Attacker | What they would try | What stops it (enforced in the program) | Proof |
|---|---|---|---|
| **A stranger** | Drain the vault; report someone dead; block a death claim | Every money path needs a signer tied to the estate (`has_one`, PDA seeds); only participants may report a death | `r06_a_stranger_cannot_report_a_seat_death`, `r04_only_participants_report_…` |
| **A child (beneficiary)** | Claim more than the rule allows; be paid in cash | Caps per claim, per year and per lifetime; payouts only to the rule's approved institution | cap tests, `r16_*` (every payout re-checks payee and beneficiary) |
| **A trusted person** | Approve their own claim or hardship; vote twice from two seats; keep voting after being replaced | Self-approval refused; one wallet, one vote; replacement clears the old attestation | `r11_*`, `r09_*`, `r02_*` |
| **A colluding pair** | Declare a living owner dead to unlock the vault | AI document check + 2 of 3 trusted people + a waiting period; any owner check-in cancels the claim | `r01_check_in_during_the_wait_stops_the_unlock` |
| **The AI agent (or a stolen agent key)** | Approve a bad claim; mark someone dead; sell an asset to itself | The agent can only sign an allow-list; it can't approve when unsure (it refers); it can't act alone on deaths or redirect a surplus; a sale needs a living trusted person's co-signature | `r04_the_agent_alone_cannot_redirect_the_surplus`, `r12_*` |
| **A buyer** | Swap a lower offer in at settlement; buy below the floor | `accept_offer(expected_amount)` fails with `OfferChanged`; floor enforced; title and money swap atomically | `r19_*`, sale tests |
| **A fake title** | List an asset whose NFT someone can still mint or freeze | Mint and freeze authority must both be `None` | `r13_*` |
| **Prompt injection** | A document tells the AI "approve this" | The AI only recommends; the program enforces caps and quorums whatever it says; the demo shows a hidden instruction caught | [demo screenshot C1](demo-screenshots/README.md) |
| **Heirloom itself (operator)** | Change the rules; take the money | Funds sit in a program-owned vault; the server can only sign the allow-list; the fee sponsor only co-signs USD₮ `transferChecked` and Heirloom instructions; program upgrades need 2 of 3 multisig members and wait out a time lock | `policy.ts` tests |
| **Lost keys / lockups** | Funds stuck for ever when people die or disappear | Quorums shrink to the living seats (never zero); fallback recipients; a lost agent can be replaced; objections and disputes lapse | `r07_*`, `r08_*`, `h7_*` |

## 4. Solana-specific checks

| Check | Result |
|---|---|
| Signer checks on every state change | Yes: `Signer<'info>` on every instruction that moves value or votes |
| Account ownership and type | Anchor `Account<T>` types; all 61 `UncheckedAccount`s carry a `/// CHECK` note and are checked by owner and discriminator in code (`instructions/mod.rs`) |
| PDA derivation | Seeds plus stored bump on estate, vault authority, claims, offers and escrows |
| Mint confusion | Vault and every payout use `transfer_checked`, and the mint must equal `estate.usdt_mint` (`WrongMint`) |
| Arithmetic | `overflow-checks = true` in release; 56 checked or saturating operations on amounts and times |
| Duplicate / aliased accounts | Typed and unchecked pairs checked for aliasing (round 2, H1) |
| Account closing and rent | 6 `close =` constraints; stale reports can be replaced without their rent being taken (`r04_a_stale_report_…`) |
| CPI | Only to the System, SPL Token and Associated Token programs, each typed as `Program<'info, …>` so a fake program is refused |
| Upgrade safety | Account layouts never change; enums and errors are append-only; a version gate (`add_rule_v2`) makes a mismatched app fail closed |

## 4a. Static analysis triage

`cargo clippy -p heirloom --all-targets -- -W clippy::all -W clippy::arithmetic_side_effects` (25 Nov 2026):
0 errors. The 10 warnings in the program (the rest are in test code):

| Where | Lint | Verdict |
|---|---|---|
| `continuity.rs:398, 401` | arithmetic | Counters of at most 3 seats: can't overflow a `u8` |
| `guardians.rs:481`, `setup.rs:68` | arithmetic | `i + 1` over fixed-size arrays (3 entries) |
| `guardians.rs:885, 889` | arithmetic | `(index + 1) % 3` in PDA seeds; `index` is checked to be below 3 |
| `guardians.rs:1202` | arithmetic | Bit position `i * 2 + j` is at most 5 in a `u8` |
| `state.rs:670` | arithmetic | Year arithmetic after a guard; the result already uses saturating maths |
| `guardians.rs:70`, `sale.rs:400` | style (`map_or`) | Readability only |
| (two functions) | too many arguments | Readability only |

Release builds keep `overflow-checks = true`, so any arithmetic overflow fails the transaction instead of wrapping:
the worst case is a refused transaction, never a wrong payout.

## 4b. Dependency audit

`cargo audit` (cargo-audit 0.23.0, RustSec database of 25 Nov 2026) over 412 crates. Each finding was traced with
`cargo tree -i` to see whether it reaches the deployed program:

| Crate | Advisory | Reaches the deployed program? |
|---|---|---|
| `crypto-bigint 0.5.5` | RUSTSEC-2026-0387, timing variability | No: only via `litesvm` (the local test VM) |
| `ctutils 0.4.2` | RUSTSEC-2026-0385, non-constant-time comparisons | No: only via `litesvm` |
| `ansi_term`, `derivative`, `libsecp256k1`, `paste` | Unmaintained (warning, no vulnerability) | No: only via `litesvm` |
| `bincode 1.3.3` | Unmaintained (warning, no vulnerability) | Yes, through `anchor-lang` 1.2.2; no known flaw; it goes when Anchor drops it |

Timing side channels matter for code that handles secrets; the test VM handles none, and it never runs on-chain.

## 4c. Verifiable build

Anyone can rebuild the program from this repository and get the bytes that run on devnet.

| | |
|---|---|
| Builder image | `solanafoundation/solana-verifiable-build:3.1.10` (digest `sha256:f71be5ca7620b7e40933b7f1294fa44e01d08c1fc5ba1f375a2478f5a01580d3`), Rust 1.86.0 |
| Command (as `solana-verify build` runs it) | in `programs/heirloom`: `cargo build-sbf -- --config registries.crates-io.protocol="sparse" --locked` |
| Binary | 1,128,608 bytes; file sha256 `03c1d5835f2c0ea2e34e2932a438a4221bf3aaaf732698fc53b6a5ee758b478e` |
| Program hash (solana-verify method: trailing zeros stripped) | `9d706ac23580ad190b77f9735ce30b805054ef5069e27c41e46571c0cb269526`, equal to `solana-verify get-program-hash` (v0.5.2) of the live program, checked 25 Nov 2026 |
| Deployed | 25 Nov 2026, slot 526117721, through Squads proposal 1 (2 of 3 approvals, then the 600 s time lock): [upgrade transaction](https://explorer.solana.com/tx/2xP4eycn8qL388fCi4gAtmgQS9V33Q9HSxo1ha8X4RF5tbx4BYs5JvgtB7YQYq399tpexNM8UyuiKfVxLwHbbuAx?cluster=devnet). The program data was first grown by 20,480 bytes (`solana program extend`) |
| Tests on that exact binary | 348 / 348 (the LiteSVM suite loads the built `.so`) |
| Public verification (OtterSec) | Submitted once the repository is public (27 Nov 2026); until then, rebuild it yourself with the command above |

## 4d. Upgrade authority: Squads multisig

An upgradeable program is only as trustworthy as whoever can upgrade it. Since 25 Nov 2026 no single key can change
Heirloom's rules.

| | |
|---|---|
| Upgrade authority | Squads v4 vault [`A66NhjuJpRQdCCjZuNdPaM1aGB822se8rFdTAvQMxkFR`](https://explorer.solana.com/address/A66NhjuJpRQdCCjZuNdPaM1aGB822se8rFdTAvQMxkFR?cluster=devnet) |
| Multisig | [`SqjbTV4CqKHy5zAGk4UW3JaNsAURgBuR7bXbuuYaU8x`](https://explorer.solana.com/address/SqjbTV4CqKHy5zAGk4UW3JaNsAURgBuR7bXbuuYaU8x?cluster=devnet) ([created](https://explorer.solana.com/tx/vgiEE1jmn5VMYN2UPiw3SjF3jdFwD2FPNKxXUnSPkn3afpZXBtzrhDZKxnEJz8mTk7pF9siUtf1YN6E8w9iCUXo?cluster=devnet)); no config authority, so only a 2-of-3 vote can change its members |
| Rule | 2 of 3 members approve, then a **600 s time lock** before anyone can execute: an upgrade is public before it runs |
| Handover | [set-upgrade-authority](https://explorer.solana.com/tx/4e6vdiwZyJ6s9PgxzKfRvqsmA9aeZdUWEsm3CnoJj4H7bwvfGbSxf7JMpmE2tzeR1ewAcKZ1YXZJyf6THyJ817ck?cluster=devnet) |
| Tooling | [`scripts/squads/squads.mjs`](../scripts/squads/squads.mjs): propose an upgrade from a buffer, approve, execute, show |
| Honest limit | On devnet the three member keys are held by the one builder on separate key files. Before mainnet they move to three people on separate devices (hardware wallets), the time lock goes up to at least 48 hours, and once the rules are final the authority is removed (`--final`) |

## 5. Accepted limits (disclosed, not fixed)

- A sole survivor who is the only claimant needs the agent's Approve (never Referred) and waits twice as long.
- Some objection and agent votes can't be revoked; they are bounded by a lapse.
- Funds need at least one working path (trusted people or a fallback plan) to be recoverable.
- L4: an agent's old votes can revive if the same agent is reinstated (fixing it needs an account layout change).
- P6 (plan §22.1): the program doesn't prove an accepted offer is the highest open one. Offers are separate accounts
  with no count on the asset, so it would need a layout change or a client-supplied list it can't trust. It enforces
  the floor, the agreed amount, the objection windows and the co-signature; the agent and the co-signing trusted
  person choose the best offer (`r5_p6_*`).
- A beneficiary who dies (rather than being removed) keeps their rule's reserve until it expires: the program has no
  record of a beneficiary's death. A removed beneficiary's rule is ended by anyone after the unlock (P3).
- Off-chain: names and documents live in Supabase, never on-chain (only SHA-256 hashes); the server is trusted not to
  hide a claim from the UI, but it can't move money.

## 6. Reproduce it

```bash
# Linux / WSL, Anchor 1.2.2
anchor build && cargo test -p heirloom          # 348 tests
cargo clippy -p heirloom --all-targets
cargo audit
solana-verify build --base-image solanafoundation/solana-verifiable-build:3.1.10 --library-name heirloom
solana-verify get-program-hash -u devnet b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY   # expect 9d706ac2…
```

## Before mainnet

1. A third-party audit by a Solana security firm (budget and quote to be sought in the pilot phase).
2. A bug bounty with small caps during the pilot.
3. Upgrade authority stays with a multisig, then is frozen once the rules are final.
4. Real USD₮ with low per-estate caps for the first 20 families.
