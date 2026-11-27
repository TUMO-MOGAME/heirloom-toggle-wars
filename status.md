# Toggle Wars: status

> Read this first. The plan is [plan.md](plan.md); the brief and rules are [docs/toggle-wars.md](docs/toggle-wars.md).

**Last updated:** 2026-11-26 22:00 SAST (Phase 1 built: C1–C8 and the C12 draft; not yet committed)
**Phase:** building, running late. The prereg and the Production start (due Thu 04:30 / 06:00) slipped; the target
start is now Fri 27 Nov morning. We finish Sat 28 Nov and submit by Sun 29 Nov 12:00 SAST.

## Done
- 23 Nov: public repo created from Heirloom a202bc0 (fresh history, prior work disclosed); brief, rules and full plan
  written; Heirloom's own plan and status moved to `docs/heirloom/`.
- 26 Nov: brought in Heirloom up to 676e768 on request (still parked for new Toggle Wars work): security audit, Squads 2-of-3 upgrade authority, Chip in, the hardened program and the guided run. app/, programs/, scripts/, supabase/ are byte-identical to Heirloom main 676e768, which passed 348 program tests, vitest 2405/2405 and both builds. release.json pins the hardened devnet program (slot 526117721, upgraded through Squads proposal 1). Heirloom's plan and status refreshed under `docs/heirloom/`.
- 26 Nov evening, Phase 1 (five agents in parallel), uncommitted:
  - C1: README restructured (experiment first, TODOs for results and line numbers); Heirloom's README moved to
    `docs/heirloom/README.md` (links fixed).
  - C2–C4: `app/src/lib/experiments/` (anon id, SDK 12.6.0 loaded after first paint, 1.5 s fallback to control, kill
    switch, typed events, flush on hide/pagehide) and `/will` wired: `blank` hides the chips; exposure fires when the
    builder shows, before the consent tick; consent ticked while Flagsmith is still loading locks the visit to control
    with nothing sent. Env var `NEXT_PUBLIC_FLAGSMITH_ENVIRONMENT_KEY`. SDK flag cache off: only the anon id is stored.
  - C5: `/try` (reuses the demo reset, lands on `/will`, noindex). C6: Flagsmith (Bullet Train Ltd) added to the
    privacy policy. CSP: `edge.api.flagsmith.com`, `events.api.flagsmith.com`.
  - C7: `scripts/flagsmith/setup.sh <dev|sim|prod|aa> [--dry-run]` and `results.ts`, written against the live API
    docs and source; offline dry run only.
  - C8: `scripts/simulate/` and `docs/simulation.md` (rates fixed; built-in effect ~39% for control, stated plainly).
  - C12 draft: `docs/preregistration.md` (start = actual Production start; stop unchanged Sat 28 14:00). Not tagged.
  - Checks: vitest 2452/2452; `next build`, tsc and eslint clean; simulator smoke run on localhost passed end to end
    (fixed: consent is clicked, not `check()`ed, because ticking replaces the box with the composer).

- 26 Nov 22:40, Phase 2 started:
  - Tumo: Flagsmith project Heirloom (org 42345, project 56686) with Development, Simulation and Production, the
    managed warehouse enabled in each; keys in `.env.local`; Flagsmith CLI v2 logged in; Vercel CLI logged in.
    Experimentation is on the free plan.
  - `setup.sh dev` run for real: experiments_enabled 306250, plan_builder_examples 306251 (variation blank 37487),
    metrics 782–785, experiment 768. Fixed for Windows (temp paths) and expected direction `decrease` for blank.
  - Development experiment 768 **started** (20:34 UTC) as the wiring check. Local site with the Development key,
    4 fresh visitors: 2 blank (no chips) and 2 control (chips); each sent `$flag_exposure` (value = variant,
    experiment_id 768) plus plan_first_message and plan_message, accepted with 202, flushed on hide. Payloads hold
    only the random UUID, event names and the variant: no text or personal data.

- 26 Nov ~23:00, Phase 2 continued:
  - Pushed `main` and tag `prereg` to GitHub (secret scan clean: none of the three keys in any commit).
  - Vercel (CLI, no Git auto-deploy, so no push can change the site mid-experiment): project `heirloom-toggle-wars`
    → https://heirloom-toggle-wars.vercel.app (Production key) and `heirloom-toggle-wars-simulation` →
    https://heirloom-toggle-wars-simulation.vercel.app (Simulation key). Both: Root Directory `app`, deployed from
    the repo root (`.vercelignore`), mock mode, demo clock 60 s. Checked live: each site uses the right key; CSP
    allows Flagsmith; HSTS on. Heirloom's own projects (`heirloom`, `heirloom-devnet`) untouched.
  - Flagsmith drafts: Simulation experiment 778 (metrics 796–799), Production experiment 780 (metrics 801–804),
    A/A experiment 781 on Development (flag aa_check 306265, variation twin 37500). Simulation's warehouse showed
    `pending_connection`: recheck before starting 778.
  - A/A experiment 781 started (20:48 UTC); 400 simulated visitors running against the local site (Development key).
  - C10 launch checks on the live site (Flagsmith blocked during the checks, so no test traffic reached Production):
    360 px no sideways scroll on /try, /will, /, /privacy; plan builder works by touch; axe 0 violations (360 and
    1280); Lighthouse desktop 99–100 perf, 100 a11y; mobile perf /will 90 and 82, / 94 and 89 (Heirloom's app
    bundle; same for both arms). Fixed before the start: wrapped suggestion chips overflowed their pill border at
    360 px (`chat-parts.tsx`, control arm only), commit 8224487, redeployed both sites, checked live.
  - **A/A run 1 (experiment 781) invalid, found by the check itself:** Flagsmith counted 130 exposures from 400
    visitors, all converters (100% in both arms). Cause: the simulator's leave step (`page.evaluate` with a function)
    threw `__name is not defined` under tsx, silently, so no visitor flushed on leave; only visitors who stayed long
    enough for the SDK's own timer were counted. The app was not at fault (a plain-JS probe flushed on hide). Fixed in
    `scripts/simulate/simulate.ts` (string evaluate; flush errors now logged); checked with 8 visitors, every one
    now sends its exposure. 781 completed (rollout control); snapshot kept in
    `docs/results/aa-2026-11-26T21-22-08Z.json` as evidence. A/A run 2 = experiment 791, started 21:24 UTC, 400 new
    simulated visitors.
  - The same bug would have hit the Simulation experiment; it is fixed before that starts.

- **Fri 27 Nov, Phase 3 started:**
  - **Production experiment 780 started 2026-11-27T07:28:21Z (09:28 SAST).** Stops Sat 28 Nov 14:00 SAST
    (12:00 UTC): about 28.5 hours. Wiring check without exposures (identity lookups only): kill switch on, flag on,
    test ids get both `control` and `blank`.
  - Simulation experiment 778 started 2026-11-27T07:28:43Z. Warehouse still `pending_connection` at start; 3 warm-up
    simulated visitors sent (both versions seen, every visitor flushed).
  - Simulator moved to GitHub Actions (`.github/workflows/simulate.yml`): two runners × 1,000 visitors over 4 hours,
    against the Simulation site only, no secrets. Run logs kept as workflow artifacts.

  - Fri 16:12 SAST: GitHub Actions run 45960124675 finished (4 h, success): 2 × 1,000 simulated visitors, 0 errors,
    0 flush errors. Logs kept: `scripts/simulate/runs/2026-11-27T07-41-29-303Z.json` (a) and `…07-41-32-694Z.json`
    (b). Snapshots: `docs/results/sim-2026-11-27T14-12-28Z.json` (simulated: blank 1043 / control 961, SRM p = 0.067;
    first message blank 42.6% vs control 62.1%, lift −31.5%, interval −37.4% to −25.6%, chance blank wins 0%) and
    `docs/results/prod-2026-11-27T14-12-39Z.json` (real: 1 visitor, collecting data).
  - **Decision (Tumo, Fri 16:15):** real visitors can't be found in time, so the **Simulation is the headline result**,
    labelled simulated everywhere. Production still runs to the pre-registered stop (Sat 14:00) and is reported
    honestly with whatever it collects (most likely "not enough data"; the decision rule then keeps `control`). Nothing
    in the pre-registration changes. The README must say plainly that the simulation recovers the effect built into
    the simulator's model (~39% for control, docs/simulation.md): it proves the pipeline finds a known effect, not
    how people behave.

## Next up
- Phase 2 is done (C7–C11 ✅; A/A passed on run 2, `docs/results/aa-check.md`).
- Phase 3 (Fri 27 Nov):
  - Start the Production experiment 780 (record the exact start time here), then the wiring checks (§5a) on
    Production about 1 hour later.
  - Tumo: share `https://heirloom-toggle-wars.vercel.app/try` (plan §7); Claude writes the posts.
  - Start the Simulation experiment 778 and run the simulator against the simulation site (2,000 visitors spread over
    the day; `--env sim --base-url https://heirloom-toggle-wars-simulation.vercel.app`).
  - Every 12 hours: `results.ts prod` and `results.ts sim` snapshots, wiring checks; fix only real bugs and log them.
  - Tumo: screenshot the A/A experiment page in Flagsmith (Development → Experiments → "A/A check (run 2)").
  - Still open for Tumo: T1–T3, T8, T9.
- Never redeploy either site while Production runs (one change only); deploys are by CLI, not on push.

## Decisions log
- 23 Nov: separate repo, not Heirloom's (keeps the Dev3pack repo stable, shows what was built for this event).
- 23 Nov: primary metric is `plan_first_message` (the organisers advise a metric that fires early in a visit).
- 23 Nov: real and simulated traffic in separate Flagsmith environments, never mixed; A/A check first.
- 26 Nov: the guardrail `plan_message` is a Flagsmith `count` metric (compared as mean per visitor); Flagsmith's `mean`
  averages event values, which we don't send. The prereg needs a wording note.
- 26 Nov: experiments are created with the rollout disabled and only enabled by `/start/`, so `blank` isn't served early.
- 26 Nov: `results.ts` computes expected loss and its own SRM test (Flagsmith's SRM p-value is likely null here).
- 26 Nov: real simulator runs are committed as evidence; `*-smoke.json` runs are git-ignored.

- 26 Nov 22:30: Tumo decided the prereg: hypothesis 10% (was 15%, matching the ship bar); guardrail fails if
  messages per visitor rise more than 10%; start when Production starts, stop Sat 28 Nov 14:00. `results.ts` applies
  the 10% guardrail. Phase 1 committed (2786741); prereg committed and tagged `prereg`.

## Blockers
- Flagsmith keys, CLI login and Vercel (T4–T7).
- Unknown whether the free Flagsmith Cloud plan includes Experimentation (the API answers 403 if not).
- Flagsmith's terms conflict on where event data is hosted; confirm with Flagsmith or the legal adviser.
