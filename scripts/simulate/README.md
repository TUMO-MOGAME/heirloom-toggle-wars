# The simulator

Scripted visitors through the real plan builder, by the visitor types published in
[docs/simulation.md](../../docs/simulation.md) before any run. Everything it writes is labelled **simulated**; it is
never added to the Production results.

- `simulate.ts`: the run (Playwright, Chromium): arguments, the safety gate, one fresh browser context per visitor.
- `model.ts`: the published visitor model (types, rates, message counts, pauses), the seeded generator and the
  arrival times. Change it only together with `docs/simulation.md`, and never after the first run.
- `runs/<time>.json`: one log per run (summary by visitor type and by what was on screen, then every visitor).

## Once

```sh
cd app
npm install
npx playwright install chromium
```

## Run (always from `app/`)

```sh
# Smoke test: start the app (npm run dev) in another terminal, then one visitor who goes all the way
npx tsx --tsconfig ../scripts/simulate/tsconfig.json ../scripts/simulate/simulate.ts --env dev --base-url http://localhost:3000 --smoke

# A few local visitors with the published behaviour
npx tsx --tsconfig ../scripts/simulate/tsconfig.json ../scripts/simulate/simulate.ts --env dev --base-url http://localhost:3000 --visitors 10 --seed try1

# The real simulation: the Simulation deployment (the simulation branch's URL), spread over the day
npx tsx --tsconfig ../scripts/simulate/tsconfig.json ../scripts/simulate/simulate.ts --env sim --base-url https://<the simulation branch URL> --visitors 2000 --over 8h --seed toggle-wars --concurrency 4
```

| Option | |
|---|---|
| `--base-url` | Required. The site to visit. |
| `--env sim\|dev` | Required. `dev`: localhost only. `sim`: https, and the host must contain `simulation` (the Vercel branch URL does). The Production host `heirloom-toggle-wars.vercel.app` and Heirloom's own sites are always refused. |
| `--visitors N` | How many visitors (default 1). |
| `--over 8h` | Spread the arrivals over this long (`90s`, `20m`, `8h`, `1h30m`; default 0, all at once). |
| `--seed s` | Seed for every random draw, so a run's visitors and their choices can be repeated (default: the time). |
| `--concurrency N` | Browsers at once (default 4). An arrival waits for a free browser; the delay is in the log. |
| `--path /try` | Where visitors start (default `/try`, which opens the plan builder as a new owner). |
| `--flagsmith-host re` | Which hosts count as Flagsmith when waiting for the event flush (default `flagsmith.com` and its subdomains). |
| `--smoke` | One visitor who types, reviews and signs. Labelled `smoke` and left out of any results; exits 1 if it didn't sign. |
| `--headed` | Show the browsers (for debugging). |

Ctrl+C stops starting new visitors, finishes the ones in progress and writes the log. The log is rewritten after
every visitor, so a crash keeps what was done (`"complete": false`).

## How it finds things on screen

By role and accessible name, using the app's own English copy (imported from `app/src/content`), so a copy change
can't silently break it. It reads only what is visible, never the flag value.

| What | Locator | Copy |
|---|---|---|
| The plan builder | `region` named | `screens.will.eyebrow` |
| Consent box | `checkbox` in the builder, name starts with | `common.consent.before` |
| Suggested replies | `button`s in the `group` named | `screens.will.suggestionsLabel` |
| Message box | `textbox` named | `screens.will.composer.inputLabel` |
| Send | `button` named | `screens.will.composer.send` |
| Agent is replying | `status` with text | `screens.will.thinking` |
| Reply failed | `button` named | `screens.will.retry` |
| Review | `button` named | `screens.will.reviewCta` |
| Sign | `button` named | `screens.will.review.sign` |
| Signed | `status` with text | `screens.will.done.title` |

## Type-check

```sh
cd app
npx tsc -p ../scripts/simulate/tsconfig.json
```
