/**
 * Guardians read side (docs/guardians-spec.md §2): decode Guard / Seat / Objection / ApprovalStamp / AssetMedia
 * accounts and the SeatApproval events into the GuardiansSnapshot the UI uses. Decoding and assembly are pure;
 * fetchGuardiansRaw does the RPC (one shared program scan, see reads.ts).
 */
import { PublicKey, type Connection } from "@solana/web3.js";
import type { AgentReport, Base58, Claim, Estate } from "../types";
import type { AssetKind, FallbackDeathReport, FallbackRecipient, GuardiansSnapshot, Objection, ObjectionStatus, Seat, SeatApprovalItem, TargetKind } from "../guardians/types";
import { eligibleSeats, MIN_WAIT_SECS, quorum, refuteWait, unlockWaitSecs } from "../death-rules";
import { openToPeople } from "../verdict";
import { formatUsdt, shortAddress } from "../format";
import { accountName, getCoder, getIdl } from "./idl";
import { bits, bool, enumOf, hex, key, keyArray, num, type Raw } from "./decoders";
import { guardPda } from "./pda";
import { scanAccounts, standingReviewHash, type ChainEvent } from "./reads";
import { getConnection } from "./tx";
import { disputeLapsesAt, objectionLapsesAt } from "../disputes/types";

const DEFAULT_KEY = "11111111111111111111111111111111";
/** Byte offsets of Seat.monitors[0] and [1] (8 discriminator + 32 estate + 1 index + 32 holder + 2×32 backups). */
export const SEAT_MONITOR_OFFSETS = [137, 169] as const;
/** Seat.backups[0] and [1] (8 discriminator + 32 estate + 1 index + 32 holder). */
export const SEAT_BACKUP_OFFSETS = [73, 105] as const;
/** Guard.fallback[0..4] (8 discriminator + 32 estate + 3×8 waits + 2 open objections). */
export const GUARD_FALLBACK_OFFSETS = [66, 98, 130, 162] as const;
const ZERO_HASH = "0".repeat(64);
const NO_SEAT = 255;
const DISPUTE_SEAT = 254;
const TARGET_KIND = ["Claim", "Unlock", "Sale", "Hardship", "Succession", "Fallback"] as const satisfies readonly TargetKind[];
const OBJECTION_STATUS = ["Open", "Upheld", "Dismissed"] as const satisfies readonly ObjectionStatus[];
const ASSET_KIND = ["Car", "Motorbike", "Furniture", "Jewellery", "Electronics", "Other"] as const satisfies readonly AssetKind[];
const VERDICT = ["Pending", "Approved", "Rejected"] as const;

const set = (k: string) => !!k && k !== DEFAULT_KEY;
/** state.rs MAX_GUARD_WAIT_SECS: older guards are clamped when read. */
const MAX_GUARD_WAIT = 180 * 86_400;
const guardWait = (g: Raw, name: string) => Math.min(MAX_GUARD_WAIT, Math.max(0, num(g, name)));

/** The Guard's first living fallback slot and who is in it; 255 and null when nobody is left (or no list was set). */
export function nextFallback(guard: Raw | null): { index: number; wallet: Base58 | null } {
  if (guard) {
    const dead = num(guard, "fallback_dead");
    const list = keyArray(guard, "fallback");
    const index = list.findIndex((w, i) => set(w) && (dead & (1 << i)) === 0);
    if (index >= 0) return { index, wallet: list[index] };
  }
  return { index: NO_SEAT, wallet: null };
}

/**
 * The on-chain slot of the `position`th recipient on screen: the screens list only the slots that are set, so a list
 * with a gap would otherwise name the wrong person. -1 when there is none.
 */
export function fallbackSlot(guard: Raw, position: number): number {
  return keyArray(guard, "fallback").map((w, i) => (set(w) ? i : -1)).filter((i) => i >= 0)[position] ?? -1;
}
const countBits = (m: number) => bits(m, 8).filter(Boolean).length;

/** Off-chain extras: display names by wallet, objection reasons by hash, fallback kinds by wallet, agent reports by hash. */
export interface GuardianExtras {
  names: Record<Base58, string>;
  reasons: Record<string, string>;
  fallbackKinds: Record<Base58, FallbackRecipient["kind"]>;
  reports: Record<string, AgentReport>;
}

export interface RawGuardians {
  guard: { address: Base58; raw: Raw } | null;
  seats: { address: Base58; raw: Raw }[];
  objections: { address: Base58; raw: Raw }[];
  /** claim address → ApprovalStamp */
  stamps: Record<Base58, Raw>;
  /** asset address → AssetMedia */
  media: Record<Base58, Raw>;
  /** Open fallback death reports. */
  fallbackReports?: Raw[];
}

const EMPTY: RawGuardians = { guard: null, seats: [], objections: [], stamps: {}, media: {} };

function decode(type: string, data: Uint8Array): Raw {
  return getCoder().accounts.decode(accountName(type), data as Parameters<ReturnType<typeof getCoder>["accounts"]["decode"]>[1]) as Raw;
}

const hasAccount = (name: string) => !!getIdl().accounts?.some((a) => a.name.toLowerCase() === name.toLowerCase());

/** Every guardians account of one estate. Older IDLs (no Guard account type) give an empty result. */
export async function fetchGuardiansRaw(estate: Base58, conn: Connection = getConnection()): Promise<RawGuardians> {
  if (!hasAccount("Guard")) return EMPTY;
  const programId = new PublicKey(getIdl().address);
  const estateKey = new PublicKey(estate);
  const guardAddr = guardPda(programId, estateKey);
  const children = async (type: string) =>
    (await scanAccounts(type, [{ offset: 8, key: estateKey }], conn)).map((a) => ({ address: a.pubkey.toBase58(), raw: decode(type, a.data) }));
  const [guards, seats, objections, reports, stampsAll, mediaAll] = await Promise.all([
    scanAccounts("Guard", [{ offset: 8, key: estateKey }], conn),
    children("Seat"),
    children("Objection"),
    children("FallbackReport"),
    scanAccounts("ApprovalStamp", [], conn),
    scanAccounts("AssetMedia", [], conn),
  ]);
  const g = guards.find((a) => a.pubkey.equals(guardAddr));
  const byTarget = (list: typeof stampsAll, type: string) =>
    Object.fromEntries(list.map((a) => [new PublicKey(a.data.subarray(8, 40)).toBase58(), decode(type, a.data)]));
  return {
    guard: g ? { address: g.pubkey.toBase58(), raw: decode("Guard", g.data) } : null,
    seats: seats.sort((a, b) => num(a.raw, "index") - num(b.raw, "index")),
    objections,
    stamps: byTarget(stampsAll, "ApprovalStamp"),
    media: byTarget(mediaAll, "AssetMedia"),
    fallbackReports: reports.map((r) => r.raw),
  };
}

export const disabledGuardians = (): GuardiansSnapshot => ({
  enabled: false, objectionWindowSecs: 0, successionWaitSecs: 0, fallbackWaitSecs: 0, seats: [], feed: [], objections: [], claimPayableAt: {},
  fallback: { recipients: [], startedAt: null, readyAt: null, done: false, canStart: false },
});

/** Joins the raw accounts, the estate's events and the off-chain extras into the UI shape. Pure. */
export function assembleGuardians(
  raw: RawGuardians,
  ctx: { estate: Estate; claims: Claim[]; events: ChainEvent[]; extras: GuardianExtras },
): GuardiansSnapshot {
  if (!raw.guard) return disabledGuardians();
  const { estate, claims, events, extras } = ctx;
  const g = raw.guard.raw;
  const window = guardWait(g, "objection_window_secs");
  // Guard::succession_wait: at least 60 s, so a living holder always has time to say "I'm still here" (a stored 0 waits 60 s).
  const successionWait = Math.max(MIN_WAIT_SECS, guardWait(g, "succession_wait_secs"));
  const fallbackWait = guardWait(g, "fallback_wait_secs");
  const name = (w: Base58) => extras.names[w] ?? shortAddress(w);
  const named = (w: Base58) => ({ wallet: w, name: name(w) });

  /** The agent's report on the death report that stands now, never on one it replaced. */
  const standingReport = (reported: string, reviewed: string, indexField: string, index: number) => {
    const same = (d: Raw) => num(d, indexField) === index;
    const hash = standingReviewHash(events, reported, (e) => e.name.toLowerCase() === reviewed.toLowerCase() && same(e.data), same);
    return hash ? extras.reports[hash] : undefined;
  };

  const seats: Seat[] = raw.seats.map(({ address, raw: s }) => {
    const index = num(s, "index");
    const holder = key(s, "holder");
    const backups = keyArray(s, "backups").filter(set);
    const monitors = keyArray(s, "monitors").filter(set);
    const cert = hex(s, "death_cert_hash");
    const reportedBy = key(s, "death_reported_by");
    const confirmedBy = key(s, "death_confirmed_by");
    const confirmed = set(confirmedBy);
    const stored = num(s, "death_pending_since"); // the report's time, then the confirmation's
    const pendingSince = confirmed ? stored : 0;
    const reportedAt = confirmed
      ? events.find((e) => e.name.toLowerCase() === "seatdeathreported" && num(e.data, "seat_index") === index)?.ts
      : stored;
    const verdict = enumOf(s, "death_verdict", VERDICT);
    // Mirrors finalize_succession: the first backup who is not the owner, the agent, a current holder, the reporter
    // or the confirmer.
    const next = backups.find((b) => b !== estate.owner && b !== estate.agent && !estate.verifiers.includes(b) && b !== reportedBy && b !== confirmedBy);
    return {
      address, index, holder: set(holder) ? holder : null, holderName: set(holder) ? (extras.names[holder] ?? estate.verifierNames[index] ?? shortAddress(holder)) : "",
      backups: backups.map(named), monitors: monitors.map(named), generation: num(s, "generation"), vacant: bool(s, "vacant"),
      succession: cert === ZERO_HASH ? null : {
        certHash: cert, reportedBy, verdict,
        report: verdict === "Pending" ? undefined : standingReport("SeatDeathReported", "SeatDeathReviewed", "seat_index", index),
        confirmedBy: confirmed ? confirmedBy : null, ...(reportedAt !== undefined ? { reportedAt } : {}),
        pendingSince, readyAt: confirmed ? pendingSince + successionWait : 0,
        nextHolder: next ? named(next) : null,
      },
    };
  });

  const stampOf = (claim: Base58) => raw.stamps[claim];
  const claimPayableAt: Record<Base58, number> = {};
  for (const [address, st] of Object.entries(raw.stamps)) {
    const at = num(st, "approved_at");
    const c = claims.find((x) => x.address === address);
    if (!c || at <= 0 || c.approvalsCount === false) continue;
    if (!quorum({ verifiers: estate.verifiers, votes: c.approvals, threshold: estate.claimThreshold, verdict: c.agentVerdict, interested: c.beneficiary, alone: true }).met) continue;
    // Decided alone by the claimant: twice the window. A dispute held the one challenge account, so the monitors get
    // their window after it: after it lapsed, or after it was decided (a decided one's raised_at is when).
    const claimWindow = window * (c.decidedAlone ? 2 : 1);
    const dispute = raw.objections.find(({ raw: o }) => num(o, "seat_index") === DISPUTE_SEAT && key(o, "target") === address);
    const disputeEnded = !dispute ? 0
      : enumOf(dispute.raw, "status", OBJECTION_STATUS) === "Open" ? disputeLapsesAt(num(dispute.raw, "raised_at"), estate.waitingPeriodSecs) : num(dispute.raw, "raised_at");
    claimPayableAt[address] = Math.max(at, disputeEnded) + claimWindow;
  }

  const feed: SeatApprovalItem[] = events
    .filter((e) => e.name.toLowerCase() === "seatapproval")
    .map((e) => {
      const kind = enumOf(e.data, "kind", TARGET_KIND);
      const target = key(e.data, "target");
      const approver = key(e.data, "approver");
      const claim = kind === "Claim" ? claims.find((c) => c.address === target) : undefined;
      const stamp = kind === "Claim" ? stampOf(target) : undefined;
      const stampAt = stamp && claim?.approvalsCount !== false ? num(stamp, "approved_at") : 0;
      const summary = kind === "Claim"
        ? claim ? `Approved ${formatUsdt(claim.amount)} to ${name(claim.payee)} for ${name(claim.beneficiary)}` : "Approved a claim"
        : kind === "Unlock" ? `Confirmed ${estate.ownerName}'s passing`
          : kind === "Hardship" ? "Approved a request to sell below the minimum price" : "Approved";
      // Decided alone by the claimant: monitors get twice the window, as claimPayableAt above.
      const deadline = kind === "Claim" ? (stampAt > 0 ? stampAt + window * (claim?.decidedAlone ? 2 : 1) : null)
        : kind === "Unlock" && estate.status === "DeathPending" && estate.death.pendingSince ? estate.death.pendingSince + unlockWaitSecs(estate) : null;
      return {
        seatIndex: num(e.data, "seat_index"), approver, approverName: name(approver), kind, target, summary,
        ts: num(e.data, "ts") || e.ts, txSignature: e.signature, objectionDeadline: deadline,
      };
    });

  // Disputes (seat_index 254) share the Objection account but are read by chain/disputes.ts.
  const objections: Objection[] = raw.objections.filter(({ raw: o }) => num(o, "seat_index") !== DISPUTE_SEAT).map(({ address, raw: o }) => {
    const seatIndex = num(o, "seat_index");
    const reasonHash = hex(o, "reason_hash");
    const monitor = key(o, "monitor");
    const kind = enumOf(o, "kind", TARGET_KIND);
    const status = enumOf(o, "status", OBJECTION_STATUS);
    const raisedAt = num(o, "raised_at");
    // Voided by a new report (raised_at 0), or raised before the owner's last sign of life: void, with its votes. It
    // reads as lapsed. Once decided, raised_at is when it was decided.
    const voided = raisedAt === 0 || ((kind === "Unlock" || kind === "Fallback") && raisedAt < estate.lastHeartbeat);
    // Monitors' bits on the fallback are positions, one for each wallet; otherwise only held seats count.
    const voting = kind === "Fallback" ? 0xff : eligibleSeats(estate.verifiers).reduce((mask, i) => mask | (1 << i), 0);
    return {
      address, kind, target: key(o, "target"), monitor, monitorName: name(monitor),
      seatIndex: seatIndex === NO_SEAT ? null : seatIndex, reason: extras.reasons[reasonHash] ?? "", reasonHash,
      raisedAt, status,
      lapsesAt: status !== "Open" ? null : voided ? raisedAt : kind === "Fallback" ? raisedAt + fallbackWait : objectionLapsesAt(raisedAt, estate.waitingPeriodSecs),
      votesUphold: countBits(num(o, "votes_uphold") & voting), votesDismiss: countBits(num(o, "votes_dismiss") & voting),
    };
  }).sort((a, b) => b.raisedAt - a.raisedAt);

  const deadMask = num(g, "fallback_dead");
  const recipients = keyArray(g, "fallback").map((w, slot) => ({ w, slot, dead: (deadMask & (1 << slot)) !== 0 })).filter((r) => set(r.w));
  const startedAt = num(g, "fallback_started_at");
  const done = bool(g, "fallback_done");
  const allVacant = seats.length === 3 && seats.every((s) => s.vacant && !s.holder);
  const ownerDeath = estate.status === "Unlocked" || openToPeople(estate.death.verdict);
  // A countdown counts only for this death, and while the owner has shown no life since it started.
  const deathSince = (estate.status === "Active" ? estate.death.submittedAt : estate.death.pendingSince) ?? 0;
  const counting = startedAt > 0 && (done || (estate.lastHeartbeat < startedAt && deathSince <= startedAt));
  const times = estate.status === "Active" && estate.death.verdict === "Referred" ? 2 : 1;

  function openReport(r: { w: Base58; slot: number; dead: boolean }): FallbackDeathReport | null {
    if (done || r.dead) return null;
    // Void once the list names someone else there.
    const found = raw.fallbackReports?.find((x) => num(x, "index") === r.slot && key(x, "recipient") === r.w);
    if (!found) return null;
    const verdict = enumOf(found, "verdict", ["Pending", "Approved"] as const);
    const reportedAt = num(found, "reported_at");
    const report = verdict === "Approved" ? standingReport("FallbackDeathReported", "FallbackDeathReviewed", "index", r.slot) : undefined;
    return {
      reporter: key(found, "reporter"), certHash: hex(found, "cert_hash"), verdict, reportedAt,
      confirmableAt: reportedAt + refuteWait(fallbackWait), ...(report ? { report } : {}),
    };
  }

  return {
    enabled: true, address: raw.guard.address,
    objectionWindowSecs: window, successionWaitSecs: successionWait, fallbackWaitSecs: fallbackWait,
    seats, feed, objections, claimPayableAt,
    fallback: {
      recipients: recipients.map((r) => ({ wallet: r.w, name: name(r.w), kind: extras.fallbackKinds[r.w] ?? "heir", dead: r.dead, report: openReport(r) })),
      startedAt: counting ? startedAt : null,
      readyAt: counting ? startedAt + fallbackWait * times : null,
      done,
      canStart: !done && !counting && allVacant && ownerDeath && recipients.some((r) => !r.dead),
    },
  };
}

/** AssetMedia account → its on-chain kind, root and count. */
export function decodeMedia(r: Raw): { kind: AssetKind; photosRoot: string; photoCount: number; updatedAt: number } {
  return { kind: enumOf(r, "kind", ASSET_KIND), photosRoot: hex(r, "photos_root"), photoCount: num(r, "photo_count"), updatedAt: num(r, "updated_at") };
}
