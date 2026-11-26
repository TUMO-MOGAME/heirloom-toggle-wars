/**
 * The simulated visitor model, exactly as published in docs/simulation.md. Change it only with that page, and never
 * after the first run. Pure (no browser), so the plan for every visitor can be drawn and checked up front.
 */

export type VisitorType = "unsure" | "knows" | "browser";
/** What the visitor saw under the greeting. "not-looked": a Browser who left before the consent box. */
export type Seen = "shown" | "not-shown" | "not-looked";
export type Viewport = "phone" | "desktop";

export const MODEL = {
  types: { unsure: 0.5, knows: 0.3, browser: 0.2 },
  first: {
    unsureTapsIfShown: 0.7,
    unsureWritesIfNone: 0.35,
    knowsTypes: 0.85,
    browserSends: 0.1,
  },
  /** After the first message: goes on to review, and signs once on the review. Same in both versions. */
  review: { unsure: 0.5, knows: 0.75, browser: 0.2 },
  sign: { unsure: 0.6, knows: 0.8, browser: 0.3 },
  /** Messages sent by a visitor who goes on to review (inclusive ranges, even chance). Leavers send 1. */
  messages: { unsureTapping: [3, 3], unsureTyping: [3, 4], knows: [2, 3], browser: [2, 2] } as Record<string, [number, number]>,
  phoneShare: 0.6,
  viewports: { phone: { width: 360, height: 780 }, desktop: { width: 1280, height: 800 } },
  /** Pauses (ms) a person takes: reading on arrival, after ticking consent, between turns, on the review. */
  pauses: { arrive: [2000, 5000], consent: [500, 1500], turn: [1200, 4000], review: [3000, 8000] } as Record<string, [number, number]>,
} as const;

/** Seeded generator (mulberry32). Same seed, same stream. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A string seed to a 32-bit number (FNV-1a), so "--seed toggle-wars" works as well as "--seed 42". */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const between = (u: number, [lo, hi]: readonly [number, number]) => lo + Math.floor(u * (hi - lo + 1));
const ms = (u: number, [lo, hi]: readonly [number, number]) => Math.round(lo + u * (hi - lo));

/**
 * Every die a visitor will need, drawn up front from its own stream (seed + index), so a visitor's behaviour never
 * depends on the order the browsers happen to finish in. The choices that depend on what is seen are made later
 * by `decide`, from these same dice.
 */
export interface Dice {
  type: VisitorType;
  viewport: Viewport;
  uFirst: number;
  uReview: number;
  uSign: number;
  uCount: number;
  pauses: { arrive: number; consent: number; review: number; turns: number[] };
  /** Which of the made-up messages to type, by turn. */
  typedPick: number[];
}

export function drawDice(seed: number, index: number): Dice {
  const r = rng(hashSeed(`${seed}:${index}`));
  const uType = r();
  const type: VisitorType = uType < MODEL.types.unsure ? "unsure" : uType < MODEL.types.unsure + MODEL.types.knows ? "knows" : "browser";
  return {
    type,
    viewport: r() < MODEL.phoneShare ? "phone" : "desktop",
    uFirst: r(),
    uReview: r(),
    uSign: r(),
    uCount: r(),
    pauses: {
      arrive: ms(r(), MODEL.pauses.arrive),
      consent: ms(r(), MODEL.pauses.consent),
      review: ms(r(), MODEL.pauses.review),
      turns: [r(), r(), r(), r()].map((u) => ms(u, MODEL.pauses.turn)),
    },
    typedPick: [r(), r(), r(), r()].map((u) => Math.floor(u * 1000)),
  };
}

/** A Browser who will leave does so before ticking consent, so it never looks at the screen. */
export function leavesBeforeLooking(d: Dice): boolean {
  return d.type === "browser" && d.uFirst >= MODEL.first.browserSends;
}

export interface Decision {
  /** How the first message is sent; null = leaves without sending. */
  first: "tap" | "type" | null;
  /** Total messages to send (1 if not going on to review). */
  messages: number;
  review: boolean;
  sign: boolean;
}

/** The published rules (docs/simulation.md), applied to what the visitor saw. */
export function decide(d: Dice, seen: Seen): Decision {
  const none: Decision = { first: null, messages: 0, review: false, sign: false };
  const shown = seen === "shown";
  let first: Decision["first"] = null;
  if (d.type === "unsure") {
    if (shown) first = d.uFirst < MODEL.first.unsureTapsIfShown ? "tap" : null;
    else first = d.uFirst < MODEL.first.unsureWritesIfNone ? "type" : null;
  } else if (d.type === "knows") {
    first = d.uFirst < MODEL.first.knowsTypes ? "type" : null;
  } else {
    if (seen === "not-looked" || d.uFirst >= MODEL.first.browserSends) return none;
    first = shown ? "tap" : "type";
  }
  if (!first) return none;
  const review = d.uReview < MODEL.review[d.type];
  if (!review) return { first, messages: 1, review: false, sign: false };
  const range = d.type === "unsure" ? MODEL.messages[first === "tap" ? "unsureTapping" : "unsureTyping"] : MODEL.messages[d.type];
  return { first, messages: between(d.uCount, range), review: true, sign: d.uSign < MODEL.sign[d.type] };
}

/** --smoke: one visitor who always goes all the way (typed, reviewed, signed). Not part of any result. */
export const SMOKE: Decision = { first: "type", messages: 2, review: true, sign: true };

/** Arrival offsets (ms from the start) for N visitors over a duration: uniform, sorted (Poisson arrivals given N). */
export function arrivals(seed: number, n: number, overMs: number): number[] {
  const r = rng(hashSeed(`${seed}:arrivals`));
  return Array.from({ length: n }, () => Math.round(r() * overMs)).sort((a, b) => a - b);
}

/**
 * The made-up messages a visitor types (a fictional family; no real person, no contact details). Simulator data,
 * not UI copy: the app never shows these.
 */
export const TYPED = [
  [
    "I want my two kids looked after. School fees paid to the school, and a small monthly amount for books.",
    "Please make sure my children's school fees are paid every term, straight to the school, never as cash.",
    "My daughter needs money for university and books. My son is still in high school.",
  ],
  [
    "My lawyer, my sister and my oldest friend should confirm. Two of the three is enough.",
    "Three people I trust: my attorney, my cousin and our family doctor. Any two of them.",
  ],
  [
    "There is a car. Do not sell it for less than 10,000.",
    "The car can be sold, but not below 11,000 unless one of the kids really needs the money.",
  ],
  [
    "That looks right. Nothing else to add.",
    "I think that's everything for now.",
  ],
] as const;

export function typedMessage(turn: number, pick: number): string {
  const row = TYPED[Math.min(turn, TYPED.length - 1)];
  return row[pick % row.length];
}
