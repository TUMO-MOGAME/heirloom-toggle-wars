# Heirloom scripts (devnet)

All wallets the scripts use are **Tether WDK** wallets (`@tetherto/wdk-wallet-solana`), and every transaction is
signed and sent by WDK. Seeds live in `scripts/.demo-wallets.json` and env lines in `scripts/.env.devnet`; both are
gitignored. **Devnet only: never put real funds in these wallets.**

The scripts resolve packages from `app/node_modules`, so always run them **from `app/`** with the scripts tsconfig:

```bash
cd app
npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/devnet-setup.ts
npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/seed-demo.ts
```

## 1. `devnet-setup.ts`
1. Creates WDK wallets for the personas: dad (owner), Lerato, Sipho, Naledi (children), Adv. Ndlovu, Ms. Pillay,
   Uncle Bongani (verifiers), Pieter and Ayesha (car buyers), the AI agent, and payees (UCT, a residence, a school).
2. Funds the dad with devnet SOL, then the dad funds everyone else with WDK native SOL transfers.
   **The devnet RPC faucet is closed** (`410 Gone`): the script prints the dad's address; fund it with ~2 SOL at
   <https://faucet.solana.com> (devnet) and re-run. Re-running is safe: it skips anything already done.
3. Creates a 6-decimal **test USD₮** mint and the car's **digital-title NFT** (decimals 0, supply 1, mint authority removed).
4. Mints test USD₮ to the dad and sends the buyers theirs with WDK `transfer` (SPL USD₮).
5. Writes `scripts/.env.devnet`. Copy its lines into `app/.env.local` (it contains `AGENT_SEED_PHRASE`, keep it private).

## 2. Build and upgrade the program (`build-program.sh`, inside WSL)
```bash
bash scripts/build-program.sh          # build, check the program id, cargo test
bash scripts/build-program.sh idl      # the same, then update app/src/lib/chain/idl/heirloom.json
bash scripts/build-program.sh deploy   # the same, then upgrade the devnet program
```
- The program id is fixed at `b3PBVwkLnyx7eyLPNtc5J3Ds3os3cenqCVRHaCJM7FY`. The script checks it in `lib.rs`,
  `Anchor.toml` and the built IDL, never syncs keys and never copies sources back, so it is safe on a fresh clone.
  Don't run `anchor keys sync`: without the program's keypair it writes a new id into the repo.
- `test` (the default) and `idl` need no keypair, wallet or SOL. `test` changes no tracked file.
- `deploy` only upgrades the existing program, by id, with its upgrade authority's wallet (`HEIRLOOM_WALLET`, default
  `~/.config/solana/id.json`). It first prints the size, the SOL needed (a second copy's rent, which comes back, plus
  any growth and fees) and the balance, and refuses when the balance is short.
- The build runs in `~/heirloom-build`. Set `HEIRLOOM_WORK` to use another directory (empty, or an earlier build's).

After updating the IDL run `npm test` in `app/`: `instructions.test.ts` fails loudly if its account or arg names drift
from the client.

## 3. `seed-demo.ts`
Creates the demo estate from the fixed WillDraft in `app/src/lib/agent/canned.ts` (`DEMO_WILL`) with the persona
wallets: estate (agent + 3 verifiers, thresholds 2/1/2, waiting period `NEXT_PUBLIC_DEMO_WAITING_SECS`, default 120 s),
will hash, 3 beneficiaries, 3 payees, 4 rules, a 20,000 USD₮ deposit and the car (floor 9,000, hardship floor 7,000,
asking 10,500; sale proceeds go back into the estate vault). With `SUPABASE_*` set it also stores display names.
Idempotent: existing accounts are skipped.

## 3b. `seed-guardians-assets.ts`: the guardians demo estate (15 Nov 2026)
The first demo estate (owner `dad`) is Unlocked with its car sold, and an Unlocked estate can't register assets, add a
Guard or seats or set a yearly cap. This script seeds a second estate for a new owner persona `thabo`, the same story
as the demo site: the will above (same children, trusted people, payees, rules, 20,000 USD₮), the **2017 Toyota Corolla
1.8 Exclusive CVT** (13,500 / 12,500 / 10,500) and the **2025 Big Boy Mustang 250** (2,000 / 1,800 / 1,500), each with
a fresh title NFT and the media root of its bundled photos + spec sheet (`DEMO_ASSETS`; the chain service shows the
bundled set when the on-chain root matches, devnet only), a Guard and three seats (Uncle Bongani: backups Kagiso and
Priya, monitor Zodwa), the fallback plan (Lerato, Sipho, Naledi, Ithemba Children's Charity) and a 3,000 USD₮ yearly cap
on Naledi's school fees. Since the second review every seat has a monitor (Zodwa; Priya for the second seat), the
labels on-chain are roles only and a schedule without its payee stops the script. It also adds the personas `thabo`, `zodwa`, `kagiso`, `priya`, `charity`, gives the helpers a
little SOL and tops up the buyers' test USD₮. Idempotent; signed by WDK; prints Explorer links, never seeds.
The owner needs ~0.3 devnet SOL first (it stops and prints the address if not).

```bash
cd app; set -a; . ../scripts/.env.devnet; set +a
npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/seed-guardians-assets.ts [--dry]
npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/demo-history.ts --owner thabo   # real history
```

## 4. Use the personas in the app
Set `NEXT_PUBLIC_DATA_MODE=chain`, start the app, and import each persona's seed from `scripts/.demo-wallets.json`
(Wallet → Import). Each seed is encrypted on the device with a PIN; nothing is sent to the server.

## 4b. Laptop demo on devnet, history and rehearsal
- `demo-devnet.ps1`: starts the app in chain mode on devnet (loads `.env.local` + `scripts/.env.devnet` into the
  process; writes nothing). Full test path: [docs/devnet-test-guide.md](../docs/devnet-test-guide.md).
- `demo-history.ts [--dry] [--owner thabo]`: adds real history to the demo estate (`dad`'s by default) while the dad is alive (due scheduled payments, a
  reviewed and owner-approved school-fee claim, a vault top-up, pocket money to Lerato).
- `rehearse-devnet.ts`: the whole passing → unlock → claim → car-sale story on a THROWAWAY estate with tiny amounts,
  so the after-death flows are proven without touching the demo estate.

Run the .ts scripts from `app/` with the devnet env loaded (Git Bash):
`set -a; . ../scripts/.env.devnet; set +a; npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/demo-history.ts`

## 4c. `rehearse-second-review.ts`: the second security review, rehearsed on devnet
On throwaway estates only: a living claim, a death to payout, a co-signed sale, and the refusals R1-R9 and R18-R20.
Each is asserted on the chain. A refusal lands as a failed transaction, so it has an Explorer link too.

```bash
cd app
npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/rehearse-second-review.ts <payer keypair path>          # dry run: the plan
npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/rehearse-second-review.ts <payer keypair path> --send   # after the upgrade
```
- Dry by default: it checks the cluster and prints the plan, without reading the keypair.
- `--send` takes about five minutes (real waiting periods) and needs 0.6 SOL in the payer; most comes back.
  `--rpc <url>` uses another devnet RPC. Any other cluster is refused by its genesis hash. No env file is loaded.
- It prints JSON with the estates and an Explorer link for every transaction, and exits 1 if any assertion fails.

## 5. Voice agent
See [`elevenlabs-agent.md`](elevenlabs-agent.md) for the ElevenLabs dashboard configuration.

## Supabase
Apply `supabase/migrations/0001_init.sql` (SQL editor or `supabase db push`). It creates the metadata tables with RLS
on and no public policies, and the private `evidence` bucket.
