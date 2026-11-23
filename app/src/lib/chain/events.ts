/**
 * Turns program events (spec §Events) into plain-language activity lines. No personal data: events only
 * carry pubkeys, amounts and timestamps. A wallet appears as its short address and is listed in `parties`;
 * the feed puts a name there when the app knows one (lib/people.ts).
 */
import { formatUsdt, shortAddress } from "../format";
import type { Raw } from "./decoders";

function pick(d: Raw, ...names: string[]): unknown {
  for (const n of names) {
    const want = n.replace(/_/g, "").toLowerCase();
    for (const k of Object.keys(d)) if (k.replace(/_/g, "").toLowerCase() === want) return d[k];
  }
  return undefined;
}

function amountOf(d: Raw): bigint | undefined {
  const v = pick(d, "amount", "price");
  if (v === undefined || v === null) return undefined;
  try { return BigInt(String(v)); } catch { return undefined; }
}

function who(d: Raw, ...names: string[]): string {
  const v = pick(d, ...names);
  return v && typeof (v as { toBase58?: () => string }).toBase58 === "function"
    ? shortAddress((v as { toBase58: () => string }).toBase58())
    : "someone";
}

/** A dispute's kind: Anchor decodes enums as { unlock: {} } / { claim: {} }. */
const isUnlock = (d: Raw) => Object.keys((pick(d, "kind") as object | undefined) ?? {}).some((k) => k.toLowerCase() === "unlock");
function capOf(d: Raw): string {
  try { return formatUsdt(BigInt(String(pick(d, "cap")))); } catch { return "a limit in USD₮"; }
}

const TEXT: Record<string, (d: Raw, amt?: bigint) => string> = {
  EstateCreated: () => "Estate created and USD₮ vault opened",
  WillSet: () => "Will rules signed (hash recorded on-chain)",
  DeathClaimSubmitted: (d) => `Death certificate hash submitted by ${who(d, "submitted_by", "beneficiary", "by")}`,
  DeathReviewed: (d) => `Agent reviewed the death certificate: ${pick(d, "approve", "approved") ? "no red flags" : "rejected"}`,
  DeathAttested: (d) => `Verifier ${who(d, "verifier")} attested the death`,
  DeathVetoed: () => "The owner showed they are alive: the death claim was cancelled",
  EstateUnlocked: () => "Waiting period over: estate unlocked",
  ClaimSubmitted: (_d, a) => `Claim submitted${a !== undefined ? ` for ${formatUsdt(a)}` : ""}`,
  ClaimReviewed: (d) => `Agent reviewed a claim: ${pick(d, "approve", "approved") ? "approved" : "rejected"}`,
  ClaimApproved: (d) => `Verifier ${who(d, "verifier")} approved a claim`,
  ClaimPaid: (d, a) => `${a !== undefined ? formatUsdt(a) : "USD₮"} paid to ${who(d, "payee", "payee_wallet")}`,
  AssetRegistered: () => "Car digital title moved into the estate",
  AssetListed: () => "Car listed for sale",
  OfferPlaced: (d, a) => `Offer of ${a !== undefined ? formatUsdt(a) : "USD₮"} escrowed by ${who(d, "buyer")}`,
  OfferWithdrawn: (d) => `Offer withdrawn by ${who(d, "buyer")}`,
  HardshipSubmitted: () => "Hardship request submitted",
  HardshipReviewed: (d) => `Agent reviewed a hardship request: ${pick(d, "approve", "approved") ? "supported" : "rejected"}`,
  HardshipApproved: (d) => `Verifier ${who(d, "verifier")} approved a hardship request`,
  ScheduledPaid: (d, a) => `Scheduled payment of ${a !== undefined ? formatUsdt(a) : "USD₮"} paid to ${who(d, "payee", "fixed_payee", "payee_wallet")}`,
  ReviewReferred: () => "Agent was not sure and referred it: at least two trusted people, or the living owner, decide",
  RuleEnded: () => "Owner ended a rule: it cannot pay any more",
  ResidualSet: () => "Owner named who receives what is left",
  ResidualSwept: () => "What no rule needed any more was paid to the named recipient",
  AgentVoted: (d) => `Trusted person ${who(d, "verifier")} voted to replace the agent's key`,
  AgentChanged: () => "The agent's key was replaced",
  ClaimOwnerApproved: () => "Owner approved a living-plan claim",
  // guardians (docs/guardians-spec.md §2.4)
  GuardInitialized: () => "Guardians switched on: approvals now wait for an objection window",
  SeatConfigured: () => "A trusted person's backups or monitors were updated",
  SeatApproval: (d) => `Trusted person ${who(d, "approver")} approved something their monitors can see`,
  SeatDeathReported: (d) => `A trusted person's passing was reported by ${who(d, "reported_by")}`,
  SeatDeathReviewed: (d) => `Agent reviewed a trusted person's death certificate: ${pick(d, "approved", "approve") ? "no red flags" : "rejected"}`,
  SeatDeathConfirmed: (d) => `${who(d, "confirmed_by")} confirmed a trusted person's passing; the waiting period has started`,
  SeatDeathVetoed: () => "A trusted person said \"I'm still here\": the report was cancelled",
  SuccessionFinalized: (d) => `${who(d, "new_holder")} now holds the seat of ${who(d, "previous_holder")}`,
  SeatVacated: () => "A trusted person's seat is now empty: no backup was left",
  ObjectionRaised: (d) => `Monitor ${who(d, "monitor")} objected; the step is paused until it is decided`,
  ObjectionVoted: (d) => `${who(d, "voter")} voted to ${pick(d, "uphold") ? "uphold" : "dismiss"} an objection`,
  ObjectionResolved: (d) => (pick(d, "upheld") ? "An objection was upheld: the paused step was cancelled" : "An objection was dismissed: the paused step can go ahead"),
  FallbackSet: () => "Fallback order set",
  FallbackDeathReported: (d) => `A fallback recipient's passing was reported by ${who(d, "reported_by")}`,
  FallbackDeathReviewed: (d) => `Agent reviewed a fallback recipient's death certificate: ${pick(d, "approved", "approve") ? "no red flags; a second person confirms after the wait" : "rejected"}`,
  FallbackDeathConfirmed: (d) => `${who(d, "confirmed_by")} confirmed the passing of ${who(d, "recipient")}: the fallback order skips them`,
  FallbackDeathRefuted: (d) => `${who(d, "recipient")} said "I'm alive": the report was cancelled`,
  SeatDeathReportCleared: () => "A trusted person's death report was cleared: it can be reported again",
  AssetReleased: () => "The owner took an asset's title back out of the plan",
  MemberRemoved: (d) => `The owner removed ${who(d, "wallet")} ${pick(d, "payee") ? "from the approved payees" : "from the family in the plan"}`,
  RuleReused: () => "The owner set a new rule in an ended rule's place: the old rule's requests can't be paid",
  AgentReviewCleared: () => "A new agent took over: a report the old agent reviewed waits for the new agent to review it again",
  FallbackStarted: () => "All trusted people are gone: the fallback plan's waiting period has started",
  FallbackExecuted: (d, a) => `Fallback plan: the whole vault (${a !== undefined ? formatUsdt(a) : "USD₮"}) went to ${who(d, "recipient")}`,
  AssetMediaSet: () => "Asset photos updated (their hash is recorded on-chain)",
  // disputes and yearly caps (15 Nov 2026)
  DisputeRaised: (d) => `${who(d, "disputer")} disputed a pending ${isUnlock(d) ? "unlock" : "payment"}; it is paused until two trusted people decide`,
  DisputeVoted: (d) => `${who(d, "verifier")} voted to ${pick(d, "uphold") ? "uphold" : "dismiss"} a dispute`,
  DisputeResolved: (d) => (pick(d, "upheld") ? "A dispute was upheld: the paused step was cancelled" : "A dispute was dismissed: the paused step can go ahead"),
  YearlyCapSet: (d) => `Yearly limit set on a rule: ${capOf(d)} a year`,
  AssetSold: (d, a) => `Car sold for ${a !== undefined ? formatUsdt(a) : "USD₮"} to ${who(d, "buyer")}: USD₮ and title swapped atomically`,
};

/** Every wallet in the event's fields whose short address the line shows (so the feed can put a name there). */
function partiesIn(d: Raw, text: string): string[] {
  const out: string[] = [];
  for (const v of Object.values(d)) {
    const b58 = v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58: () => string }).toBase58() : null;
    if (b58 && !out.includes(b58) && text.includes(shortAddress(b58))) out.push(b58);
  }
  return out;
}

export function describeEvent(name: string, data: Raw): { kind: string; text: string; amount?: bigint; parties?: string[] } {
  const key = Object.keys(TEXT).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
  const amount = amountOf(data);
  const fn = TEXT[key];
  const text = fn ? fn(data, amount) : key;
  const parties = partiesIn(data, text);
  return { kind: key, text, amount, ...(parties.length ? { parties } : {}) };
}

function key(d: Raw, ...names: string[]): string | null {
  const v = pick(d, ...names);
  return v && typeof (v as { toBase58?: () => string }).toBase58 === "function" ? (v as { toBase58: () => string }).toBase58() : typeof v === "string" ? v : null;
}

/** The AssetSold event's asset, buyer and recipient (spec §Events), or null if a field is missing. */
export function saleFromEvent(name: string, data: Raw): { asset: string; buyer: string; recipient: string; hardship: boolean } | null {
  if (name.toLowerCase() !== "assetsold") return null;
  const asset = key(data, "asset");
  const buyer = key(data, "buyer");
  const recipient = key(data, "recipient");
  if (!asset || !buyer || !recipient) return null;
  return { asset, buyer, recipient, hardship: !!pick(data, "hardship") };
}

/** ClaimPaid / ScheduledPaid / FallbackExecuted: the payee (or fallback recipient), rule and claim, or null. */
export function paymentFromEvent(name: string, data: Raw): { payee: string; rule?: string; claim?: string } | null {
  const n = name.toLowerCase();
  if (n !== "claimpaid" && n !== "scheduledpaid" && n !== "fallbackexecuted") return null;
  const payee = n === "fallbackexecuted" ? key(data, "recipient") : key(data, "payee", "fixed_payee", "payee_wallet");
  if (!payee) return null;
  const rule = key(data, "rule");
  const claim = key(data, "claim");
  return { payee, ...(rule ? { rule } : {}), ...(claim ? { claim } : {}) };
}
