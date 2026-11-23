/**
 * GuardiansService on Solana (docs/guardians-spec.md §3). Writes: builders in lib/chain/instructions.ts, signed by
 * the active WDK wallet through chain.ts's pay-once pipeline (fee sponsored where the policy allows). The agent's
 * death-certificate reviews go through /api/review (purposes seat-death / fallback-death).
 *
 * Off-chain extras: people's display names go to the estate meta (`buyerNames` doubles as the names-by-wallet map);
 * objection reasons and fallback kinds are kept on this device (only the reason's hash is on-chain).
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import type { AgentReport, Base58, Claim, Estate } from "../types";
import type { AssetMediaInfo, FallbackRecipient, GuardiansService, GuardiansSnapshot } from "../guardians/types";
import { chainConfig } from "../chain/config";
import { DEVNET_DEMO_ESTATE, DEVNET_DEMO_FALLBACK_KINDS } from "../chain/demo-estate";
import type { TxResult } from "./types";
import type { EstateMeta } from "../db";
import { chainCtx } from "../chain/client";
import * as ix from "../chain/instructions";
import { beneficiaryPda, fallbackReportPda, guardPda, seatPda } from "../chain/pda";
import { decodeScanned, fetchAccountRaw, scanAccounts, type ChainEvent } from "../chain/reads";
import { assembleGuardians, decodeMedia, disabledGuardians, fallbackSlot, fetchGuardiansRaw, nextFallback, type GuardianExtras } from "../chain/guardians";
import { bool, enumOf, key, keyArray, num, str, waitingOf, type Raw } from "../chain/decoders";
import { eligibleSeats, recoveryTimeout } from "../death-rules";
import { ChainServiceError, must } from "./chain-errors";
import { confirmableFrom, fallbackReportStep, seatReportStep } from "./chain-reports";
import { getActiveSigner } from "../wallet/signer";
import { sha256Hex } from "../agent/hash";
import { cleanSpec, foreignSpecKeys, mediaRootHex } from "../assets/spec";
import { MAX_PHOTOS } from "../media/webp";
import { photosApi } from "../media/client";
import { requireEvidence } from "../evidence";
import { saveReason } from "../disputes/reasons-client";

export const DISABLED_GUARDIANS: GuardiansSnapshot = disabledGuardians();

type Ixs = TransactionInstruction[] | ((feePayer: PublicKey) => TransactionInstruction[]);
type ReviewPurpose = "seat-death" | "fallback-death";

export interface ChainGuardianDeps {
  send(ixs: Ixs): Promise<TxResult>;
  /** `tx`: the agent's review transaction. */
  review(file: File, purpose: ReviewPurpose, estate: Base58, context: string, index: number): Promise<{ report: AgentReport; tx?: TxResult | null }>;
  getMeta(estate: Base58): Promise<EstateMeta | null>;
  saveMeta(meta: EstateMeta): Promise<void>;
  /** The real names, for changing and saving back (chain.ts). */
  getMetaForWrite?(estate: Base58): Promise<EstateMeta | null>;
  requireOwnerOf(estate: Base58): PublicKey;
  /** chain.ts getEstate (its snapshot carries `guardians`). */
  getEstate(estate: Base58): Promise<{ guardians?: GuardiansSnapshot }>;
}

/** Off-chain extras for the guardians view: names from the estate meta and this device, reasons and kinds from this device. */
export function guardianExtras(meta: EstateMeta | null, reports: Record<string, AgentReport>, shared: Record<string, string> = {}): GuardianExtras {
  const l = local();
  // The seeded devnet demo estate's fallback kinds (children, then a charity); this device's choices win.
  const demoKinds = meta?.estate === DEVNET_DEMO_ESTATE && chainConfig.cluster !== "mainnet-beta" ? DEVNET_DEMO_FALLBACK_KINDS : {};
  return { names: { ...l.names, ...(meta?.buyerNames ?? {}) }, reasons: { ...shared, ...l.reasons }, fallbackKinds: { ...demoKinds, ...l.fallbackKinds }, reports };
}

/** The guardians view of an estate from its already-loaded pieces (used by chain.ts getEstate). */
export async function loadGuardians(estate: Base58, base: { estate: Estate; claims: Claim[]; events: ChainEvent[] }, extras: GuardianExtras): Promise<GuardiansSnapshot> {
  return assembleGuardians(await fetchGuardiansRaw(estate), { ...base, extras });
}

const pk = (a: string) => new PublicKey(a);
const DEFAULT_KEY = PublicKey.default.toBase58();
const now = () => Math.floor(Date.now() / 1000);

/**
 * Who watches a seat the owner set up without choosing a monitor: someone in the family, never the holder or the
 * backup who would take the seat, rather not a trusted person, and spread over the seats (plan §18.8). Without a
 * monitor a last holder's death needs the beneficiary route (R18) and the fallback plan has nobody to vote.
 */
export function defaultMonitor(index: number, p: { holder: Base58; backups: Base58[]; family: Base58[]; verifiers: Base58[]; owner: Base58 }): Base58 | null {
  const able = p.family.filter((w) => w !== p.holder && w !== p.backups[0] && w !== p.owner);
  const outside = able.filter((w) => !p.verifiers.includes(w));
  const pool = outside.length ? outside : able;
  return pool.length ? pool[index % pool.length] : null;
}
const DEMO_WAIT = Number(process.env.NEXT_PUBLIC_DEMO_WAITING_SECS ?? "");
/** Demo deployments (NEXT_PUBLIC_DEMO_WAITING_SECS set) get the short demo timings; real estates 2 days / 7 days / 90 days. */
export const guardTimings = () => Number.isFinite(DEMO_WAIT) && DEMO_WAIT >= 0
  ? { objectionWindowSecs: 60, successionWaitSecs: 60, fallbackWaitSecs: 120 }
  : { objectionWindowSecs: 2 * 86_400, successionWaitSecs: 7 * 86_400, fallbackWaitSecs: 90 * 86_400 };

/* ---------- device-local extras ---------- */

const LOCAL_KEY = "heirloom.guardians.extras.v1";
type Local = { reasons: Record<string, string>; fallbackKinds: Record<Base58, FallbackRecipient["kind"]>; names: Record<Base58, string> };
function local(): Local {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(LOCAL_KEY) : null;
    if (raw) return { reasons: {}, fallbackKinds: {}, names: {}, ...(JSON.parse(raw) as Partial<Local>) };
  } catch { /* storage blocked */ }
  return { reasons: {}, fallbackKinds: {}, names: {} };
}
function saveLocal(update: (l: Local) => void) {
  const l = local();
  update(l);
  try { if (typeof window !== "undefined") window.localStorage.setItem(LOCAL_KEY, JSON.stringify(l)); } catch { /* ignore */ }
}

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const TARGET_KINDS = ["Claim", "Unlock", "Sale", "Hardship", "Succession", "Fallback"] as const;

export function createChainGuardians(d: ChainGuardianDeps): GuardiansService {
  const me = () => pk(getActiveSigner().address);

  const extras = async (estate: Base58, reports: Record<string, AgentReport>) => guardianExtras(await d.getMeta(estate), reports);
  const snapshot = async (estate: Base58): Promise<GuardiansSnapshot> => (await d.getEstate(estate)).guardians ?? disabledGuardians();

  /** Names entered by the owner: kept in the estate meta (and on this device, in case the meta is unavailable). */
  async function rememberNames(estate: Base58, people: { wallet: Base58; name: string }[]) {
    const named = people.filter((p) => p.name);
    if (!named.length) return;
    saveLocal((l) => { for (const p of named) l.names[p.wallet] = p.name; });
    const meta = await (d.getMetaForWrite ?? d.getMeta)(estate);
    if (meta) await d.saveMeta({ ...meta, buyerNames: { ...meta.buyerNames, ...Object.fromEntries(named.map((p) => [p.wallet, p.name.slice(0, 64)])) } }).catch(() => undefined);
  }

  const guardRaw = (estate: Base58) => fetchAccountRaw("Guard", guardPda(chainCtx().programId, estate).toBase58());
  const seatRaw = (estate: Base58, i: number) => fetchAccountRaw("Seat", seatPda(chainCtx().programId, estate, i).toBase58());
  const nameOf = async (estate: Base58, wallet: Base58) => (await extras(estate, {})).names[wallet] ?? "the person named";
  /** Index of the first seat whose monitors include `wallet`, or null. */
  async function monitoredSeat(estate: Base58, wallet: PublicKey): Promise<number | null> {
    const raw = await fetchGuardiansRaw(estate);
    const s = raw.seats.find((x) => keyArray(x.raw, "monitors").includes(wallet.toBase58()));
    return s ? num(s.raw, "index") : null;
  }

  async function estateRaw(estate: Base58): Promise<Raw> {
    const e = await fetchAccountRaw("Estate", estate);
    must(e, "NoEstate", "That estate was not found on-chain.");
    return e;
  }

  async function activeBeneficiary(estate: Base58, wallet: PublicKey): Promise<boolean> {
    const b = await fetchAccountRaw("Beneficiary", beneficiaryPda(chainCtx().programId, estate, wallet).toBase58());
    return !!b && bool(b, "active");
  }

  /** The accounts that show the signer takes part in a fallback report: none for trusted people and listed recipients. */
  async function participantAccounts(estate: Base58, e: Raw, guard: Raw, who: PublicKey): Promise<ix.ActingAs> {
    const me58 = who.toBase58();
    if (keyArray(e, "verifiers").includes(me58)) return {};
    const monitorSeat = await monitoredSeat(estate, who);
    if (monitorSeat !== null) return { monitorSeat };
    if (await activeBeneficiary(estate, who)) return { beneficiary: true };
    const dead = num(guard, "fallback_dead");
    must(keyArray(guard, "fallback").some((w, i) => w === me58 && (dead & (1 << i)) === 0),
      "NotParticipant", "Only the trusted people, their monitors, the family and the people on the fallback list can do this.");
    return {};
  }

  /** The active family, in a fixed order. */
  async function familyOf(estate: Base58): Promise<Base58[]> {
    const rows = (await scanAccounts("Beneficiary", [{ offset: 8, key: pk(estate) }])).map((a) => decodeScanned("Beneficiary", a));
    return rows.filter((b) => bool(b, "active"))
      .sort((a, b) => str(a, "label").localeCompare(str(b, "label"), "en", { numeric: true }) || key(a, "wallet").localeCompare(key(b, "wallet")))
      .map((b) => key(b, "wallet"));
  }

  return {
    getGuardians: snapshot,

    async setupGuardians(estate, input) {
      const owner = d.requireOwnerOf(estate);
      const ctx = chainCtx();
      const estateKey = pk(estate);
      await rememberNames(estate, [...input.seats.flatMap((s) => [...s.backups, ...s.monitors]), ...input.fallback]);
      saveLocal((l) => { for (const r of input.fallback) l.fallbackKinds[r.wallet] = r.kind; });
      const txs: TxResult[] = [];
      if (!(await guardRaw(estate))) txs.push(await d.send([ix.initGuard(ctx, owner, estateKey, guardTimings())]));
      const seatIxs: TransactionInstruction[] = [];
      let known: { verifiers: Base58[]; family: Base58[] } | null = null;
      for (const i of [0, 1, 2]) {
        // Every seat must exist (the fallback checks all three), so seats the owner did not list are created empty.
        const s = input.seats.find((x) => x.index === i);
        const backups = (s?.backups ?? []).map((b) => pk(b.wallet));
        const monitors = (s?.monitors ?? []).map((m) => pk(m.wallet));
        if (!(await seatRaw(estate, i))) {
          if (!monitors.length) {
            known ??= { verifiers: keyArray(await estateRaw(estate), "verifiers"), family: await familyOf(estate) };
            const watcher = defaultMonitor(i, {
              holder: known.verifiers[i], backups: backups.map((b) => b.toBase58()), family: known.family, verifiers: known.verifiers, owner: owner.toBase58(),
            });
            if (watcher) monitors.push(pk(watcher));
          }
          seatIxs.push(ix.initSeat(ctx, owner, i, backups, monitors));
        } else if (s) seatIxs.push(ix.setSeatBackups(ctx, owner, estateKey, i, backups), ix.setSeatMonitors(ctx, owner, i, monitors));
      }
      for (const group of chunk(seatIxs, 2)) txs.push(await d.send(group));
      if (input.fallback.length) txs.push(await d.send([ix.setFallback(ctx, owner, input.fallback.map((r) => pk(r.wallet)))]));
      return txs;
    },

    async setSeatBackups(estate, index, backups) {
      await rememberNames(estate, backups);
      return d.send([ix.setSeatBackups(chainCtx(), me(), pk(estate), index, backups.map((b) => pk(b.wallet)))]);
    },

    async setSeatMonitors(estate, index, monitors) {
      const owner = d.requireOwnerOf(estate);
      await rememberNames(estate, monitors);
      return d.send([ix.setSeatMonitors(chainCtx(), owner, index, monitors.map((m) => pk(m.wallet)))]);
    },

    async setFallback(estate, recipients) {
      const owner = d.requireOwnerOf(estate);
      await rememberNames(estate, recipients);
      saveLocal((l) => { for (const r of recipients) l.fallbackKinds[r.wallet] = r.kind; });
      return d.send([ix.setFallback(chainCtx(), owner, recipients.map((r) => pk(r.wallet)))]);
    },

    async reportSeatDeath(estate, index, chosen) {
      const certificate = await requireEvidence(chosen);
      const seat = await seatRaw(estate, index);
      if (!seat) throw new Error("This trusted person's seat is not set up.");
      const holder = key(seat, "holder");
      const h = await sha256Hex(new Uint8Array(await certificate.arrayBuffer()));
      const reporter = me();
      const who = reporter.toBase58();
      const e = await estateRaw(estate);
      let tx: TxResult | null = null;
      if (seatReportStep(e, seat, who, h, now()) === "send") {
        const named = key(e, "owner") === who
          || [...keyArray(e, "verifiers"), ...keyArray(seat, "monitors"), ...keyArray(seat, "backups")].includes(who);
        const beneficiary = !named && (await activeBeneficiary(estate, reporter));
        tx = await d.send([ix.reportSeatDeath(chainCtx(), reporter, pk(estate), index, h, { beneficiary })]);
      }
      const person = await nameOf(estate, holder);
      const r = await d.review(certificate, "seat-death", estate,
        `Trusted person whose death is reported: ${person} (seat ${index + 1}, wallet ${holder}). This is not the estate owner.`, index);
      return { tx: tx ?? r.tx ?? null, report: r.report };
    },
    async ownerReplaceSeat(estate, index, newHolder) {
      const owner = d.requireOwnerOf(estate);
      const wallet = newHolder.wallet.trim();
      let holder: PublicKey;
      try { holder = pk(wallet); } catch { throw new Error("InvalidAddress: that is not a Solana wallet address."); }
      // The name goes off-chain first: the snapshot shows it for this seat once generation > 0.
      await rememberNames(estate, [{ wallet, name: newHolder.name.trim() }]);
      return d.send([ix.ownerReplaceSeat(chainCtx(), owner, index, holder)]);
    },

    async confirmSeatDeath(estate, index) {
      const confirmer = me();
      const seat = await seatRaw(estate, index);
      must(seat, "NoSuccessionPending", "This trusted person's seat is not set up.");
      const holder = key(seat, "holder");
      const e = await estateRaw(estate);
      const verifiers = keyArray(e, "verifiers");
      // An active beneficiary who holds no seat passes their account when the program lets them confirm: nobody else
      // holds a seat and nobody watches this one (a monitor other than the first backup, or a second backup), or the
      // approved report has waited the recovery timeout.
      const backups = keyArray(seat, "backups");
      const watched = keyArray(seat, "monitors").some((m) => m !== DEFAULT_KEY && m !== backups[0]) || backups[1] !== DEFAULT_KEY;
      const timedOut = now() >= num(seat, "death_pending_since") + recoveryTimeout(waitingOf(e));
      const mayConfirm = (!eligibleSeats(verifiers, holder).length && !watched) || timedOut;
      const beneficiary = !verifiers.includes(confirmer.toBase58()) && mayConfirm && (await activeBeneficiary(estate, confirmer));
      return d.send([ix.confirmSeatDeath(chainCtx(), confirmer, pk(estate), index, { beneficiary })]);
    },
    vetoSeatDeath: (estate, index) => d.send([ix.vetoSeatDeath(chainCtx(), me(), pk(estate), index)]),
    async finalizeSuccession(estate, index) {
      const seat = await seatRaw(estate, index);
      must(seat, "NoSuccessionPending", "This trusted person's seat is not set up.");
      return d.send([ix.finalizeSuccession(chainCtx(), pk(estate), index, me())]);
    },

    async raiseObjection(estate, input) {
      const objector = me();
      const reason = input.reason.trim();
      if (!reason) throw new Error("Write a short reason.");
      const reasonHashHex = await sha256Hex(reason);
      saveLocal((l) => { l.reasons[reasonHashHex] = reason; });
      const seatSpecific = input.kind !== "Unlock" && input.kind !== "Fallback";
      const monitorSeat = seatSpecific ? input.seatIndex : await monitoredSeat(estate, objector);
      let hardshipAsset: PublicKey | undefined;
      if (input.kind === "Hardship") {
        const h = await fetchAccountRaw("Hardship", input.target);
        if (!h) throw new Error("That request was not found.");
        hardshipAsset = pk(key(h, "asset"));
      }
      const tx = await d.send([ix.raiseObjection(chainCtx(), {
        objector, estate: pk(estate), kind: input.kind, target: pk(input.target), seatIndex: seatSpecific ? input.seatIndex : null,
        reasonHashHex, monitorSeat, beneficiary: input.kind === "Fallback" && monitorSeat === null, hardshipAsset,
      })]);
      // Once it is on-chain, the words go where the people who vote can read them (M9); this device keeps its copy.
      await saveReason(getActiveSigner(), estate, input.target, reason).catch((e: unknown) => console.warn(`The reason was kept on this device only: ${(e as Error).message}`));
      return tx;
    },

    async voteObjection(estate, objection, uphold) {
      const o = await fetchAccountRaw("Objection", objection);
      if (!o) throw new Error("That objection was not found.");
      const kind = enumOf(o, "kind", TARGET_KINDS);
      const target = key(o, "target");
      const voter = me();
      let hardshipAsset: PublicKey | undefined;
      if (kind === "Hardship") {
        const h = await fetchAccountRaw("Hardship", target);
        if (h) hardshipAsset = pk(key(h, "asset"));
      }
      return d.send([ix.voteObjection(chainCtx(), { voter, estate: pk(estate), kind, target: pk(target), uphold, hardshipAsset })]);
    },

    async reportFallbackDeath(estate, recipientIndex, chosen) {
      const certificate = await requireEvidence(chosen);
      const g = await guardRaw(estate);
      if (!g) throw new Error("This estate has no fallback plan.");
      // The screens' position is not the slot when the list has a gap.
      const slot = fallbackSlot(g, recipientIndex);
      const wallet = slot < 0 ? null : keyArray(g, "fallback")[slot];
      if (!wallet) throw new Error("That fallback recipient does not exist.");
      const reporter = me();
      must(reporter.toBase58() !== wallet, "NotParticipant", "You can't report your own passing.");
      const h = await sha256Hex(new Uint8Array(await certificate.arrayBuffer()));
      const ctx = chainCtx();
      const [e, standing] = await Promise.all([
        estateRaw(estate), fetchAccountRaw("FallbackReport", fallbackReportPda(ctx.programId, estate, slot).toBase58()),
      ]);
      let tx: TxResult | null = null;
      if (fallbackReportStep(e, g, slot, standing, reporter.toBase58(), h, now()) === "send") {
        const as = await participantAccounts(estate, e, g, reporter);
        tx = await d.send([ix.reportFallbackDeath(ctx, reporter, pk(estate), slot, h, as)]);
      }
      const person = await nameOf(estate, wallet);
      const r = await d.review(certificate, "fallback-death", estate,
        `Fallback recipient whose death is reported: ${person} (wallet ${wallet}). This is not the estate owner.`, slot);
      return { tx: tx ?? r.tx ?? null, report: r.report };
    },

    async resolveFallbackDeath(estate, recipientIndex, dead) {
      const guard = await guardRaw(estate);
      must(guard, "NoFallbackRecipient", "This estate has no fallback plan.");
      const ctx = chainCtx();
      const index = fallbackSlot(guard, recipientIndex);
      must(index >= 0, "NoFallbackRecipient", "That fallback recipient does not exist.");
      const report = await fetchAccountRaw("FallbackReport", fallbackReportPda(ctx.programId, estate, index).toBase58());
      must(report, "BadStatus", "There is no open report about this person.");
      const signer = me();
      const who = signer.toBase58();
      let as: ix.ActingAs = {};
      if (!dead) {
        must(key(report, "recipient") === who, "NotParticipant", "Only the person who was reported can say they are alive.");
      } else {
        must(enumOf(report, "verdict", ["Pending", "Approved"] as const) === "Approved", "AgentNotApproved", "The agent has not cleared this certificate.");
        must(key(report, "reporter") !== who && key(report, "recipient") !== who, "NotConfirmer", "A second person has to confirm this.");
        const from = confirmableFrom(guard, report);
        if (now() < from) throw new ChainServiceError("WaitingPeriodNotOver", "They still have time to say they are alive.", from);
        as = await participantAccounts(estate, await estateRaw(estate), guard, signer);
      }
      const rentTo = pk(key(report, "rent_payer"));
      return d.send([ix.resolveFallbackDeath(ctx, { signer, estate: pk(estate), index, dead, rentTo, as })]);
    },

    startFallback: (estate) => d.send([ix.startFallback(chainCtx(), pk(estate), me())]),
    lapseObjection: (estate) => d.send([ix.lapseObjection(chainCtx(), pk(estate), me())]),

    async executeFallback(estate) {
      const g = await guardRaw(estate);
      if (!g) throw new Error("This estate has no fallback plan.");
      const next = nextFallback(g);
      if (!next.wallet) throw new Error("Every fallback recipient has passed away.");
      return d.send([ix.executeFallback(chainCtx(), { payer: me(), estate: pk(estate), recipient: pk(next.wallet), recipientIndex: next.index })]);
    },

    async getAssetMedia(estate) {
      const [listed, raw] = await Promise.all([photosApi.list(estate).catch(() => []), fetchGuardiansRaw(estate)]);
      const out: AssetMediaInfo[] = await Promise.all(listed.map(async (m) => {
        const onChain = raw.media[m.asset];
        if (!onChain) return { ...m };
        const root = await mediaRootHex(m.photos, cleanSpec(m.spec));
        return { ...m, onChainMatch: decodeMedia(onChain).photosRoot === root };
      }));
      // Devnet without a photo server: the bundled demo photos for assets whose on-chain root is a demo root.
      const missing = Object.entries(raw.media).filter(([asset]) => !out.some((m) => m.asset === asset));
      if (missing.length && chainConfig.cluster !== "mainnet-beta") {
        const { bundledDemoMedia } = await import("./demo-media");
        out.push(...bundledDemoMedia(missing.map(([asset, r]) => ({ asset, ...decodeMedia(r) })), chainConfig.cluster));
      }
      return out;
    },

    async setAssetMedia(estate, asset, input) {
      if (input.photos.length > MAX_PHOTOS) throw new Error(`Add at most ${MAX_PHOTOS} photos.`);
      // The spec schema (zod) loads when photos or a spec sheet are saved, not with the service on every first visit.
      const { parseSpec } = await import("../assets/spec-schema");
      if (foreignSpecKeys(input.kind, parseSpec(input.spec)).length) throw new Error("Some details do not belong on this kind of asset.");
      const root = await mediaRootHex(input.photos, parseSpec(input.spec));
      const owner = d.requireOwnerOf(estate);
      // R22: what buyers see is the living owner's. Nobody changes it after the unlock, the agent never.
      must(enumOf(await estateRaw(estate), "status", ["Active", "DeathPending", "Unlocked", "Frozen"] as const) === "Active",
        "BadStatus", "Only the living owner changes an asset's photos, while the plan is active.");
      return d.send([ix.setAssetMedia(chainCtx(), {
        authority: owner, estate: pk(estate), asset: pk(asset), kind: input.kind, photosRootHex: root, photoCount: input.photos.length,
      })]);
    },
  };
}

/** The owner's device keeps the family's names too: they are never on-chain, and the server may not keep them. */
export function rememberOnDevice(names: Record<string, string>): void {
  saveLocal((l) => { Object.assign(l.names, names); });
}
