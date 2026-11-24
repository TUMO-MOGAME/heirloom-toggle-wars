/**
 * Legacy voice in mock mode. Same rules as the server (owner-only writes while the estate is active, consent
 * required, children only after unlock + opt-in, the voice speaks only the owner's own messages, translations only by
 * the living owner), with no cloned voice: the demo's prepared lines play in an ElevenLabs stock voice through
 * /api/legacy/demo-voice (labelled a stand-in), and anything else shows the words instead. The browser's own speech
 * voice is never used.
 *
 * On a demo deployment with ELEVENLABS_API_KEY and LEGACY_DEMO_WRITES=1, the same calls go to the real
 * /api/legacy/* routes (demo auth: role taken from the demo persona), so the real cloned voice can be heard.
 */
import type { Base58, Estate, Role } from "../types";
import type { EstateSnapshot } from "./types";
import { legacyVoiceSample } from "@/content/legacy";
import { DEMO_TRANSLATIONS, demoLegacyBook, demoTranslations } from "../legacy/demo-book";
import { legacyApi, type LegacySigner } from "../legacy/client";
import { demoVersionLine, demoVoiceText, demoVoiceUrl } from "../legacy/demo-voice";
import {
  approvedVersion, consentLine, currentVersions, disclosureLine, matchChild, validateVoiceInput,
  type LegacyStatus, type LegacyTranslation, type LegacyVoiceInfo,
} from "../legacy/rules";
import type { LegacyBook } from "../legacy/schema";
import { sha256Hex } from "../agent/hash";
import type { HeirloomService } from "./types";

type LegacyMethods = Pick<HeirloomService,
  "legacyStatus" | "createLegacyVoice" | "deleteLegacyVoice" | "saveLegacyBook" | "deleteLegacyBook" | "setLegacyOptIn" | "legacySpeak"
  | "saveLegacyTranslation" | "deleteLegacyTranslation" | "suggestLegacyTranslation">;

interface Deps {
  actor(): { address: Base58; role: Role; label: string } | null;
  estate(): Estate;
  snap(): EstateSnapshot;
  created(): boolean;
  wallets: Record<"lerato" | "sipho" | "naledi", Base58>;
}

/** `translations` is absent in state saved before translations existed: the demo's are seeded on first use. */
interface LocalState { v: 1; voice: LegacyVoiceInfo | null; book: LegacyBook | null; optIns: Record<string, boolean>; translations?: LegacyTranslation[] }

const KEY = "heirloom.mock.legacy.v1";
/** The demo voice was "recorded" by Thabo on 2 October 2026. */
const DEMO_CONSENTED_AT = Date.UTC(2026, 9, 2, 9, 30);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class LegacyError extends Error {
  constructor(public code: string, message: string) { super(`${code}: ${message}`); }
}
const fail = (code: string, msg: string): never => { throw new LegacyError(code, msg); };

/**
 * The demo's ElevenLabs audio for a line (/api/legacy/demo-voice), only while the words still match the demo's.
 * A message the owner rewrote in the demo has no audio: the app shows the words instead (never the browser's voice).
 */
function demoSpeech(line: string, text: string, voice: "parent" | "heirloom") {
  const fixed = demoVoiceText(line);
  if (!fixed || fixed.text !== text) fail("NoAudio", "In the demo, only the prepared messages can be heard. Your words are shown here.");
  return { text, audioUrl: demoVoiceUrl(line), simulated: true, voice };
}

export function createMockLegacy(d: Deps): LegacyMethods & { resetLegacy(): void } {
  const seed = (): LocalState => ({
    v: 1,
    voice: { ownerName: "Thabo Mokoena", consentedAt: DEMO_CONSENTED_AT, samples: 4, simulated: true },
    book: demoLegacyBook(d.wallets),
    optIns: {},
  });
  let st: LocalState = seed();
  if (typeof window !== "undefined") {
    try { const raw = window.localStorage.getItem(KEY); if (raw) { const p = JSON.parse(raw) as LocalState; if (p.v === 1) st = p; } } catch { /* stay in memory */ }
  }
  const save = () => { try { window.localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* ignore */ } };

  const me = () => d.actor() ?? fail("NoWallet", "Choose who you are acting as first.");
  const isOwner = () => !d.created() ? me().role === "owner" : me().address === d.estate().owner;
  const isChild = () => d.created() && d.snap().beneficiaries.some((b) => b.wallet === me().address && b.active);
  const unlocked = () => d.created() && d.estate().status === "Unlocked";
  const needOwner = () => { if (!isOwner()) fail("NotOwner", "Only the estate owner can do this."); };
  const needAlive = () => { if (d.created() && d.estate().status !== "Active") fail("BadStatus", "A legacy voice can only be created by the owner while the estate is active."); };
  const needOpenBook = () => { if (d.created() && d.estate().status !== "Active") fail("BadStatus", "The Legacy Book is sealed once a passing is reported."); };
  const versions = async () => (st.translations ??= await demoTranslations());
  /** Translations are the owner's, while alive, for a message in their saved book (same rules as the server). */
  const ownerMessage = (milestoneId: string) => {
    needOwner(); needOpenBook();
    return st.book?.milestones.find((m) => m.id === milestoneId) ?? fail("NotFound", "Save the message in your Legacy Book first.");
  };
  const child = () => (st.book ? matchChild(st.book, me().address, me().label) : null);
  const needTalk = () => {
    if (isOwner()) return;
    if (!isChild()) fail("NotBeneficiary", "Only a named family member can do this.");
    if (!unlocked()) fail("Locked", "The legacy voice opens once the estate unlocks.");
    if (!st.optIns[me().address]) fail("NotOptedIn", "Switch the legacy voice on first.");
  };

  /* ----- optional real backend on a demo deployment ----- */
  let remote: Promise<boolean> | null = null;
  const isRemote = () => {
    if (typeof window === "undefined") return Promise.resolve(false);
    remote ??= legacyApi.probe().then((p) => p.available && p.elevenlabs).catch(() => false);
    return remote;
  };
  const signer = (as?: "owner"): LegacySigner => {
    const a = me();
    return { estate: d.estate().address, wallet: a.address, sign: async () => "demo", demoRole: as ?? (isOwner() ? "owner" : "child"), demoLabel: a.label };
  };

  return {
    resetLegacy() { st = seed(); save(); },

    async legacyStatus() {
      if (await isRemote()) {
        let s = await legacyApi.status(signer());
        if (!s.book) { await legacyApi.saveBook(signer("owner"), demoLegacyBook(d.wallets)); s = await legacyApi.status(signer()); }
        return { ...s, unlocked: s.viewer === "owner" ? true : unlocked() };
      }
      await sleep(150);
      const owner = isOwner();
      const optedIn = owner || Boolean(st.optIns[me().address]);
      const open = owner || (unlocked() && optedIn);
      const current = st.book && open ? await currentVersions(st.book, await versions()) : [];
      const out: LegacyStatus = {
        voice: st.voice, optedIn, viewer: owner ? "owner" : isChild() ? "child" : "other",
        book: st.book ? (open ? structuredClone(st.book) : { ...st.book, values: [], lessons: [], phrases: [], children: [], milestones: [], guidance: { study: "", money: "", faith: "", family: "", other: "" } }) : null,
        childId: child()?.id ?? null, unlocked: unlocked(),
        translations: owner ? current : current.filter((t) => !t.stale),
      };
      return out;
    },

    async createLegacyVoice(_e, input) {
      needOwner(); needAlive();
      const problems = validateVoiceInput({
        ownerName: input.ownerName, consentAccepted: input.consentAccepted, consentText: input.consentText,
        consentAudio: input.consent ? { size: input.consent.size, type: input.consent.type } : null,
        samples: input.samples.map((b) => ({ size: b.size, type: b.type })),
      });
      if (problems.length) fail("Invalid", problems[0]);
      if (input.consentText !== consentLine(input.ownerName)) fail("Invalid", "The consent line must be the exact sentence shown.");
      if (await isRemote()) { const v = await legacyApi.createVoice(signer("owner"), input); st.voice = v; save(); return v; }
      await sleep(1800); // "creating the voice"
      st.voice = { ownerName: input.ownerName.trim(), consentedAt: Date.now(), samples: input.samples.length, simulated: true };
      save();
      return st.voice;
    },

    async deleteLegacyVoice() {
      needOwner();
      if (await isRemote()) await legacyApi.deleteVoice(signer("owner"));
      await sleep(600);
      st.voice = null; save();
    },

    async saveLegacyBook(_e, book) {
      needOwner(); needAlive();
      // The book's zod schema loads with the first save, not with the demo.
      const { legacyBookSchema } = await import("../legacy/schema");
      const parsed = legacyBookSchema.parse(book);
      if (await isRemote()) { const b = await legacyApi.saveBook(signer("owner"), parsed); st.book = b; save(); return b; }
      await sleep(500);
      st.book = parsed;
      st.translations = (await versions()).filter((t) => parsed.milestones.some((m) => m.id === t.milestoneId));
      save();
      return parsed;
    },

    async deleteLegacyBook() {
      needOwner();
      if (await isRemote()) await legacyApi.deleteBook(signer("owner"));
      await sleep(400);
      st.book = null; st.translations = []; save();
    },

    async setLegacyOptIn(_e, on) {
      if (!isChild()) fail("NotBeneficiary", "Only a named family member can do this.");
      if (await isRemote()) await legacyApi.optIn(signer(), on);
      await sleep(250);
      st.optIns = { ...st.optIns, [me().address]: on }; save();
    },

    async legacySpeak(_e, input) {
      needTalk();
      if (await isRemote()) return legacyApi.speak(signer(), input);
      // No voice recorded: the labelled stand-in reads the owner's words (same as the server). A book is needed.
      if (!st.book) fail("NotFound", "There is no Legacy Book for this estate.");
      let text: string;
      let line: string;
      if ("milestoneId" in input) {
        const m = st.book?.milestones.find((x) => x.id === input.milestoneId);
        if (!m) fail("NotFound", "That message was not found.");
        text = m!.text; line = m!.id;
        // The owner's approved version in the chosen language, if current; otherwise the original words.
        const version = approvedVersion(await currentVersions(st.book!, await versions()), m!.id, input.lang);
        if (version) { text = version.text; line = demoVersionLine(m!.id, version.lang); }
      } else if ("disclosure" in input) {
        // The demo never clones a voice: the stand-in disclosure.
        return demoSpeech("disclosure", disclosureLine(st.book ?? demoLegacyBook(), true), "heirloom");
      } else {
        // Same rule as the server: only the owner, while alive, hears the fixed sample line. Never free text.
        if (!isOwner()) fail("Forbidden", "The legacy voice only speaks the messages in the Legacy Book.");
        needAlive();
        text = legacyVoiceSample; line = "sample";
      }
      return demoSpeech(line, text, "parent");
    },

    async saveLegacyTranslation(_e, input) {
      const { translationInputSchema } = await import("../legacy/schema");
      const t = translationInputSchema.parse(input);
      const m = ownerMessage(t.milestoneId);
      if (await isRemote()) return legacyApi.saveTranslation(signer("owner"), t);
      await sleep(400);
      const saved: LegacyTranslation = { ...t, sha256: await sha256Hex(t.text), sourceSha256: await sha256Hex(m.text), approvedAt: Date.now(), stale: false };
      st.translations = [...(await versions()).filter((x) => !(x.milestoneId === t.milestoneId && x.lang === t.lang)), saved];
      save();
      return saved;
    },

    async deleteLegacyTranslation(_e, key) {
      ownerMessage(key.milestoneId);
      if (await isRemote()) { await legacyApi.deleteTranslation(signer("owner"), key); return; }
      await sleep(250);
      st.translations = (await versions()).filter((x) => !(x.milestoneId === key.milestoneId && x.lang === key.lang));
      save();
    },

    async suggestLegacyTranslation(_e, key) {
      const m = ownerMessage(key.milestoneId);
      if (await isRemote()) return legacyApi.suggestTranslation(signer("owner"), key);
      await sleep(700);
      // No model in the demo: only the prepared suggestion, and only while the owner's words still match the demo's.
      const original = demoLegacyBook().milestones.find((x) => x.id === m.id);
      const ready = DEMO_TRANSLATIONS.find((x) => x.milestoneId === m.id && x.lang === key.lang);
      if (!ready || original?.text !== m.text) fail("NoSuggestion", "In the demo, a suggestion is ready only for the graduation message in French. Type your own words in that language here.");
      return { text: ready!.text };
    },

  };
}
