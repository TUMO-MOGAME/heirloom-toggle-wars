/**
 * The Toggle Wars simulator (plan §6, method in docs/simulation.md). Drives N fresh browsers through the real plan
 * builder, each acting by its published visitor type and reading only what is on screen, never the flag value.
 * Every result it writes is labelled SIMULATED.
 *
 * Run from app/ (needs `npx playwright install chromium` once):
 *   npx tsx --tsconfig ../scripts/simulate/tsconfig.json ../scripts/simulate/simulate.ts \
 *     --env sim --base-url https://<simulation deployment> --visitors 2000 --over 8h --seed 26nov --concurrency 4
 * Smoke test against a local dev server:
 *   npx tsx --tsconfig ../scripts/simulate/tsconfig.json ../scripts/simulate/simulate.ts --env dev --base-url http://localhost:3000 --smoke
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { screens } from "../../app/src/content/screens";
import { common } from "../../app/src/content/common";
import { MODEL, SMOKE, arrivals, decide, drawDice, hashSeed, leavesBeforeLooking, typedMessage, type Decision, type Seen, type VisitorType } from "./model";

const will = screens.will;
const here = dirname(fileURLToPath(import.meta.url));

/* ---------- Arguments and the safety gate ---------- */

const PRODUCTION_HOSTS = ["heirloom-toggle-wars.vercel.app"];
/** Heirloom's own sites: this repo never touches them (CLAUDE.md). */
const NEVER_HOSTS = [/^heirloom-one-iota/, /^heirloom-devnet/];
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

interface Args {
  baseUrl: URL;
  env: "sim" | "dev";
  visitors: number;
  overMs: number;
  seed: string;
  concurrency: number;
  path: string;
  flagsmithHost: RegExp;
  headed: boolean;
  smoke: boolean;
}

function fail(msg: string): never {
  console.error(`simulate: ${msg}`);
  process.exit(2);
}

export function parseDuration(s: string): number {
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let used = 0;
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
    used += m[0].length;
  }
  if (!used || used !== s.length) fail(`can't read the duration "${s}" (use e.g. 90s, 20m, 8h, 1h30m)`);
  return total;
}

function parseArgs(argv: string[]): Args {
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) fail(`unexpected argument "${a}"`);
    const [k, inline] = a.slice(2).split("=", 2);
    if (inline !== undefined) opts[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) opts[k] = argv[++i];
    else opts[k] = true;
  }
  const known = ["base-url", "env", "visitors", "over", "seed", "concurrency", "path", "flagsmith-host", "headed", "smoke"];
  for (const k of Object.keys(opts)) if (!known.includes(k)) fail(`unknown option --${k}`);
  const str = (k: string) => (typeof opts[k] === "string" ? (opts[k] as string) : undefined);

  const raw = str("base-url") ?? fail("--base-url is required");
  let baseUrl: URL;
  try { baseUrl = new URL(raw); } catch { fail(`--base-url "${raw}" is not a URL`); }
  const env = str("env");
  if (env !== "sim" && env !== "dev") fail("--env sim or --env dev is required (there is no prod: real visitors only, never simulated ones)");
  const host = baseUrl.hostname.toLowerCase();
  if (PRODUCTION_HOSTS.includes(host)) fail(`${host} is the Production site. The simulator runs only against the Simulation deployment or a local server.`);
  if (NEVER_HOSTS.some((r) => r.test(host))) fail(`${host} is one of Heirloom's own sites, which this repo never touches.`);
  if (env === "dev" && !LOCAL_HOSTS.includes(host)) fail(`--env dev runs only against a local server (localhost), not ${host}`);
  if (env === "sim") {
    if (LOCAL_HOSTS.includes(host)) fail("--env sim is the Simulation deployment; for a local server use --env dev");
    if (baseUrl.protocol !== "https:") fail("--env sim needs an https URL");
    // The Vercel branch alias of the simulation branch always says so (…-git-simulation-….vercel.app).
    if (!host.includes("simulation")) fail(`${host} doesn't look like the Simulation deployment: use its branch URL (it contains "simulation")`);
  }

  const smoke = opts.smoke === true;
  const int = (k: string, dflt: number, min: number, max: number) => {
    const v = str(k);
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail(`--${k} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const visitors = smoke ? 1 : int("visitors", 1, 1, 10_000);
  if (smoke && str("visitors") && str("visitors") !== "1") fail("--smoke runs exactly one visitor");
  let flagsmithHost = /(^|\.)flagsmith\.com$/i;
  if (str("flagsmith-host")) {
    try { flagsmithHost = new RegExp(str("flagsmith-host")!, "i"); } catch { fail("--flagsmith-host must be a regular expression for the host"); }
  }
  return {
    baseUrl, env, visitors, smoke,
    overMs: str("over") ? parseDuration(str("over")!) : 0,
    seed: str("seed") ?? String(Date.now()),
    concurrency: int("concurrency", 4, 1, 32),
    path: str("path") ?? "/try",
    flagsmithHost,
    headed: opts.headed === true,
  };
}

/* ---------- One visitor ---------- */

interface VisitorLog {
  index: number;
  type: VisitorType;
  viewport: string;
  plannedAtMs: number;
  startedAtMs: number;
  seen: Seen;
  first: Decision["first"];
  messagesPlanned: number;
  messagesSent: number;
  reviewed: boolean;
  signed: boolean;
  /** The sign button was there but disabled (the plan needs something more), so the visitor couldn't sign. */
  signBlocked: boolean;
  /** The review button never appeared after the planned messages. */
  reviewNotOffered: boolean;
  /** Requests to Flagsmith seen (count only; never their contents). */
  flagsmithRequests: number;
  flushWaitMs: number;
  durationMs: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The plan builder's parts, found by role and accessible name from the app's own copy (app/src/content). */
function ui(page: Page) {
  const builder = page.getByRole("region", { name: will.eyebrow, exact: true });
  return {
    builder,
    consent: builder.getByRole("checkbox", { name: new RegExp(escape(common.consent.before)) }),
    chips: builder.getByRole("group", { name: will.suggestionsLabel, exact: true }).getByRole("button"),
    composer: builder.getByRole("textbox", { name: will.composer.inputLabel, exact: true }),
    send: builder.getByRole("button", { name: will.composer.send, exact: true }),
    thinking: builder.getByRole("status").filter({ hasText: will.thinking }),
    retry: builder.getByRole("button", { name: will.retry, exact: true }),
    review: page.getByRole("button", { name: will.reviewCta, exact: true }),
    sign: page.getByRole("button", { name: will.review.sign, exact: true }),
    done: page.getByRole("status").filter({ hasText: will.done.title }),
  };
}

/** Waits for the agent's reply: the "writing your rules" status comes and goes. */
async function waitForReply(page: Page) {
  const u = ui(page);
  await u.thinking.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  await u.thinking.waitFor({ state: "hidden", timeout: 30_000 });
  if (await u.retry.isVisible()) throw new Error("the agent's reply failed (the app showed Try again)");
}

async function visit(browser: Browser, args: Args, index: number, plannedAtMs: number, startedAtMs: number): Promise<VisitorLog> {
  const seed = hashSeed(args.seed);
  const d = drawDice(seed, index);
  const log: VisitorLog = {
    index, type: d.type, viewport: d.viewport, plannedAtMs, startedAtMs, seen: "not-looked", first: null,
    messagesPlanned: 0, messagesSent: 0, reviewed: false, signed: false, signBlocked: false, reviewNotOffered: false,
    flagsmithRequests: 0, flushWaitMs: 0, durationMs: 0,
  };
  const t0 = Date.now();
  // A fresh context: empty local storage, so the app makes a fresh anonymous id.
  const context = await browser.newContext({
    viewport: MODEL.viewports[d.viewport], locale: "en-ZA", hasTouch: d.viewport === "phone", isMobile: d.viewport === "phone",
  });
  let inFlight = 0;
  let lastActivity = Date.now();
  const isFlagsmith = (url: string) => { try { return args.flagsmithHost.test(new URL(url).hostname); } catch { return false; } };
  context.on("request", (r) => { if (isFlagsmith(r.url())) { inFlight++; log.flagsmithRequests++; lastActivity = Date.now(); } });
  const done = (r: { url(): string }) => { if (isFlagsmith(r.url())) { inFlight = Math.max(0, inFlight - 1); lastActivity = Date.now(); } };
  context.on("requestfinished", done);
  context.on("requestfailed", done);
  const page = await context.newPage();
  try {
    await page.goto(new URL(args.path, args.baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
    const u = ui(page);
    await u.builder.waitFor({ state: "visible", timeout: 30_000 });
    await sleep(d.pauses.arrive);

    let plan: Decision;
    if (!args.smoke && leavesBeforeLooking(d)) {
      plan = decide(d, "not-looked");
    } else {
      // A click, not check(): ticking the box replaces it with the composer, so check() would wait for a box that's gone.
      await u.consent.click();
      await u.composer.waitFor({ state: "visible", timeout: 15_000 });
      await sleep(d.pauses.consent);
      log.seen = (await u.chips.first().isVisible()) ? "shown" : "not-shown";
      plan = args.smoke ? SMOKE : decide(d, log.seen);
    }
    log.first = plan.first;
    log.messagesPlanned = plan.messages;

    for (let turn = 0; turn < plan.messages; turn++) {
      if (turn > 0) await sleep(d.pauses.turns[Math.min(turn, d.pauses.turns.length - 1)]);
      // Tappers keep tapping while suggestions are shown; typers keep typing.
      if (plan.first === "tap" && (await u.chips.first().isVisible())) {
        await u.chips.first().click();
      } else {
        await u.composer.fill(typedMessage(turn, d.typedPick[turn % d.typedPick.length]));
        await u.send.click();
      }
      log.messagesSent++;
      await waitForReply(page);
    }

    if (plan.review) {
      const offered = await u.review.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
      if (!offered) log.reviewNotOffered = true;
      else {
        await u.review.click();
        await u.sign.waitFor({ state: "visible", timeout: 15_000 });
        log.reviewed = true;
        await sleep(d.pauses.review);
        if (plan.sign) {
          if (await u.sign.isDisabled()) log.signBlocked = true;
          else {
            await u.sign.click();
            await u.done.waitFor({ state: "visible", timeout: 45_000 });
            log.signed = true;
          }
        }
      }
    }
  } catch (e) {
    log.error = (e as Error).message.split("\n")[0].slice(0, 300);
  } finally {
    // Leave as a person closing the tab would: hidden, then pagehide (the app flushes its events on these), then wait
    // until Flagsmith has been quiet for 1.5 s (at most 10 s).
    const flushStart = Date.now();
    try {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
      });
      lastActivity = Math.max(lastActivity, Date.now());
      while (Date.now() - flushStart < 10_000 && (inFlight > 0 || Date.now() - lastActivity < 1_500)) await sleep(100);
    } catch { /* the page may already be gone */ }
    log.flushWaitMs = Date.now() - flushStart;
    await context.close().catch(() => undefined);
    log.durationMs = Date.now() - t0;
  }
  return log;
}

/* ---------- The run ---------- */

type Counts = { visitors: number; firstMessage: number; reviewed: number; signed: number; messages: number; signBlocked: number; reviewNotOffered: number; errors: number };
const zero = (): Counts => ({ visitors: 0, firstMessage: 0, reviewed: 0, signed: 0, messages: 0, signBlocked: 0, reviewNotOffered: 0, errors: 0 });
function add(c: Counts, v: VisitorLog) {
  c.visitors++;
  if (v.messagesSent > 0) c.firstMessage++;
  if (v.reviewed) c.reviewed++;
  if (v.signed) c.signed++;
  c.messages += v.messagesSent;
  if (v.signBlocked) c.signBlocked++;
  if (v.reviewNotOffered) c.reviewNotOffered++;
  if (v.error) c.errors++;
}

function summarise(visitors: VisitorLog[]) {
  const byType: Record<VisitorType, Counts> = { unsure: zero(), knows: zero(), browser: zero() };
  const bySeen: Record<Seen, Counts> = { shown: zero(), "not-shown": zero(), "not-looked": zero() };
  const byTypeAndSeen: Record<string, Counts> = {};
  const total = zero();
  for (const v of visitors) {
    add(total, v);
    add(byType[v.type], v);
    add(bySeen[v.seen], v);
    add((byTypeAndSeen[`${v.type}/${v.seen}`] ??= zero()), v);
  }
  return { total, byType, bySeen, byTypeAndSeen };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = hashSeed(args.seed);
  const plannedAt = arrivals(seed, args.visitors, args.overMs);
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const outDir = join(here, "runs");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${stamp}${args.smoke ? "-smoke" : ""}.json`);

  console.log(`SIMULATED run (${args.env}${args.smoke ? ", smoke" : ""}): ${args.visitors} visitor(s) to ${args.baseUrl.origin}${args.path} over ${args.overMs / 1000}s, seed "${args.seed}", ${args.concurrency} at once`);
  const browser = await chromium.launch({ headless: !args.headed });
  const logs: VisitorLog[] = [];
  const t0 = Date.now();
  let next = 0;
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; console.log("\nStopping after the visitors already in progress…"); });

  const worker = async () => {
    while (!stopping) {
      const i = next++;
      if (i >= args.visitors) return;
      const wait = plannedAt[i] - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
      if (stopping) return;
      const v = await visit(browser, args, i, plannedAt[i], Date.now() - t0).catch((e: Error): VisitorLog => ({
        index: i, type: drawDice(seed, i).type, viewport: "?", plannedAtMs: plannedAt[i], startedAtMs: Date.now() - t0, seen: "not-looked",
        first: null, messagesPlanned: 0, messagesSent: 0, reviewed: false, signed: false, signBlocked: false, reviewNotOffered: false,
        flagsmithRequests: 0, flushWaitMs: 0, durationMs: 0, error: `browser: ${e.message.split("\n")[0].slice(0, 300)}`,
      }));
      logs.push(v);
      const tag = v.error ? `error: ${v.error}` : `${v.seen}, sent ${v.messagesSent}${v.reviewed ? ", reviewed" : ""}${v.signed ? ", signed" : ""}${v.signBlocked ? ", sign blocked" : ""}`;
      console.log(`[${logs.length}/${args.visitors}] #${i} ${v.type} (${v.viewport}): ${tag}`);
      write(false);
    }
  };

  const write = (final: boolean) => {
    const sorted = [...logs].sort((a, b) => a.index - b.index);
    writeFileSync(outFile, JSON.stringify({
      label: "SIMULATED: scripted visitors, not real people. Never add these to Production results.",
      simulated: true,
      smoke: args.smoke,
      complete: final && !stopping,
      environment: args.env,
      target: args.baseUrl.origin + args.path,
      seed: args.seed,
      visitors: args.visitors,
      overMs: args.overMs,
      concurrency: args.concurrency,
      startedAt: startedAt.toISOString(),
      finishedAt: final ? new Date().toISOString() : null,
      method: "docs/simulation.md",
      model: MODEL,
      note: "Counts are by visitor type and by what was on screen (examples shown or not). The simulator never reads the flag value; the versions themselves are in the Simulation environment in Flagsmith.",
      summary: summarise(sorted),
      log: sorted,
    }, null, 2));
  };

  try {
    await Promise.all(Array.from({ length: Math.min(args.concurrency, args.visitors) }, worker));
  } finally {
    await browser.close().catch(() => undefined);
    write(true);
  }
  const s = summarise(logs);
  console.log("\nSIMULATED summary");
  console.table(Object.fromEntries([["all", s.total], ...Object.entries(s.byType), ...Object.entries(s.bySeen).map(([k, v]) => [`seen: ${k}`, v])]));
  console.log(`Written: ${outFile}`);
  if (s.total.errors) console.log(`${s.total.errors} visitor(s) hit an error; see "error" in the log.`);
  if (args.smoke && (s.total.errors || !s.total.signed)) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
