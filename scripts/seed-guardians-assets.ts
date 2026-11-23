/**
 * Seeds the GUARDIANS DEMO ESTATE on devnet, the same story as the demo site (mock mode):
 *   Thabo Mokoena (persona `thabo`) with the fixed will (DEMO_WILL: 3 children, 3 payees, 4 rules, 20,000 USD₮, the Corolla),
 *   his 2017 Toyota Corolla 1.8 Exclusive CVT (13,500 / 12,500 / 10,500 USD₮) and his 2025 Big Boy Mustang 250
 *   (2,000 / 1,800 / 1,500), each with a fresh title NFT and the media root of its bundled photos + spec sheet
 *   (DEMO_ASSETS), trusted people with a Guard and three seats (Uncle Bongani's seat: backups Cousin Kagiso and
 *   Adv. Priya Naidoo, Aunt Zodwa as monitor; the other two seats are watched as well), the fallback plan (Lerato, Sipho, Naledi, then Ithemba Children's
 *   Charity) and a 3,000 USD₮ yearly cap on Naledi's school fees.
 *
 * Why a second estate: the first demo estate (owner `dad`, JBds…G9E) is Unlocked with its 2019 Corolla Sold, and
 * register_asset, init_guard, init_seat and set_yearly_cap all need an Active estate; an Unlocked estate can never
 * become Active again. That estate keeps its real history and stays readable.
 *
 * Idempotent: every step checks the chain first and skips what exists. All transactions are signed by Tether WDK
 * wallets (thabo; the dad only mints test USD₮, as the mint authority). Seeds are never printed.
 *
 * Run from app/ with the devnet env loaded (Git Bash):
 *   set -a; . ../scripts/.env.devnet; set +a
 *   npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/seed-guardians-assets.ts [--dry]
 * Then, for real history: npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/demo-history.ts --owner thabo
 */
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  AuthorityType, MINT_SIZE, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createMintToCheckedInstruction, createSetAuthorityInstruction, getAssociatedTokenAddressSync, getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import { loadEnv, loadOrCreateWallets, saveWallets, wdk, send, explorer, log, disposeAll, connection, type WalletsFile, type PersonaId } from "./_shared";

loadEnv(); // before importing app modules: chain/config reads env at import time
const DRY = process.argv.includes("--dry");
/** `--owner thabo2` seeds the same story for another owner wallet (a fresh estate: one estate per owner). */
const ownerArg = process.argv.indexOf("--owner");
const OWNER = (ownerArg > 0 ? process.argv[ownerArg + 1] : "thabo") as PersonaId;
const USDT = 1_000_000n;
/** SOL the owner needs for the accounts' rent and fees (~0.15 used); fund it from the deployer when below. */
const OWNER_MIN_SOL = 0.25;
/** Small SOL for people who may sign in the app without a sponsor (an objection's account rent is the objector's). */
const HELPER_SOL: Partial<Record<PersonaId, number>> = { zodwa: 0.03, kagiso: 0.02, priya: 0.02 };
/** Naledi's school fees: at most 3,000 USD₮ a year, like the demo site. */
const YEARLY_CAP_USDT = 3_000;
/** Same as guardTimings() in lib/service/chain-guardians.ts on a demo deployment (NEXT_PUBLIC_DEMO_WAITING_SECS set). */
const GUARD_TIMINGS = { objectionWindowSecs: 60, successionWaitSecs: 60, fallbackWaitSecs: 120 };

async function main() {
  const { DEMO_WILL } = await import("../app/src/lib/agent/canned");
  const { hashJson, sha256Hex } = await import("../app/src/lib/agent/hash");
  const { willDraftChecked, intervalSecs } = await import("../app/src/lib/agent/schemas");
  const ix = await import("../app/src/lib/chain/instructions");
  const { chainCtx } = await import("../app/src/lib/chain/client");
  const { estatePda, beneficiaryPda, payeePda, rulePda, assetPda, mediaPda, guardPda, seatPda, yearCapPda, vaultAta } = await import("../app/src/lib/chain/pda");
  const { fetchAccountRaw, fetchEstateRaw } = await import("../app/src/lib/chain/reads");
  const { num, hex, key, keyArray, enumOf } = await import("../app/src/lib/chain/decoders");
  const { publicBeneficiaryLabel, publicPayeeName } = await import("../app/src/lib/chain/public-names");
  const { decodeMedia } = await import("../app/src/lib/chain/guardians");
  const { toBase } = await import("../app/src/lib/format");
  const { DEMO_ASSETS } = await import("../app/src/lib/service/demo-asset-photos");

  const w: WalletsFile = await loadOrCreateWallets(); // adds the new personas' WDK wallets (seeds stay in the file)
  if (!w.usdtMint) throw new Error("Run scripts/devnet-setup.ts first (no test USD₮ mint yet).");
  if (process.env.NEXT_PUBLIC_USDT_MINT && process.env.NEXT_PUBLIC_USDT_MINT !== w.usdtMint) {
    throw new Error(`NEXT_PUBLIC_USDT_MINT (${process.env.NEXT_PUBLIC_USDT_MINT}) differs from the setup mint ${w.usdtMint}.`);
  }
  process.env.NEXT_PUBLIC_USDT_MINT = w.usdtMint;

  const conn = connection();
  const ctx = chainCtx();
  const A = (id: PersonaId) => new PublicKey(w.addresses[id]);
  const owner = A(OWNER);
  const estate = estatePda(ctx.programId, owner);
  const exists = async (type: string, a: PublicKey) => Boolean(await fetchAccountRaw(type, a.toBase58()));
  const sol = async (k: PublicKey) => (await conn.getBalance(k)) / LAMPORTS_PER_SOL;

  console.log(`Owner (${OWNER}) ${owner.toBase58()}: ${(await sol(owner)).toFixed(3)} SOL`);
  console.log(`Estate ${estate.toBase58()}: ${(await exists("Estate", estate)) ? "exists" : "not created yet"}`);
  for (const id of ["zodwa", "kagiso", "priya", "charity"] as const) console.log(`  ${id.padEnd(8)} ${w.addresses[id]}`);
  if (DRY) return;
  if ((await sol(owner)) < OWNER_MIN_SOL) {
    throw new Error(`Fund ${owner.toBase58()} with ~0.4 devnet SOL (from the deployer or faucet.solana.com) and re-run.`);
  }
  const me = await wdk(w, OWNER);

  // 0. SOL for the helpers, and test USD₮ for the owner (the dad is the test mint's authority).
  for (const [id, target] of Object.entries(HELPER_SOL) as [PersonaId, number][]) {
    const need = Math.round(target * LAMPORTS_PER_SOL) - (await conn.getBalance(A(id)));
    if (need > 5000) {
      const { hash } = await me.account.sendTransaction({ to: w.addresses[id], value: BigInt(need) });
      await conn.confirmTransaction(hash, "confirmed");
      log(`SOL → ${id} (${(need / LAMPORTS_PER_SOL).toFixed(3)}) ${explorer(hash)}`);
    }
  }
  const usdtMint = new PublicKey(w.usdtMint);
  const ownerUsdt = getAssociatedTokenAddressSync(usdtMint, owner);
  const vaultBal = await conn.getTokenAccountBalance(vaultAta(ctx.usdtMint, estate)).then((b) => BigInt(b.value.amount)).catch(() => 0n);
  // 20,000 for the vault + 1,000 for history and sends, on the first run only (later runs leave the vault as it is).
  const wantUsdt = vaultBal === 0n ? 21_000n * USDT : 0n;
  const haveUsdt = await conn.getTokenAccountBalance(ownerUsdt).then((b) => BigInt(b.value.amount)).catch(() => 0n);
  if (haveUsdt < wantUsdt) {
    const dad = await wdk(w, "dad");
    log(`Minted ${(wantUsdt - haveUsdt) / USDT} test USD₮ to ${OWNER} ${explorer(await send(dad, [
      createAssociatedTokenAccountIdempotentInstruction(A("dad"), ownerUsdt, owner, usdtMint),
      createMintToCheckedInstruction(usdtMint, ownerUsdt, A("dad"), wantUsdt - haveUsdt, 6),
    ]))}`);
  }

  // Buyers need enough test USD₮ for offers at the new minimums (as on the demo site: Pieter 16,000, Ayesha 15,000).
  for (const [id, target] of [["pieter", 16_000n], ["ayesha", 15_000n]] as [PersonaId, bigint][]) {
    const ata = getAssociatedTokenAddressSync(usdtMint, A(id));
    const have = await conn.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount)).catch(() => 0n);
    if (have < target * USDT) {
      log(`Minted ${(target * USDT - have) / USDT} test USD₮ to ${id} ${explorer(await send(await wdk(w, "dad"), [
        createAssociatedTokenAccountIdempotentInstruction(A("dad"), ata, A(id), usdtMint),
        createMintToCheckedInstruction(usdtMint, ata, A("dad"), target * USDT - have, 6),
      ]))}`);
    }
  }

  // 1. Estate + will (same will, verifiers and thresholds as scripts/seed-demo.ts)
  const children: Record<string, PersonaId> = { "Lerato (daughter)": "lerato", "Sipho (son)": "sipho", "Naledi (daughter)": "naledi" };
  const draft = willDraftChecked.parse({
    ...DEMO_WILL,
    beneficiaries: DEMO_WILL.beneficiaries.map((b) => ({ ...b, wallet: w.addresses[children[b.label]] })),
    verifiers: DEMO_WILL.verifiers.map((v, i) => ({ ...v, wallet: w.addresses[(["ndlovu", "pillay", "bongani"] as const)[i]] })),
  });
  const willHash = await hashJson(draft);
  const waiting = Number(process.env.NEXT_PUBLIC_DEMO_WAITING_SECS || 60);
  const est0 = await fetchAccountRaw("Estate", estate.toBase58());
  if (!est0 || hex(est0, "will_hash") !== willHash) {
    const setup = [];
    if (!est0) {
      setup.push(ix.createEstate(ctx, {
        owner, agent: A("agent"), verifiers: [A("ndlovu"), A("pillay"), A("bongani")],
        deathThreshold: 2, claimThreshold: 1, hardshipThreshold: 2, waitingPeriodSecs: waiting,
      }));
    }
    setup.push(ix.setWill(ctx, owner, willHash, `heirloom:will:${willHash.slice(0, 16)}`));
    log(`Estate ${estate.toBase58()} + will ${willHash.slice(0, 12)}… ${explorer(await send(me, setup))}`);
  } else log("Estate and will already set");

  // 2. Beneficiaries
  const benIxs = [];
  for (const [i, b] of draft.beneficiaries.entries()) {
    // Roles only on the ledger: the people's names are off-chain (lib/chain/demo-estate.ts, the estate's names).
    if (!(await exists("Beneficiary", beneficiaryPda(ctx.programId, estate, b.wallet!)))) benIxs.push(ix.addBeneficiary(ctx, owner, new PublicKey(b.wallet!), publicBeneficiaryLabel(i)));
  }
  if (benIxs.length) log(`Beneficiaries ×${benIxs.length} ${explorer(await send(me, benIxs))}`);

  // 3. Payees (approved institutions)
  const payees: [PersonaId, "University" | "Landlord" | "School", string][] = [
    ["uct", "University", "University of Cape Town"], ["residence", "Landlord", "Tugwell Residence"], ["school", "School", "Westerford High School"],
  ];
  const payeeIxs = [];
  for (const [id, kind, name] of payees) {
    if (!(await exists("Payee", payeePda(ctx.programId, estate, A(id))))) payeeIxs.push(ix.addPayee(ctx, owner, A(id), kind, publicPayeeName({ name, kind, wallet: w.addresses[id] }, new Set())));
  }
  if (payeeIxs.length) log(`Payees ×${payeeIxs.length} ${explorer(await send(me, payeeIxs))}`);

  // 4. Rules (only on a fresh estate: rule ids follow rule_count)
  let ruleId = num((await fetchAccountRaw("Estate", estate.toBase58()))!, "rule_count");
  if (ruleId === 0) {
    const byName: Record<string, PersonaId> = Object.fromEntries(payees.map(([id, , name]) => [name.toLowerCase(), id]));
    const now = Math.floor(Date.now() / 1000);
    const ruleIxs = draft.rules.map((r) => {
      const payeeId = r.recurring ? byName[r.recurring.payeeName.toLowerCase()] : undefined;
      // Never a claim rule in a schedule's place (plan §18.4 U2).
      if (r.recurring && !payeeId) throw new Error(`recurring_payee: "${r.recurring.payeeName}" is not a seeded payee.`);
      const every = r.recurring ? intervalSecs(r.recurring.every) : 0;
      return ix.addRule(ctx, owner, {
        ruleId: ruleId++, beneficiaryWallet: new PublicKey(draft.beneficiaries.find((b) => b.label === r.beneficiaryLabel)!.wallet!),
        category: r.category, allowedPayeeKind: r.allowedPayeeKind, maxPerClaim: toBase(r.maxPerClaimUsdt),
        lifetimeCap: toBase(r.lifetimeCapUsdt), validUntil: Math.floor(Date.parse(r.validUntil) / 1000), startsNow: r.startsNow,
        recurring: r.recurring && payeeId ? { amount: toBase(r.recurring.amountUsdt), intervalSecs: every, firstDue: now + every, payeeWallet: A(payeeId) } : undefined,
      });
    });
    for (let i = 0; i < ruleIxs.length; i += 2) log(`Rules ${i}-${Math.min(i + 1, ruleIxs.length - 1)} ${explorer(await send(me, ruleIxs.slice(i, i + 2)))}`);
  } else log(`Rules already present (${ruleId})`);

  // 4b. Everyday money (plan.md §13.1, "Ask for money"): Lerato's own wallet as an approved "Other" payee and an
  //     "Everyday needs" rule (General, starts now, up to 60 USD₮ a time, 720 in total), like the demo site. Added to an
  //     existing estate with add_payee + add_rule (Active), so no new estate or program upgrade is needed.
  const EVERYDAY = { maxPerClaimUsdt: 60, lifetimeCapUsdt: 720, validUntil: "2030-12-31" };
  if (!(await exists("Payee", payeePda(ctx.programId, estate, A("lerato"))))) {
    const ownWallet = publicPayeeName({ name: "", kind: "Other", wallet: w.addresses.lerato }, new Set([w.addresses.lerato]));
    log(`Payee: Lerato's own wallet ${explorer(await send(me, [ix.addPayee(ctx, owner, A("lerato"), "Other", ownWallet)]))}`);
  } else log("Lerato's own wallet is already a payee");
  const ruleCount = num((await fetchAccountRaw("Estate", estate.toBase58()))!, "rule_count");
  let hasEveryday = false;
  for (let i = 0; i < ruleCount && !hasEveryday; i++) {
    const r = await fetchAccountRaw("Rule", rulePda(ctx.programId, estate, i).toBase58());
    hasEveryday = !!r && key(r, "beneficiary") === w.addresses.lerato
      && enumOf(r, "category", ["Tuition", "Accommodation", "Books", "Medical", "General"] as const) === "General";
  }
  if (!hasEveryday) {
    log(`Rule ${ruleCount}: Lerato's everyday needs ${explorer(await send(me, [ix.addRule(ctx, owner, {
      ruleId: ruleCount, beneficiaryWallet: A("lerato"), category: "General", allowedPayeeKind: "Other",
      maxPerClaim: toBase(EVERYDAY.maxPerClaimUsdt), lifetimeCap: toBase(EVERYDAY.lifetimeCapUsdt),
      validUntil: Math.floor(Date.parse(EVERYDAY.validUntil) / 1000), startsNow: true,
    })]))}`);
  } else log("Lerato's everyday-needs rule already exists");

  // 5. Deposit
  if (vaultBal === 0n) log(`Deposit 20,000 USD₮ ${explorer(await send(me, [ix.deposit(ctx, owner, toBase(20_000))]))}`);
  else log("Vault already funded");

  // 6. The two assets: a fresh title NFT each (decimals 0, supply 1, mint authority removed), registered with the
  //    will's prices (proceeds back into the estate vault), then the media root of the bundled photos + spec sheet.
  const rentMint = await getMinimumBalanceForRentExemptMint(conn);
  const assets = [
    { field: "corollaMint" as const, demo: DEMO_ASSETS.corolla, will: draft.assets[0] },
    // Not in the will (it names one asset); same prices as the demo site's motorbike (BIKE_PRICES in lib/service/mock.ts).
    { field: "bikeMint" as const, demo: DEMO_ASSETS.mustang, will: { title: DEMO_ASSETS.mustang.title, askingPriceUsdt: 2_000, floorPriceUsdt: 1_800, hardshipFloorUsdt: 1_500 } },
  ];
  for (const a of assets) {
    if (a.will.title !== a.demo.title) throw new Error(`DEMO_WILL asset "${a.will.title}" ≠ DEMO_ASSETS "${a.demo.title}"`);
    // `thabo` keeps the original fields; other owners get their own title NFTs.
    const titles = OWNER === "thabo" ? w : ((w.titlesByOwner ??= {})[OWNER] ??= {});
    if (!titles[a.field]) {
      const mint = Keypair.generate();
      const ownerNft = getAssociatedTokenAddressSync(mint.publicKey, owner);
      const sig = await send(me, [
        SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: mint.publicKey, lamports: rentMint, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
        createInitializeMint2Instruction(mint.publicKey, 0, owner, null),
        createAssociatedTokenAccountIdempotentInstruction(owner, ownerNft, owner, mint.publicKey),
        createMintToCheckedInstruction(mint.publicKey, ownerNft, owner, 1, 0),
        createSetAuthorityInstruction(mint.publicKey, owner, AuthorityType.MintTokens, null),
      ], [mint]);
      titles[a.field] = mint.publicKey.toBase58();
      saveWallets(w);
      log(`Title NFT for the ${a.demo.title}: ${titles[a.field]} ${explorer(sig)}`);
    }
    const mint = new PublicKey(titles[a.field]!);
    const asset = assetPda(ctx.programId, estate, mint);
    if (!(await exists("Asset", asset))) {
      const docHash = await sha256Hex(`heirloom-demo:registration:${a.will.title}:${mint.toBase58()}`);
      log(`Registered the ${a.demo.title} (asset ${asset.toBase58()}) ${explorer(await send(me, [ix.registerAsset(ctx, owner, {
        nftMint: mint, floorPrice: toBase(a.will.floorPriceUsdt), hardshipFloor: toBase(a.will.hardshipFloorUsdt),
        askingPrice: toBase(a.will.askingPriceUsdt), proceedsTo: estate, docHashHex: docHash,
      })]))}`);
    }
    const media = await fetchAccountRaw("AssetMedia", mediaPda(ctx.programId, asset).toBase58());
    if (!media || decodeMedia(media).photosRoot !== a.demo.mediaRoot) {
      log(`Media root ${a.demo.mediaRoot.slice(0, 12)}… (${a.demo.photos.length} photos + spec sheet) ${explorer(await send(me, [ix.setAssetMedia(ctx, {
        authority: owner, estate, asset, kind: a.demo.kind, photosRootHex: a.demo.mediaRoot, photoCount: a.demo.photos.length,
      })]))}`);
    } else log(`Media root of the ${a.demo.title} already set`);
  }

  // 7. Guardians: the Guard, all three seats (the fallback needs every seat), Bongani's backups and monitor, the fallback plan.
  if (!(await exists("Guard", guardPda(ctx.programId, estate)))) {
    log(`Guard (objection window ${GUARD_TIMINGS.objectionWindowSecs}s) ${explorer(await send(me, [ix.initGuard(ctx, owner, estate, GUARD_TIMINGS)]))}`);
  }
  // Every seat has a monitor, and not one wallet for all three: a fallback objection takes two monitors to decide.
  const seatPlan: { index: number; backups: PersonaId[]; monitors: PersonaId[] }[] = [
    { index: 0, backups: [], monitors: ["zodwa"] },
    { index: 1, backups: [], monitors: ["priya"] },
    { index: 2, backups: ["kagiso", "priya"], monitors: ["zodwa"] },
  ];
  const seatIxs = [];
  for (const s of seatPlan) {
    const seat = await fetchAccountRaw("Seat", seatPda(ctx.programId, estate, s.index).toBase58());
    if (!seat) seatIxs.push(ix.initSeat(ctx, owner, s.index, s.backups.map(A), s.monitors.map(A)));
    // A seat seeded before every seat had a monitor gets one.
    else if (keyArray(seat, "monitors").every((m) => m === PublicKey.default.toBase58())) seatIxs.push(ix.setSeatMonitors(ctx, owner, s.index, s.monitors.map(A)));
  }
  for (let i = 0; i < seatIxs.length; i += 2) log(`Seats ×${seatIxs.slice(i, i + 2).length} ${explorer(await send(me, seatIxs.slice(i, i + 2)))}`);
  const fallback = (["lerato", "sipho", "naledi", "charity"] as const).map(A);
  const guard = await fetchAccountRaw("Guard", guardPda(ctx.programId, estate).toBase58());
  const current = ((guard?.fallback ?? []) as { toBase58(): string }[]).map((k) => k.toBase58());
  if (fallback.some((k, i) => current[i] !== k.toBase58())) {
    log(`Fallback plan (children, then the charity) ${explorer(await send(me, [ix.setFallback(ctx, owner, fallback)]))}`);
  } else log("Fallback plan already set");

  // 8. Yearly cap on Naledi's school fees.
  const snap = await fetchEstateRaw(estate.toBase58());
  const school = snap.rules.find((r) => r.category === "Tuition" && r.allowedPayeeKind === "School");
  if (!school) throw new Error("Naledi's school-fee rule is missing.");
  if (!(await exists("YearCap", yearCapPda(ctx.programId, school.address)))) {
    log(`Yearly cap ${YEARLY_CAP_USDT} USD₮ on rule #${school.id} (Naledi's school fees) ${explorer(await send(me, [ix.setYearlyCap(ctx, {
      owner, rule: new PublicKey(school.address), cap: toBase(YEARLY_CAP_USDT), periodStart: 0,
    })]))}`);
  } else log("Yearly cap already set");

  console.log(`\nGuardians demo estate ready: ${estate.toBase58()}\nhttps://explorer.solana.com/address/${estate.toBase58()}?cluster=devnet`);
  for (const a of assets) console.log(`  ${a.demo.title}: title NFT ${(OWNER === "thabo" ? w : w.titlesByOwner?.[OWNER] ?? {})[a.field]}`);
  console.log(`Owner ${OWNER} left with ${(await sol(owner)).toFixed(3)} SOL`);
}

main().then(() => disposeAll()).catch((e) => { console.error(e instanceof Error ? e.message : e); disposeAll(); process.exit(1); });
