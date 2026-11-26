/**
 * Toggle Wars (plan §2, §4, §5a, C7): refresh and fetch one experiment's results, save a snapshot, print a summary.
 *
 *   From app/:
 *   npx tsx --tsconfig ../scripts/flagsmith/tsconfig.json ../scripts/flagsmith/results.ts <dev|sim|prod|aa> [options]
 *
 *   --experiment-id <id>   use this experiment instead of looking it up by name
 *   --no-refresh           read the last computed results without asking Flagsmith to recompute
 *   --wait <seconds>       how long to wait for a refresh to land (default 120; Flagsmith computes in the background)
 *   --out <dir>            where snapshots go (default docs/results)
 *
 * Writes docs/results/<env>-<ISO time>.json: Flagsmith's raw results and exposures, plus our own summary. A
 * Simulation snapshot is labelled "simulated" at the top of the file and in the printout, and is never mixed with
 * real numbers. Production is "real"; Development is "test" (local and A/A traffic).
 *
 * Auth (Tumo's machine only, never in the repo or on Vercel): FLAGSMITH_ADMIN_TOKEN (an organisation Master API key,
 * sent as `Authorization: Api-Key …`), or else the Flagsmith CLI's own login, used through `flagsmith api`. The
 * environment key comes from FLAGSMITH_ENV_KEY_DEV/SIM/PROD (env var, or .env.local) or is looked up by name. No key
 * is ever printed or written: the snapshot is scrubbed of the environment key before it is saved.
 *
 * What Flagsmith gives (verified in its source, api/experimentation/stats.py): per metric and version the identity
 * count n, sum and sum of squares; and per treatment lift, a 95% credible interval and chance to win (a normal
 * approximation). It does not give expected loss ("Not currently planned" in its statistics glossary), and its SRM
 * check is skipped for experiments whose split lives in the rollout override (services.py _expected_variant_shares
 * reads the environment default, which the rollout resets to 0%). So this script also computes, from the same
 * counts: a Beta-Binomial (occurrence) or normal (count) posterior by seeded Monte Carlo, giving chance to beat
 * control, the 95% interval of the relative lift, expected loss, and a chi-squared SRM test against the configured
 * split. Both sets are printed and saved, each labelled with where it came from.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- settings (plan §2) ----------
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const API_URL = (process.env.FLAGSMITH_API_URL || "https://api.flagsmith.com").replace(/\/+$/, "");
const PROJECT_NAME = process.env.FLAGSMITH_PROJECT_NAME || "Heirloom";

type Mode = "dev" | "sim" | "prod" | "aa";
const MODES: Record<Mode, { envName: string; envVar: string; experiment: string; label: DataLabel }> = {
  dev: { envName: process.env.FLAGSMITH_ENV_NAME_DEV || "Development", envVar: "FLAGSMITH_ENV_KEY_DEV", experiment: "Worked examples in the plan builder", label: "test" },
  sim: { envName: process.env.FLAGSMITH_ENV_NAME_SIM || "Simulation", envVar: "FLAGSMITH_ENV_KEY_SIM", experiment: "Worked examples in the plan builder", label: "simulated" },
  prod: { envName: process.env.FLAGSMITH_ENV_NAME_PROD || "Production", envVar: "FLAGSMITH_ENV_KEY_PROD", experiment: "Worked examples in the plan builder", label: "real" },
  aa: { envName: process.env.FLAGSMITH_ENV_NAME_DEV || "Development", envVar: "FLAGSMITH_ENV_KEY_DEV", experiment: "A/A check", label: "test" },
};
type DataLabel = "real" | "simulated" | "test";

const PRIMARY = "plan_first_message";
const GUARDRAIL = "plan_message";
const MIN_IDENTITIES = 50; // Flagsmith's floors (experimentation/constants.py)
const MIN_CONVERSIONS = 5;
const SRM_MIN_TOTAL = 100;
const SRM_ALPHA = 0.001;
const DRAWS = 200_000;
// Decision rule, fixed in plan §2 (read here, decided only at the stop: Sat 28 Nov 14:00 SAST).
const SHIP_CHANCE = 0.95;
const SHIP_MIN_LIFT = 0.1;

// ---------- Flagsmith result shapes (from its source: experimentation/dataclasses.py, stats.py, serializers.py) ----------
export interface VariantStats { n: number; sum: number; sum_squares: number }
export interface Inference { lift: number; ci_low: number; ci_high: number; chance_to_win: number }
interface MetricResult { metric_id: number; variants: Record<string, VariantStats>; inference: Record<string, Inference | null> }
interface ResultsPayload { srm_p_value: number | null; metrics: MetricResult[]; exposures_timeseries?: { granularity: string; points: { bucket: string; new_identities: Record<string, number> }[] } }
interface Computation<P> { as_of: string | null; last_error_at: string | null; refresh_requested_at: string | null; payload: P | null; is_final: boolean }
interface ExposuresPayload { excluded_identities: number; timeseries: { granularity: string; points: { bucket: string; new_identities: Record<string, number> }[] } }
interface ExperimentMetricRef { id: number; metric: number; metric_name: string; aggregation: string; direction: string; expected_direction: string }
interface MvOption { id: number; key?: string | null; string_value?: string | null; value?: unknown }
interface ExperimentDetail {
  id: number; name: string; hypothesis: string; status: string; started_at: string | null; ended_at: string | null;
  feature: { id: number; name: string; initial_value: string | null; multivariate_options: MvOption[] } | number;
  metrics: ExperimentMetricRef[];
  experiment_rollout: { rollout_percentage?: number; multivariate_feature_state_values?: { multivariate_feature_option: number; percentage_allocation: number }[] } | null;
}

// ---------- arguments ----------
function parseArgs(argv: string[]) {
  const mode = argv[0] as Mode;
  if (!mode || !(mode in MODES)) {
    console.error("usage: results.ts <dev|sim|prod|aa> [--experiment-id <id>] [--no-refresh] [--wait <seconds>] [--out <dir>]");
    process.exit(2);
  }
  const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    mode,
    experimentId: opt("--experiment-id") ? Number(opt("--experiment-id")) : undefined,
    refresh: !argv.includes("--no-refresh"),
    waitSeconds: Number(opt("--wait") ?? 120),
    outDir: resolve(ROOT, opt("--out") ?? join("docs", "results")),
  };
}

// ---------- secrets: read, never shown ----------
function loadEnvLocal(): void {
  for (const p of [join(ROOT, ".env.local"), join(ROOT, "app", ".env.local")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*(FLAGSMITH_[A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}
const secrets: string[] = [];
const mask = (s: string) => secrets.reduce((acc, k) => (k ? acc.split(k).join("<redacted>") : acc), s);

// ---------- transport ----------
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const p = path.replace(/^\/+/, "");
  const token = process.env.FLAGSMITH_ADMIN_TOKEN;
  if (token) {
    const res = await fetch(`${API_URL}/${p}`, {
      method,
      headers: { Authorization: `Api-Key ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, mask(`${method} ${p} returned ${res.status}: ${text.slice(0, 500)}`));
    return (text ? JSON.parse(text) : null) as T;
  }
  // The CLI's own login (OAuth) or FLAGSMITH_API_KEY; `flagsmith api` applies it. It exits non-zero on HTTP errors.
  const args = ["api", p, "-X", method, ...(body !== undefined ? ["--input", "-"] : [])];
  const run = (shell: boolean) => execFileSync("flagsmith", args, {
    input: body !== undefined ? JSON.stringify(body) : undefined,
    encoding: "utf8",
    env: { ...process.env, FLAGSMITH_NO_INPUT: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    shell,
  });
  try {
    let out: string;
    try { out = run(false); }
    catch (e) {
      // On Windows an npm-installed CLI is a .cmd shim, which only runs through a shell. Paths here never hold '&'.
      const code = (e as { code?: string }).code;
      if (process.platform === "win32" && (code === "ENOENT" || code === "EINVAL")) out = run(true);
      else throw e;
    }
    return (out.trim() ? JSON.parse(out) : null) as T;
  } catch (e) {
    const err = e as { stderr?: string; code?: string; message: string };
    if (err.code === "ENOENT" || /not recognized as an internal or external command/.test(String(err.stderr))) {
      throw new Error("Neither FLAGSMITH_ADMIN_TOKEN nor the Flagsmith CLI is available. See scripts/flagsmith/README.md.");
    }
    const text = mask(String(err.stderr || err.message));
    const status = Number(/returned (\d{3})/.exec(text)?.[1] ?? 0);
    throw new HttpError(status, text.trim().slice(0, 800));
  }
}
const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : x && Array.isArray((x as { results?: T[] }).results) ? (x as { results: T[] }).results : []);

async function environmentKey(envVar: string, envName: string): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const project = list<{ id: number; name: string }>(await api("GET", "api/v1/projects/")).find((p) => p.name === PROJECT_NAME);
  if (!project) throw new Error(`Project "${PROJECT_NAME}" not found.`);
  const env = list<{ name: string; api_key: string }>(await api("GET", `api/v1/environments/?project=${project.id}`)).find((e) => e.name === envName);
  if (!env) throw new Error(`Environment "${envName}" not found in "${PROJECT_NAME}".`);
  return env.api_key;
}

// ---------- statistics (our own, from Flagsmith's counts) ----------
/** Small, seeded generator so the same counts always give the same numbers in the snapshot. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(u: () => number): number { let x = 0; while (x === 0) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); }
/** Marsaglia–Tsang gamma sampler (shape k > 0, scale 1). */
function gamma(k: number, u: () => number): number {
  if (k < 1) return gamma(k + 1, u) * Math.pow(u() || 1e-12, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { x = normal(u); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const w = u();
    if (w < 1 - 0.0331 * x ** 4 || Math.log(w) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const beta = (a: number, b: number, u: () => number) => { const x = gamma(a, u); return x / (x + gamma(b, u)); };
const quantile = (sorted: Float64Array, q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

export interface OurInference {
  method: string; control_mean: number; treatment_mean: number; lift: number;
  ci95_low: number; ci95_high: number; chance_to_beat_control: number;
  expected_loss_ship_treatment: number; expected_loss_keep_control: number;
}
/**
 * Posterior comparison of treatment against control. "Beat" means moving the metric the good way: up for
 * higher-is-better, down for lower-is-better (the guardrail). Expected loss is in the metric's own units
 * (conversion-rate points, or messages per visitor): how much we'd lose on average if the choice were wrong.
 */
export function compare(control: VariantStats, treatment: VariantStats, aggregation: string, lowerIsBetter: boolean, seed = 20261126): OurInference | null {
  if (control.n < 2 || treatment.n < 2) return null;
  const u = rng(seed);
  const occurrence = aggregation === "occurrence";
  const draw = (s: VariantStats) => {
    if (occurrence) return () => beta(1 + s.sum, 1 + s.n - s.sum, u); // uniform Beta(1,1) prior
    const mean = s.sum / s.n;
    const variance = Math.max(0, (s.sum_squares - (s.sum * s.sum) / s.n) / (s.n - 1));
    const se = Math.sqrt(variance / s.n);
    return () => mean + se * normal(u); // normal approximation to the mean, as Flagsmith uses
  };
  const dc = draw(control), dt = draw(treatment);
  const lifts = new Float64Array(DRAWS);
  let wins = 0, lossShip = 0, lossKeep = 0;
  for (let i = 0; i < DRAWS; i++) {
    const c = dc(), t = dt();
    lifts[i] = c !== 0 ? (t - c) / c : 0;
    const gain = lowerIsBetter ? c - t : t - c; // > 0 when the treatment is better
    if (gain > 0) wins++;
    lossShip += Math.max(-gain, 0);
    lossKeep += Math.max(gain, 0);
  }
  lifts.sort();
  const cm = control.sum / control.n, tm = treatment.sum / treatment.n;
  return {
    method: occurrence ? "Beta-Binomial, Beta(1,1) prior, Monte Carlo" : "normal approximation to each mean, Monte Carlo",
    control_mean: cm, treatment_mean: tm, lift: cm !== 0 ? (tm - cm) / cm : NaN,
    ci95_low: quantile(lifts, 0.025), ci95_high: quantile(lifts, 0.975),
    chance_to_beat_control: wins / DRAWS,
    expected_loss_ship_treatment: lossShip / DRAWS, expected_loss_keep_control: lossKeep / DRAWS,
  };
}

/** Chi-squared survival for integer degrees of freedom (exact), as in Flagsmith's stats.py. */
function chiSquaredSurvival(x: number, df: number): number {
  if (x <= 0) return 1;
  const y = x / 2;
  let a: number, s: number;
  if (df % 2) { a = 0.5; s = erfc(Math.sqrt(y)); } else { a = 1; s = Math.exp(-y); }
  while (a + 1 <= df / 2) { s += Math.exp(a * Math.log(y) - y - lgamma(a + 1)); a += 1; }
  return s;
}
function erfc(x: number): number { // Numerical Recipes erfcc, |error| < 1.2e-7
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628288 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
function lgamma(x: number): number { // Lanczos
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
export function srm(observed: Record<string, number>, shares: Record<string, number>): { p_value: number | null; total: number; checked: boolean } {
  const keys = Object.keys(shares);
  const total = keys.reduce((s, k) => s + (observed[k] ?? 0), 0);
  if (keys.length < 2 || total === 0 || keys.some((k) => shares[k] <= 0)) return { p_value: null, total, checked: false };
  const stat = keys.reduce((s, k) => s + ((observed[k] ?? 0) - total * shares[k]) ** 2 / (total * shares[k]), 0);
  return { p_value: chiSquaredSurvival(stat, keys.length - 1), total, checked: total >= SRM_MIN_TOTAL };
}

// ---------- main ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(d)}%`);
const num = (x: number | null | undefined, d = 3) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(d));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = MODES[args.mode];
  loadEnvLocal();
  if (process.env.FLAGSMITH_ADMIN_TOKEN) secrets.push(process.env.FLAGSMITH_ADMIN_TOKEN);
  const envKey = await environmentKey(cfg.envVar, cfg.envName);
  secrets.push(envKey);
  const E = `api/v1/environments/${envKey}`;

  // the experiment
  let experimentId = args.experimentId;
  if (!experimentId) {
    const all = list<{ id: number; name: string; status: string }>(await api("GET", `${E}/experiments/?page_size=100`));
    const found = all.filter((x) => x.name === cfg.experiment).sort((a, b) => Number(a.status === "completed") - Number(b.status === "completed") || b.id - a.id)[0];
    if (!found) throw new Error(`No experiment named "${cfg.experiment}" in ${cfg.envName}. Run setup.sh first.`);
    experimentId = found.id;
  }
  const experiment = await api<ExperimentDetail>("GET", `${E}/experiments/${experimentId}/`);
  const feature = typeof experiment.feature === "object" ? experiment.feature : null;

  // refresh (at most once per 5 minutes per experiment; Flagsmith answers 429 inside that window)
  const notes: string[] = [];
  const before = (await api<{ results: Computation<ResultsPayload> | null }>("GET", `${E}/experiments/${experimentId}/results/`)).results;
  if (args.refresh && experiment.started_at && !before?.is_final) {
    for (const what of ["results", "exposures"] as const) {
      try { await api("POST", `${E}/experiments/${experimentId}/${what}/refresh/`, {}); }
      catch (e) {
        const h = e as HttpError;
        notes.push(h.status === 429 ? `${what}: refreshed less than 5 minutes ago; using the last computed figures` : `${what} refresh failed: ${h.message}`);
      }
    }
  } else if (!experiment.started_at) notes.push("experiment not started yet: Flagsmith has nothing to compute");

  // wait for the refresh to land
  let results = before;
  const deadline = Date.now() + args.waitSeconds * 1000;
  for (;;) {
    results = (await api<{ results: Computation<ResultsPayload> | null }>("GET", `${E}/experiments/${experimentId}/results/`)).results;
    const landed = !results?.refresh_requested_at || (results.as_of && results.as_of >= results.refresh_requested_at) || (results.last_error_at && results.last_error_at >= results.refresh_requested_at);
    if (!args.refresh || landed || Date.now() > deadline) {
      if (args.refresh && !landed) notes.push(`refresh still computing after ${args.waitSeconds}s; these are the previous figures (as of ${results?.as_of ?? "never"})`);
      break;
    }
    await sleep(5000);
  }
  if (results?.last_error_at && (!results.as_of || results.last_error_at > results.as_of)) notes.push(`Flagsmith's last computation failed at ${results.last_error_at}; showing the last good figures`);
  const exposures = (await api<{ exposures: Computation<ExposuresPayload> | null }>("GET", `${E}/experiments/${experimentId}/exposures/`)).exposures;

  // names and split
  const optionKey = new Map<number, string>((feature?.multivariate_options ?? []).map((o) => [o.id, o.key ?? `option-${o.id}`]));
  const configured = experiment.experiment_rollout?.multivariate_feature_state_values ?? [];
  const shares: Record<string, number> = {};
  let allocated = 0;
  for (const mv of configured) { shares[optionKey.get(mv.multivariate_feature_option) ?? `option-${mv.multivariate_feature_option}`] = mv.percentage_allocation / 100; allocated += mv.percentage_allocation; }
  if (configured.length) shares.control = (100 - allocated) / 100;
  else { notes.push("rollout split not returned; SRM tested against 50/50"); shares.control = 0.5; for (const o of feature?.multivariate_options ?? []) if (o.key) shares[o.key] = 0.5; }
  const metricName = new Map(experiment.metrics.map((m) => [m.metric, m]));

  // exposures per version: from the exposures timeseries (identities first exposed per bucket), else the metrics' n
  const payload = results?.payload ?? null;
  const exposureCounts: Record<string, number> = {};
  const series = exposures?.payload?.timeseries?.points ?? payload?.exposures_timeseries?.points ?? [];
  for (const p of series) for (const [k, v] of Object.entries(p.new_identities)) exposureCounts[k] = (exposureCounts[k] ?? 0) + v;
  if (!Object.keys(exposureCounts).length && payload?.metrics[0]) for (const [k, v] of Object.entries(payload.metrics[0].variants)) exposureCounts[k] = v.n;
  const ourSrm = srm(exposureCounts, shares);
  const srmWarning = (ourSrm.checked && ourSrm.p_value != null && ourSrm.p_value < SRM_ALPHA) || (payload?.srm_p_value != null && payload.srm_p_value < SRM_ALPHA);

  // per metric
  const metrics = (payload?.metrics ?? []).map((m, index) => {
    const ref = metricName.get(m.metric_id);
    const name = ref?.metric_name ?? `metric-${m.metric_id}`;
    const aggregation = ref?.aggregation ?? "occurrence";
    const lowerIsBetter = ref?.direction === "down";
    const control = m.variants.control;
    const versions = Object.fromEntries(Object.entries(m.variants).map(([k, v]) => [k, {
      identities: v.n, total: v.sum,
      [aggregation === "occurrence" ? "conversion_rate" : "mean_per_visitor"]: v.n ? v.sum / v.n : null,
      collecting_data: v.n < MIN_IDENTITIES || (aggregation === "occurrence" && v.sum < MIN_CONVERSIONS),
    }]));
    const treatments = Object.keys(m.variants).filter((k) => k !== "control");
    const comparisons = Object.fromEntries(treatments.map((k) => [k, {
      flagsmith: m.inference?.[k] ?? null,
      ours: control ? compare(control, m.variants[k], aggregation, lowerIsBetter) : null,
    }]));
    return {
      metric_id: m.metric_id, name, aggregation, direction: ref?.direction ?? null, expected_direction: ref?.expected_direction ?? null,
      role: name === PRIMARY || index === 0 ? "primary" : ref?.expected_direction?.startsWith("not_") ? "guardrail" : "secondary",
      versions, comparisons,
    };
  });

  // decision rule reading (plan §2). For the A/A check the rule is: no false winner.
  const primary = metrics.find((m) => m.role === "primary");
  const guard = metrics.find((m) => m.name === GUARDRAIL);
  const treatment = primary ? Object.keys(primary.comparisons)[0] : undefined;
  let reading = "no results yet (collecting data)";
  if (primary && treatment) {
    const ours = primary.comparisons[treatment].ours;
    const collecting = Object.values(primary.versions).some((v) => v.collecting_data);
    // The guardrail "gets worse" if the treatment is more likely than not to raise messages per visitor at 95%.
    const gOurs = guard?.comparisons[treatment]?.ours;
    const guardrailWorse = gOurs ? 1 - gOurs.chance_to_beat_control >= SHIP_CHANCE : false;
    if (collecting || !ours) reading = "collecting data: below Flagsmith's floor (50 identities and 5 conversions per version)";
    else if (args.mode === "aa") reading = ours.chance_to_beat_control >= SHIP_CHANCE || ours.chance_to_beat_control <= 1 - SHIP_CHANCE ? `A/A FAIL: a false winner (${pct(ours.chance_to_beat_control)} chance to beat control)` : "A/A pass on the primary metric: no winner";
    else if (ours.chance_to_beat_control >= SHIP_CHANCE && ours.lift >= SHIP_MIN_LIFT && !guardrailWorse) reading = `ship ${treatment}: ${pct(ours.chance_to_beat_control)} chance to beat control, lift ${pct(ours.lift)}, guardrail not worse`;
    else if (1 - ours.chance_to_beat_control >= SHIP_CHANCE) reading = `keep control: ${pct(1 - ours.chance_to_beat_control)} chance control is best`;
    else reading = `inconclusive: keep control as the safer default (chance ${treatment} beats control ${pct(ours.chance_to_beat_control)}, 95% interval ${pct(ours.ci95_low)} to ${pct(ours.ci95_high)}${guardrailWorse ? ", guardrail worse" : ""})`;
  }

  // snapshot
  const now = new Date();
  const label = cfg.label;
  const snapshot = {
    data: label,
    notice: label === "simulated" ? "SIMULATED: synthetic visitors from scripts/simulate (docs/simulation.md). Never add to the real results."
      : label === "real" ? "Real visitors (Production)." : "Test traffic (Development): local runs and the A/A check. Not real visitors.",
    environment: cfg.envName, mode: args.mode, fetched_at: now.toISOString(),
    experiment: { id: experiment.id, name: experiment.name, status: experiment.status, started_at: experiment.started_at, ended_at: experiment.ended_at, flag: feature?.name ?? null },
    results_as_of: results?.as_of ?? null, results_final: results?.is_final ?? false, notes,
    summary: {
      exposures: exposureCounts, excluded_identities: exposures?.payload?.excluded_identities ?? null,
      srm: { configured_split: shares, ours: ourSrm, flagsmith_p_value: payload?.srm_p_value ?? null, warning: srmWarning, threshold: SRM_ALPHA },
      metrics, decision_rule_reading: reading,
      reading_note: "A reading, not a decision: plan §2 decides only at the stop (Sat 28 Nov 14:00 SAST). Expected loss and our interval come from this script; Flagsmith's own numbers are under comparisons.*.flagsmith.",
    },
    flagsmith_raw: { experiment, results, exposures },
  };
  mkdirSync(args.outDir, { recursive: true });
  const stamp = now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-"); // no ':' in Windows file names
  const file = join(args.outDir, `${args.mode}-${stamp}.json`);
  writeFileSync(file, mask(JSON.stringify(snapshot, null, 2)) + "\n");

  // printout
  const L: string[] = [];
  const banner = label === "simulated" ? "  *** SIMULATED DATA: not real visitors ***" : label === "test" ? "  (test traffic, Development)" : "  (real visitors, Production)";
  L.push(`${experiment.name}: ${cfg.envName}${banner}`);
  L.push(`status ${experiment.status}, started ${experiment.started_at ?? "not yet"}, results as of ${results?.as_of ?? "never"}`);
  for (const n of notes) L.push(`note: ${n}`);
  L.push("", "Exposures per version: " + (Object.entries(exposureCounts).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet") + (exposures?.payload ? `; excluded (saw both) ${exposures.payload.excluded_identities}` : ""));
  L.push(srmWarning ? `SRM WARNING: traffic did not split as configured (p = ${num(ourSrm.p_value, 5)}). Do not act on these results.`
    : `SRM: ${ourSrm.checked ? `ok (p = ${num(ourSrm.p_value, 4)})` : `not checked yet (needs ${SRM_MIN_TOTAL} identities)`}; Flagsmith's own p = ${num(payload?.srm_p_value, 4)}`);
  for (const m of metrics) {
    L.push("", `${m.name} [${m.role}, ${m.aggregation}, expected ${m.expected_direction}]`);
    for (const [k, v] of Object.entries(m.versions)) {
      const value = "conversion_rate" in v ? `conversion ${pct(v.conversion_rate as number)}` : `mean per visitor ${num(v.mean_per_visitor as number, 2)}`;
      L.push(`  ${k.padEnd(8)} ${String(v.identities).padStart(6)} visitors, ${value}${v.collecting_data ? "  (collecting data)" : ""}`);
    }
    for (const [k, c] of Object.entries(m.comparisons)) {
      if (c.ours) L.push(`  ${k} vs control: lift ${pct(c.ours.lift)}, 95% credible interval ${pct(c.ours.ci95_low)} to ${pct(c.ours.ci95_high)}, chance to beat control ${pct(c.ours.chance_to_beat_control)}, expected loss if shipped ${num(c.ours.expected_loss_ship_treatment, 4)}`);
      if (c.flagsmith) L.push(`  (Flagsmith: lift ${pct(c.flagsmith.lift)}, interval ${pct(c.flagsmith.ci_low)} to ${pct(c.flagsmith.ci_high)}, chance to win ${pct(c.flagsmith.chance_to_win)})`);
      else L.push("  (Flagsmith: collecting data)");
    }
  }
  L.push("", `Decision rule reading: ${reading}`, "(A reading only; the decision is made at the stop, Sat 28 Nov 14:00 SAST.)", "", `Saved ${file.replace(ROOT, ".")}`);
  console.log(mask(L.join("\n")));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(mask(e instanceof Error ? e.message : String(e))); process.exit(1); });
