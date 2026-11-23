/**
 * Letters for later (plan.md §16.11): Naledi's 500 USD₮ 18th-birthday gift on the seeded devnet demo estate, so her
 * letter "For your 18th birthday" opens with a real payment from the plan, like on the demo site.
 *
 *   1. add_payee: Naledi's own wallet as an approved "Other" payee (on the ledger a role, never her name), unless it
 *      already is one;
 *   2. add_rule:  General, Other, starts now, 500 USD₮ once (recurring 500 every year, lifetime cap 500), first due
 *                 14 Aug 2029 at 00:00 SAST, valid until 31 Dec 2030, paid to Naledi's own wallet.
 * Signed by the owner persona's Tether WDK wallet (`--owner thabo2` by default: the estate the app opens). No program
 * change. Idempotent: it checks the chain first and skips what exists. About 0.003 SOL of rent and fees.
 *
 * DRY RUN BY DEFAULT: it prints what it would send and sends nothing. Add `--send` to send the transactions.
 * Until this runs, the devnet letter falls back to opening on her birthday (lib/letters/server/demo-letters.ts).
 *
 * Run from app/ with the devnet env loaded (Git Bash):
 *   set -a; . ../scripts/.env.devnet; set +a
 *   npx tsx --tsconfig ../scripts/tsconfig.json ../scripts/seed-letter-gift.ts [--owner thabo2] [--send]
 */
import { existsSync, readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { loadEnv, wdk, send, explorer, log, disposeAll, connection, WALLETS_FILE, type WalletsFile, type PersonaId } from "./_shared";

loadEnv(); // before importing app modules: chain/config reads env at import time
const SEND = process.argv.includes("--send");
const ownerArg = process.argv.indexOf("--owner");
const OWNER = (ownerArg > 0 ? process.argv[ownerArg + 1] : "thabo2") as PersonaId;

/** The gift, as on the demo site (lib/service/mock.ts addNalediGift). */
const NALEDI_GIFT = {
  amountUsdt: 500,
  lifetimeCapUsdt: 500,
  /** 14 Aug 2029, 00:00 SAST (UTC+2). */
  firstDue: Date.UTC(2029, 7, 13, 22) / 1000,
  intervalSecs: 365 * 86_400,
  /** To the end of 31 Dec 2030 (SAST). */
  validUntil: Date.UTC(2030, 11, 31, 22) / 1000,
};

async function main() {
  const ix = await import("../app/src/lib/chain/instructions");
  const { chainCtx } = await import("../app/src/lib/chain/client");
  const { estatePda, payeePda, rulePda } = await import("../app/src/lib/chain/pda");
  const { fetchAccountRaw } = await import("../app/src/lib/chain/reads");
  const { num, key, big, enumOf } = await import("../app/src/lib/chain/decoders");
  const { toBase } = await import("../app/src/lib/format");
  const { publicPayeeName } = await import("../app/src/lib/chain/public-names");

  // Never creates wallets: the demo personas must already exist (scripts/.demo-wallets.json, git-ignored).
  if (!existsSync(WALLETS_FILE)) throw new Error("scripts/.demo-wallets.json not found: run this from the checkout that seeded the devnet demo.");
  const w = JSON.parse(readFileSync(WALLETS_FILE, "utf8")) as WalletsFile;
  if (!w.addresses?.[OWNER] || !w.addresses.naledi) throw new Error(`No wallet for ${OWNER} or naledi in scripts/.demo-wallets.json.`);
  if (w.usdtMint) process.env.NEXT_PUBLIC_USDT_MINT ??= w.usdtMint;
  const ctx = chainCtx();
  const owner = new PublicKey(w.addresses[OWNER]);
  const naledi = new PublicKey(w.addresses.naledi);
  const estate = estatePda(ctx.programId, owner);
  const estateRaw = await fetchAccountRaw("Estate", estate.toBase58());
  if (!estateRaw) throw new Error(`No estate for ${OWNER} (${owner.toBase58()}).`);
  const status = enumOf(estateRaw, "status", ["Active", "DeathPending", "Unlocked", "Frozen"] as const);
  console.log(`Owner (${OWNER}) ${owner.toBase58()}, estate ${estate.toBase58()} (${status})`);
  console.log(`Naledi ${naledi.toBase58()}`);
  if (status !== "Active") throw new Error("add_payee and add_rule need an Active estate.");

  const payeeExists = !!(await fetchAccountRaw("Payee", payeePda(ctx.programId, estate, naledi).toBase58()));
  const ruleCount = num(estateRaw, "rule_count");
  let existing: number | null = null;
  for (let i = 0; i < ruleCount && existing === null; i++) {
    const r = await fetchAccountRaw("Rule", rulePda(ctx.programId, estate, i).toBase58());
    if (r && key(r, "beneficiary") === naledi.toBase58() && big(r, "recurring_amount") === toBase(NALEDI_GIFT.amountUsdt)) existing = i;
  }

  const plan: { what: string; ixs: ReturnType<typeof ix.addPayee>[] }[] = [];
  if (!payeeExists) {
    const label = publicPayeeName({ name: "", kind: "Other", wallet: naledi.toBase58() }, new Set([naledi.toBase58()]));
    plan.push({ what: `add_payee: Naledi's own wallet (Other, "${label}")`, ixs: [ix.addPayee(ctx, owner, naledi, "Other", label)] });
  }
  else console.log("Naledi's own wallet is already a payee.");
  if (existing === null) {
    plan.push({
      what: `add_rule ${ruleCount}: General, Other, starts now, 500 USD₮ to Naledi, first due 2029-08-14 00:00 SAST, cap 500, valid until 2030-12-31`,
      ixs: [ix.addRule(ctx, owner, {
        ruleId: ruleCount, beneficiaryWallet: naledi, category: "General", allowedPayeeKind: "Other",
        maxPerClaim: toBase(NALEDI_GIFT.amountUsdt), lifetimeCap: toBase(NALEDI_GIFT.lifetimeCapUsdt), validUntil: NALEDI_GIFT.validUntil, startsNow: true,
        recurring: { amount: toBase(NALEDI_GIFT.amountUsdt), intervalSecs: NALEDI_GIFT.intervalSecs, firstDue: NALEDI_GIFT.firstDue, payeeWallet: naledi },
      })],
    });
  } else console.log(`Naledi's 500 USD₮ gift rule already exists (rule ${existing}).`);

  if (!plan.length) { console.log("Nothing to do."); return; }
  for (const p of plan) console.log(`${SEND ? "Sending" : "Would send"}: ${p.what}`);
  if (!SEND) { console.log("Dry run: nothing was sent. Add --send to send these transactions."); return; }

  const sol = (await connection().getBalance(owner)) / 1e9;
  if (sol < 0.01) throw new Error(`Fund ${owner.toBase58()} with a little devnet SOL first (has ${sol.toFixed(4)}).`);
  const me = await wdk(w, OWNER);
  for (const p of plan) log(`${p.what} ${explorer(await send(me, p.ixs))}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => disposeAll());
