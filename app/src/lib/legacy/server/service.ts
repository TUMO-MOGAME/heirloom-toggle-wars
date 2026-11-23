import "server-only";
/**
 * Legacy Voice server logic for /api/legacy/*. Every function takes a Viewer from ./auth.ts (signature + on-chain
 * role already checked).
 *
 * Rule (18 Nov 2026, plan §16.17): the voice only ever says words its owner wrote or approved while alive. It speaks
 * a milestone message from the Legacy Book, or (for the owner, while the estate is active) one fixed sample line.
 * There is no chat, no live call and no AI-written reply in the parent's voice.
 */
import { HttpError } from "@/lib/api/http";
import { sha256Hex } from "@/lib/agent/hash";
import { legacyVoiceSample } from "@/content/legacy";
import {
  baseMime, consentLine, disclosureLine, isStandin, matchChild, sniffAudio, validateVoiceInput,
  type LegacyBook, type LegacyChild, type LegacyStatus, type LegacyVoiceInfo,
} from "../schema";
import type { Viewer } from "./auth";
import * as el from "./elevenlabs";
import { heirloomVoice, standinVoice } from "./standin";
import * as store from "./store";
import { takeShared } from "@/lib/server/shared-store";

const isUnlocked = (v: Viewer) => (v.snap ? v.snap.estate.status === "Unlocked" : v.demo);

function voiceInfo(row: store.VoiceRow): LegacyVoiceInfo {
  return {
    // No ElevenLabs voice, or one with no recordings behind it (the devnet demo's stock voice), is not a clone of the
    // owner: the app labels it a stand-in and never says "created with consent from N recordings".
    ownerName: row.ownerName, consentedAt: row.consentedAt, samples: row.samplePaths.length, simulated: !row.voiceId || row.samplePaths.length === 0,
    needsVerification: row.requiresVerification || undefined,
  };
}

/** Before unlock a child sees only how the parent is named, not the book's contents. */
function redact(b: LegacyBook): LegacyBook {
  return { ...b, values: [], lessons: [], phrases: [], guidance: { study: "", money: "", faith: "", family: "", other: "" }, children: [], milestones: [] };
}

function childFor(v: Viewer, book: LegacyBook): LegacyChild | null {
  return v.role === "child" ? matchChild(book, v.wallet, v.label) : null;
}

/**
 * Voices made before 18 Nov 2026 also got a private ElevenLabs agent for live calls. Live calls are gone, so that
 * agent is deleted (best effort) the next time anyone opens the estate's legacy voice.
 */
async function retireAgent(row: store.VoiceRow): Promise<void> {
  if (!row.agentId) return;
  try {
    if (el.hasElevenLabs()) await el.deleteLegacyAgent(row.agentId);
    await store.setAgentId(row.estate, null);
  } catch (e) {
    console.warn("[legacy] retiring the old call agent failed:", e instanceof Error ? e.message : e);
  }
}

export async function status(v: Viewer): Promise<LegacyStatus> {
  const [voice, row] = await Promise.all([store.getVoice(v.estate), store.getBook(v.estate)]);
  if (voice) await retireAgent(voice);
  const unlocked = isUnlocked(v);
  const optedIn = v.role === "owner" ? true : Boolean(row?.optIns[v.wallet]);
  const book = row ? (v.role === "owner" || (unlocked && optedIn) ? row.book : redact(row.book)) : null;
  return {
    voice: voice ? voiceInfo(voice) : null, book, optedIn, viewer: v.role,
    childId: row ? childFor(v, row.book)?.id ?? null : null, unlocked,
  };
}

/* ---------- voice ---------- */

export interface VoiceUpload { ownerName: string; consentAccepted: boolean; consentText: string; consent: File | null; samples: File[] }

/** Canonical body hash the browser signs for a multipart upload. */
export async function uploadHash(u: { ownerName: string; consentText: string; consentSha: string; sampleShas: string[] }) {
  return sha256Hex(JSON.stringify({ ownerName: u.ownerName, consentText: u.consentText, consent: u.consentSha, samples: u.sampleShas }));
}

export async function readUpload(u: VoiceUpload) {
  const problems = validateVoiceInput({
    ownerName: u.ownerName, consentAccepted: u.consentAccepted, consentText: u.consentText,
    consentAudio: u.consent ? { size: u.consent.size, type: u.consent.type } : null,
    samples: u.samples.map((f) => ({ size: f.size, type: f.type })),
  });
  if (problems.length) throw new HttpError(400, problems[0], "invalid");
  const read = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const sniffed = sniffAudio(bytes);
    if (!sniffed || (sniffed !== baseMime(f.type) && !(sniffed === "audio/webm" && baseMime(f.type) === "audio/ogg"))) {
      throw new HttpError(400, "A recording's contents do not match its type.", "invalid");
    }
    return { bytes, mime: sniffed, sha: await sha256Hex(bytes) };
  };
  return { consent: await read(u.consent!), samples: await Promise.all(u.samples.map(read)) };
}

export async function createVoice(v: Viewer, u: VoiceUpload, files: Awaited<ReturnType<typeof readUpload>>): Promise<LegacyVoiceInfo> {
  if (v.role !== "owner") throw new HttpError(403, "Only the estate owner can create their voice.", "forbidden");
  // Rule 1: only a living owner. Once a passing is reported, no voice can be created or replaced.
  if (v.snap && v.snap.estate.status !== "Active") throw new HttpError(409, "A legacy voice can only be created by the owner while the estate is active.", "bad_status");
  if (u.consentText !== consentLine(u.ownerName)) throw new HttpError(400, "The consent line must be the exact sentence shown.", "invalid");

  const existing = await store.getVoice(v.estate);
  if (existing) await removeVoice(v);

  const key = await store.estateKey(v.estate);
  const ext = (m: string) => m.split("/")[1].replace("mpeg", "mp3");
  const consentPath = `consent/${key}/${files.consent.sha}.${ext(files.consent.mime)}`;
  await store.putAudio(consentPath, files.consent.bytes, files.consent.mime);
  const samplePaths: string[] = [];
  for (const s of files.samples) {
    const p = `samples/${key}/${s.sha}.${ext(s.mime)}`;
    await store.putAudio(p, s.bytes, s.mime);
    samplePaths.push(p);
  }

  const consentedAt = Date.now();
  let voiceId: string | null = null;
  let requiresVerification = false;
  if (el.hasElevenLabs()) {
    const r = await el.createInstantVoice({
      name: `Heirloom legacy ${key.slice(0, 8)}`,
      description: `Instant voice clone created by the estate owner with recorded consent on ${new Date(consentedAt).toISOString().slice(0, 10)} (Heirloom Legacy Voice).`,
      files: files.samples.map((s, i) => ({ bytes: s.bytes, mime: s.mime, name: `sample-${i + 1}.${ext(s.mime)}` })),
    });
    voiceId = r.voiceId;
    requiresVerification = r.requiresVerification;
  }
  const row: store.VoiceRow = {
    estate: v.estate, ownerWallet: v.wallet, ownerName: u.ownerName.trim(), voiceId, agentId: null, requiresVerification,
    consentText: u.consentText, consentSha256: files.consent.sha, consentPath, samplePaths, sampleSha256: files.samples.map((s) => s.sha), consentedAt,
  };
  await store.saveVoice(row);
  return voiceInfo(row);
}

/** Deletes the voice everywhere: ElevenLabs voice (and any old call agent), recordings, rendered messages. */
export async function removeVoice(v: Viewer): Promise<void> {
  if (v.role !== "owner") throw new HttpError(403, "Only the estate owner can delete their voice.", "forbidden");
  const row = await store.getVoice(v.estate);
  if (!row) return;
  if (row.agentId) await el.deleteLegacyAgent(row.agentId);
  if (row.voiceId) await el.deleteElevenVoice(row.voiceId);
  await store.deleteVoice(v.estate);
}

/* ---------- book ---------- */

export async function putBook(v: Viewer, book: LegacyBook): Promise<LegacyBook> {
  if (v.role !== "owner") throw new HttpError(403, "Only the estate owner can write the Legacy Book.", "forbidden");
  if (v.snap && v.snap.estate.status !== "Active") throw new HttpError(409, "The Legacy Book is sealed once a passing is reported.", "bad_status");
  // Keep child wallets in step with the on-chain beneficiaries where the names match.
  const kids = (v.snap?.beneficiaries ?? []).filter((b) => b.active);
  const linked = {
    ...book,
    children: book.children.map((c) => c.wallet ? c : { ...c, wallet: kids.find((b) => b.label.split(/[ (]/)[0].toLowerCase() === c.name.split(" ")[0].toLowerCase())?.wallet }),
  };
  await store.saveBook(v.estate, v.wallet, linked);
  return linked;
}

export async function removeBook(v: Viewer): Promise<void> {
  if (v.role !== "owner") throw new HttpError(403, "Only the estate owner can delete the Legacy Book.", "forbidden");
  await store.deleteBook(v.estate);
}

export async function optIn(v: Viewer, on: boolean): Promise<void> {
  if (v.role !== "child") throw new HttpError(403, "Only a child of the estate can switch the legacy voice on or off.", "forbidden");
  if (!(await store.getBook(v.estate))) throw new HttpError(404, "There is no Legacy Book for this estate.", "not_found");
  await store.setOptIn(v.estate, v.wallet, on);
}

/* ---------- speaking ---------- */

async function speakContext(v: Viewer) {
  const row = await store.getBook(v.estate);
  if (!row) throw new HttpError(404, "There is no Legacy Book for this estate.", "not_found");
  if (v.role === "child") {
    if (!isUnlocked(v)) throw new HttpError(403, "The legacy voice opens once the estate unlocks.", "locked");
    if (!row.optIns[v.wallet]) throw new HttpError(403, "Switch the legacy voice on first.", "not_opted_in");
  }
  return { book: row.book, child: childFor(v, row.book), voice: await store.getVoice(v.estate) };
}

const daily = new Map<string, { day: string; n: number }>();
/**
 * Per-estate cap on rendered speech (cost + abuse): on this instance, and across instances when the shared store is
 * there. Supabase cache makes repeats free. Always await it.
 */
export const SPEAK_DAILY_LIMIT = 200;
export async function countSpeak(estate: string): Promise<void> {
  const tooMuch = () => new HttpError(429, "The legacy voice has spoken a lot today. Please try again tomorrow.", "rate_limited");
  const day = new Date().toISOString().slice(0, 10);
  const d = daily.get(estate);
  if (!d || d.day !== day) daily.set(estate, { day, n: 1 });
  else if (++d.n > SPEAK_DAILY_LIMIT) throw tooMuch();
  const taken = await takeShared([{ key: `legacy-speak:${estate}`, max: SPEAK_DAILY_LIMIT, windowSecs: 86_400 }]);
  if (taken && !taken.ok) throw tooMuch();
}

/** What may be spoken: a milestone the owner wrote, the fixed sample line (owner, while alive), or Heirloom's
 * disclosure line (app copy, in Heirloom's own voice). Never free text. */
export type SpeakRequest = { milestoneId: string } | { sample: true } | { disclosure: true };

/**
 * Returns MP3 bytes, or null when ElevenLabs is not configured (the app then shows the words; it never falls back
 * to the browser's voice). The parent's cloned voice when there is one; otherwise an ElevenLabs stock voice stands
 * in (labelled as such in the app). The disclosure is always in Heirloom's own stock voice.
 */
export async function speak(v: Viewer, req: SpeakRequest): Promise<{ text: string; audio: Uint8Array | null; voice: "parent" | "heirloom" }> {
  const ctx = await speakContext(v);
  let text: string;
  let milestoneId: string | null = null;
  const voice = "disclosure" in req ? "heirloom" : "parent";
  if ("milestoneId" in req) {
    const m = ctx.book.milestones.find((x) => x.id === req.milestoneId && (v.role === "owner" || x.childId === "all" || x.childId === ctx.child?.id));
    if (!m) throw new HttpError(404, "That message was not found.", "not_found");
    text = m.text; milestoneId = m.id;
  } else if ("disclosure" in req) {
    text = disclosureLine(ctx.book, isStandin(ctx.voice ? voiceInfo(ctx.voice) : null));
  } else {
    // The owner hears one fixed line while alive. The line is the app's, never text the client sends.
    if (v.role !== "owner") throw new HttpError(403, "The legacy voice only speaks the messages in the Legacy Book.", "forbidden");
    if (v.snap && v.snap.estate.status !== "Active") throw new HttpError(409, "The sample plays only while the estate is active.", "bad_status");
    text = legacyVoiceSample;
  }
  if (!el.hasElevenLabs()) return { text, audio: null, voice };
  const cloned = voice === "parent" ? ctx.voice?.voiceId ?? null : null;
  if (cloned && ctx.voice?.requiresVerification) throw new HttpError(409, "This voice still needs verification in the ElevenLabs dashboard.", "needs_verification");
  const voiceId = voice === "heirloom" ? heirloomVoice() : cloned ?? standinVoice(ctx.book.pronoun);
  const sha = await sha256Hex(`${voiceId}\n${text}`);
  const hit = await store.cachedMessage(v.estate, sha);
  if (hit) return { text, audio: hit, voice };
  await countSpeak(v.estate);
  const audio = await el.textToSpeech(voiceId, text).catch((e: unknown) => {
    // Log ElevenLabs' detail on the server; the family sees a plain message (the app then shows the words).
    console.error("[legacy] speak failed:", e instanceof Error ? e.message : e);
    throw new HttpError(503, "The voice is not available right now.", "unavailable");
  });
  await store.cacheMessage(v.estate, sha, milestoneId, audio).catch((e) => console.warn("[legacy] cache failed:", e instanceof Error ? e.message : e));
  return { text, audio, voice };
}
