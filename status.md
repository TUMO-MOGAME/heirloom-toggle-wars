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

## Next up
- Tumo: decide the prereg fixes (Blockers), then T4–T7: Flagsmith project + 3 environments + the managed warehouse in
  each; keys in `.env.local` (`FLAGSMITH_ENV_KEY_DEV/SIM/PROD` for the scripts; each deployment gets its own key as
  `NEXT_PUBLIC_FLAGSMITH_ENVIRONMENT_KEY`); Flagsmith CLI v2 + `flagsmith login`; the Vercel project. Still T1–T3, T8, T9.
- Claude, Phase 2 (needs keys): commit Phase 1 and tag `prereg`; `setup.sh dev --dry-run` then for real; C9 deploy
  (prod + `simulation` branch; its hostname must contain "simulation"); C10 launch checks; C11 A/A (the app must also
  send exposures for `aa_check`).
- Then: start Production, wiring checks (§5a), start Simulation and the simulator.

## Decisions log
- 23 Nov: separate repo, not Heirloom's (keeps the Dev3pack repo stable, shows what was built for this event).
- 23 Nov: primary metric is `plan_first_message` (the organisers advise a metric that fires early in a visit).
- 23 Nov: real and simulated traffic in separate Flagsmith environments, never mixed; A/A check first.
- 26 Nov: the guardrail `plan_message` is a Flagsmith `count` metric (compared as mean per visitor); Flagsmith's `mean`
  averages event values, which we don't send. The prereg needs a wording note.
- 26 Nov: experiments are created with the rollout disabled and only enabled by `/start/`, so `blank` isn't served early.
- 26 Nov: `results.ts` computes expected loss and its own SRM test (Flagsmith's SRM p-value is likely null here).
- 26 Nov: real simulator runs are committed as evidence; `*-smoke.json` runs are git-ignored.

## Blockers
- Prereg not frozen until Tumo decides: (1) the hypothesis says 15% but the ship bar is 10%; (2) a numeric guardrail
  margin; (3) the later start. `docs/toggle-wars.md` must also stop saying every later commit is Toggle Wars work.
- Flagsmith keys, CLI login and Vercel (T4–T7).
- Unknown whether the free Flagsmith Cloud plan includes Experimentation (the API answers 403 if not).
- Flagsmith's terms conflict on where event data is hosted; confirm with Flagsmith or the legal adviser.
