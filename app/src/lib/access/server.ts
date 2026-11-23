import "server-only";
/**
 * Server half of lib/access/messages.ts.
 *
 * - verifyAction: the wallet really asked for exactly this, just now, once (nonces.ts). Always await it. The route
 *   then checks its role.
 * - readerOf / isMember: who is reading, and whether the chain says they belong to this estate's family. A member is
 *   the owner, an active beneficiary, a trusted person, a backup, a monitor or a fallback recipient.
 * - assertServedEstate: the agent works (and spends SOL) only for estates that name it and use our USD₮ mint.
 */
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { HttpError } from "../api/http";
import { verifyEd25519 } from "../legacy/server/auth";
import { bool, key, type Raw } from "../chain/decoders";
import { beneficiaryPda, guardPda, seatPda } from "../chain/pda";
import { chainConfig } from "../chain/config";
import { getIdl } from "../chain/idl";
import { fetchAccountRaw } from "../chain/reads";
import { createNonces } from "./nonces";
import { ACTION_HEADER, ACTION_MAX_SKEW_MS, READ_HEADER, READ_PASS_MS, actionMessage, readPassMessage, type AgentAction } from "./messages";

const addr = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const sig = z.string().regex(/^[0-9a-f]{128}$/);
const actionSchema = z.object({ wallet: addr, ts: z.number().int().positive(), sig });
const passSchema = z.object({ wallet: addr, exp: z.number().int().positive(), sig });

function header<T>(req: Request, name: string, schema: z.ZodType<T>): T | null {
  const raw = req.headers.get(name);
  if (!raw || raw.length > 600) return null;
  try {
    const p = schema.safeParse(JSON.parse(raw));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

const firstUse = createNonces("action", ACTION_MAX_SKEW_MS * 2);

/** The wallet that signed this action. Throws 401 otherwise. */
export async function verifyAction(req: Request, action: AgentAction, estate: string, body: string, now = Date.now()): Promise<string> {
  const a = header(req, ACTION_HEADER, actionSchema);
  if (!a) throw new HttpError(401, "Sign this request with your wallet.", "unauthorized");
  if (Math.abs(now - a.ts) > ACTION_MAX_SKEW_MS) throw new HttpError(401, "This request is too old. Please try again.", "stale");
  const bodyHex = createHash("sha256").update(body, "utf8").digest("hex");
  if (!verifyEd25519(a.wallet, actionMessage(action, estate, a.wallet, a.ts, bodyHex), a.sig)) {
    throw new HttpError(401, "The signature does not match this wallet.", "unauthorized");
  }
  if (!(await firstUse(a.sig, now))) throw new HttpError(401, "This request was already used. Please try again.", "replay");
  return a.wallet;
}

/** The wallet holding a valid read pass, or null. */
export function readerOf(req: Request, now = Date.now()): string | null {
  const p = header(req, READ_HEADER, passSchema);
  if (!p || p.exp <= now || p.exp > now + READ_PASS_MS + ACTION_MAX_SKEW_MS) return null;
  return verifyEd25519(p.wallet, readPassMessage(p.wallet, p.exp), p.sig) ? p.wallet : null;
}

type Fetch = (type: string, address: string) => Promise<Raw | null>;

const NOBODY = PublicKey.default.toBase58();

function keysOf(raw: Raw, snake: string): string[] {
  const r = raw as Record<string, unknown>;
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const v = r[snake] ?? r[camel];
  return Array.isArray(v) ? v.map(String) : [];
}

export async function isMember(estate: string, wallet: string, fetchRaw: Fetch = fetchAccountRaw): Promise<boolean> {
  if (wallet === NOBODY) return false;
  const e = await fetchRaw("Estate", estate);
  if (!e) return false;
  if (key(e, "owner") === wallet || keysOf(e, "verifiers").includes(wallet)) return true;

  const programId = new PublicKey(getIdl().address);
  const b = await fetchRaw("Beneficiary", beneficiaryPda(programId, estate, wallet).toBase58());
  if (b && bool(b, "active")) return true;

  const guard = await fetchRaw("Guard", guardPda(programId, estate).toBase58());
  if (!guard) return false;
  if (keysOf(guard, "fallback").includes(wallet)) return true;
  const seats = await Promise.all([0, 1, 2].map((i) => fetchRaw("Seat", seatPda(programId, estate, i).toBase58())));
  return seats.some((s) => !!s && [...keysOf(s, "monitors"), ...keysOf(s, "backups")].includes(wallet));
}

const membership = new Map<string, { at: number; member: boolean }>();

/** The reader, when they are a member of this estate's family; else null. Cached briefly: every page asks several times. */
export async function memberReader(req: Request, estate: string): Promise<string | null> {
  const wallet = readerOf(req);
  if (!wallet) return null;
  const k = `${estate}:${wallet}`;
  const hit = membership.get(k);
  let member = hit && Date.now() - hit.at < 30_000 ? hit.member : undefined;
  if (member === undefined) {
    member = await isMember(estate, wallet);
    if (membership.size > 10_000) membership.clear();
    membership.set(k, { at: Date.now(), member });
  }
  return member ? wallet : null;
}

export type MemberCheck = (req: Request, estate: string) => Promise<string | null>;

export async function requireMember(req: Request, estate: string, check: MemberCheck = memberReader): Promise<string> {
  const wallet = await check(req, estate);
  if (!wallet) throw new HttpError(403, "Only this family can read these records. Unlock your wallet and try again.", "members_only");
  return wallet;
}

export function assertServedEstate(estate: { agent: string; usdtMint: string }, agent: string | null, mint: string = chainConfig.usdtMint): void {
  if (!agent || estate.agent !== agent || estate.usdtMint !== mint) {
    throw new HttpError(403, "Heirloom's agent does not serve this estate.", "not_served");
  }
}
