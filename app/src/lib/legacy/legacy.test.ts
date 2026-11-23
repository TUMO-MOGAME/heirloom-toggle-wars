import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { consentLine, legacyBookSchema, sniffAudio, validateVoiceInput, matchChild, type VoiceInput } from "./schema";
import { demoLegacyBook, DEMO_MILESTONE_UCT } from "./demo-book";
import { disclosureLine, findMoment, isStandin, starterBook } from "./rules";
import { authMessage, encodeAuth, AUTH_HEADER } from "./auth-message";
import { authorize, verifyEd25519 } from "./server/auth";
import { HttpError } from "../api/http";

const book = demoLegacyBook({ lerato: "LeRaTo1111111111111111111111111111111111111" });
const lerato = book.children.find((c) => c.id === "lerato")!;

describe("Legacy Book schema", () => {
  it("accepts the demo book and fills defaults", () => {
    const p = legacyBookSchema.parse({ ownerName: "Thabo", guidance: {} });
    expect(p.calledBy).toBe("Dad");
    expect(p.guidance.study).toBe("");
    expect(legacyBookSchema.safeParse(book).success).toBe(true);
  });
  it("rejects milestones for unknown children and duplicate ids", () => {
    const bad = { ...book, milestones: [...book.milestones, { id: "x", childId: "nobody", kind: "birthday", title: "t", text: "t" }] };
    expect(legacyBookSchema.safeParse(bad).success).toBe(false);
    const dup = { ...book, children: [...book.children, book.children[0]] };
    expect(legacyBookSchema.safeParse(dup).success).toBe(false);
  });
  it("rejects oversized text and unknown kinds", () => {
    expect(legacyBookSchema.safeParse({ ...book, values: ["x".repeat(301)] }).success).toBe(false);
    expect(legacyBookSchema.safeParse({ ...book, milestones: [{ ...book.milestones[0], kind: "wedding" }] }).success).toBe(false);
  });
  it("matches a child by wallet, then by first name", () => {
    expect(matchChild(book, "LeRaTo1111111111111111111111111111111111111")?.id).toBe("lerato");
    expect(matchChild(book, "unknown", "Sipho (son)")?.id).toBe("sipho");
    expect(matchChild(book, null, "Pieter van Wyk")).toBeNull();
  });
});

describe("consent is required", () => {
  const audio = (size = 20_000, type = "audio/webm") => ({ size, type });
  const ok: VoiceInput = { ownerName: "Thabo Mokoena", consentAccepted: true, consentText: consentLine("Thabo Mokoena"), consentAudio: audio(), samples: [audio(), audio(), audio()] };
  it("passes with a ticked box, the exact spoken line and three samples", () => {
    expect(validateVoiceInput(ok)).toEqual([]);
    expect(consentLine("Thabo Mokoena")).toBe("I, Thabo Mokoena, agree that Heirloom may create a copy of my voice to read my own messages to my family after I'm gone.");
  });
  it("fails without the tick, the recording, the exact line or enough samples", () => {
    expect(validateVoiceInput({ ...ok, consentAccepted: false })).toContain("Tick the consent box to continue.");
    expect(validateVoiceInput({ ...ok, consentAudio: null }).join()).toMatch(/consent line first/);
    expect(validateVoiceInput({ ...ok, consentText: "I agree" }).join()).toMatch(/exact sentence/);
    expect(validateVoiceInput({ ...ok, samples: [audio(), audio()] }).join()).toMatch(/at least 3/);
    expect(validateVoiceInput({ ...ok, samples: [audio(), audio(), audio(20_000, "video/mp4")] }).join()).toMatch(/WebM/);
    expect(validateVoiceInput({ ...ok, samples: [audio(), audio(), audio(100)] }).join()).toMatch(/too short/);
  });
  it("sniffs real audio containers", () => {
    expect(sniffAudio(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0]))).toBe("audio/webm");
    expect(sniffAudio(new TextEncoder().encode("OggS\0\0"))).toBe("audio/ogg");
    expect(sniffAudio(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBe("audio/wav");
    expect(sniffAudio(new TextEncoder().encode("\0\0\0\x20ftypM4A "))).toBe("audio/mp4");
    expect(sniffAudio(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
  });
});

describe("what the voice says", () => {
  it("opens with an honest disclosure in Heirloom's voice", () => {
    expect(disclosureLine(book)).toBe("This is Heirloom. Next you will hear your dad's own words, in his voice: an AI copy made with his consent.");
    expect(disclosureLine({ calledBy: "Mama", pronoun: "she" })).toBe("This is Heirloom. Next you will hear your mama's own words, in her voice: an AI copy made with her consent.");
  });
  it("with no cloned voice, the disclosure says a stand-in reads the words (never \"in his voice\")", () => {
    expect(disclosureLine(book, true)).toBe("This is Heirloom. Next you will hear your dad's own words, read by a stand-in voice, not his own.");
    expect(isStandin(null)).toBe(true);
    expect(isStandin({ ownerName: "T", consentedAt: 1, samples: 0, simulated: true })).toBe(true);
    expect(isStandin({ ownerName: "T", consentedAt: 1, samples: 4, simulated: false })).toBe(false);
  });
  it("ties the UCT fee message to the first-fees moment", () => {
    expect(findMoment(book, lerato, "firstFees")?.id).toBe(DEMO_MILESTONE_UCT);
    expect(findMoment(book, book.children[1], "firstFees")).toBeNull();
  });
});

describe("request authorisation", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const wallet = bs58.encode(Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url"));
  const estate = "EsTaTe9MoKoEnAfaMiLyVauLt4xQp5sZc3FdYg8uE6rAo";
  const req = (auth: object | null) => new Request("http://x/api/legacy/book", { headers: auth ? { [AUTH_HEADER]: encodeAuth(auth as never) } : {} });

  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "mock"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("verifies WDK-style ed25519 signatures (hex)", () => {
    const msg = authMessage("book.write", estate, wallet, 123, "abc");
    const sig = sign(null, Buffer.from(msg), privateKey).toString("hex");
    expect(verifyEd25519(wallet, msg, sig)).toBe(true);
    expect(verifyEd25519(wallet, msg.replace("abc", "abd"), sig)).toBe(false);
  });
  it("requires a header", async () => {
    await expect(authorize(req(null), "book.read", "h")).rejects.toMatchObject({ status: 401 });
  });
  it("refuses legacy routes off-chain unless demo writes are enabled", async () => {
    const a = { estate, wallet, ts: Date.now(), sig: "demo", demoRole: "owner" };
    await expect(authorize(req(a), "book.read", "h")).rejects.toMatchObject({ status: 503 });
    vi.stubEnv("LEGACY_DEMO_WRITES", "1");
    await expect(authorize(req(a), "book.write", "h", ["owner"])).resolves.toMatchObject({ role: "owner", demo: true });
    await expect(authorize(req({ ...a, demoRole: "child" }), "book.write", "h", ["owner"])).rejects.toBeInstanceOf(HttpError);
  });
  it("in chain mode rejects demo and bad or stale signatures before touching the chain", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "chain");
    const ts = Date.now();
    await expect(authorize(req({ estate, wallet, ts, sig: "demo" }), "book.read", "h")).rejects.toMatchObject({ status: 401 });
    const stale = ts - 10 * 60_000;
    const sig = sign(null, Buffer.from(authMessage("book.read", estate, wallet, stale, "h")), privateKey).toString("hex");
    await expect(authorize(req({ estate, wallet, ts: stale, sig }), "book.read", "h")).rejects.toMatchObject({ code: "expired" });
    const wrong = sign(null, Buffer.from(authMessage("book.write", estate, wallet, ts, "h")), privateKey).toString("hex");
    await expect(authorize(req({ estate, wallet, ts, sig: wrong }), "book.read", "h")).rejects.toMatchObject({ status: 401 });
  });
});

describe("the demo book fits the family story", () => {
  it("never asks the children to phone Gogo Martha, who passed in 2019 (the tree)", () => {
    const words = [...book.phrases, ...book.milestones.map((m) => m.text)].join(" ");
    expect(words).not.toMatch(/phone your gogo/i);
    expect(words).toMatch(/Gogo's grave/);
  });
});

describe("a Legacy Book without a cloned voice", () => {
  it("starts empty with one entry per family member (wallets kept), and passes the schema", () => {
    const b = starterBook("Lerato Mokoena", [
      { label: "Amahle Mokoena (daughter)", wallet: "AmAhLe1111111111111111111111111111111111111" },
      { label: "Amahle Dlamini" }, { label: "" },
    ]);
    expect(b.children.map((c) => [c.id, c.name, c.wallet])).toEqual([
      ["amahle", "Amahle Mokoena", "AmAhLe1111111111111111111111111111111111111"], ["amahle-2", "Amahle Dlamini", undefined],
    ]);
    expect(b.milestones).toEqual([]);
    expect(legacyBookSchema.safeParse(b).success).toBe(true);
  });
});
