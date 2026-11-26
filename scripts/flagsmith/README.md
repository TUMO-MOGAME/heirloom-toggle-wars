# Flagsmith scripts (plan C7)

Two scripts set up and read the experiment in plan §2:

- `setup.sh <dev|sim|prod|aa> [--dry-run]` creates or confirms the project, flags, variation, metrics and experiment
  for one environment. It is idempotent and prints the ids. It **never starts** an experiment.
- `results.ts <dev|sim|prod|aa>` refreshes an experiment's results, saves a snapshot to
  `docs/results/<mode>-<ISO time>.json` and prints a plain summary.

Neither script prints a key. The environment key is read from an env var, from `.env.local`, or looked up by
environment name. It is masked out of every message, and the snapshot is scrubbed of it before it is saved.

## Prerequisites (Tumo, by hand)

1. **Flagsmith Cloud account, organisation, project "Heirloom", and three environments**: `Development`,
   `Simulation` and `Production` (plan T4). The script can create the project if it's missing, but not the environments.
2. **Experimentation is available on the plan.** It is in beta. If the experiments API answers 403, start the trial
   or check the plan (plan §11).
3. **Connect a warehouse in each environment.** In the dashboard, open Experiments and connect the managed Flagsmith
   warehouse, once per environment. `setup.sh` checks for this and warns, but doesn't connect one.
4. **Install the Flagsmith CLI (v2 or later)** and log in yourself (plan T6). Claude never handles the password.
   - Windows (PowerShell): `irm https://raw.githubusercontent.com/Flagsmith/flagsmith-cli/main/install.ps1 | iex`
   - Or `npm install -g @flagsmith/cli`, or `curl -fsSL https://get.flagsmith.com | sh` in Git Bash
   - Then run `flagsmith --version` (2.x), `flagsmith login` (opens the browser) and `flagsmith auth status`.
5. **Put the client-side keys in `.env.local`** at the repo root (plan T5): `FLAGSMITH_ENV_KEY_DEV=`,
   `FLAGSMITH_ENV_KEY_SIM=` and `FLAGSMITH_ENV_KEY_PROD=`. These are optional for the scripts, which find the
   environment by name if a key is missing.
6. **Node 20 or later**, and `npm install` already run in `app/`. `results.ts` runs with `tsx` from `app/node_modules`,
   and `setup.sh` uses `node` to read JSON, so `jq` isn't needed.

## Environment variables

| Variable | Used by | What it is |
|---|---|---|
| `FLAGSMITH_ENV_KEY_DEV` / `_SIM` / `_PROD` | both | The client-side environment key, from the env var or `.env.local`. Optional: without it, the environment is found by name |
| `FLAGSMITH_ADMIN_TOKEN` | both | Optional. An organisation **Master API key** (`{prefix}.{secret}`), for Tumo's machine only. When it's set, `results.ts` and `setup.sh`'s curl fallback send it as `Authorization: Api-Key …`, and it's passed to the CLI as `FLAGSMITH_API_KEY`. Without it, the CLI's own login is used |
| `FLAGSMITH_ORGANISATION` | setup.sh | The organisation id. It's needed only if the project must be created and you belong to more than one organisation |
| `FLAGSMITH_PROJECT_NAME` | both | Default `Heirloom` |
| `FLAGSMITH_ENV_NAME_DEV` / `_SIM` / `_PROD` | both | Default `Development` / `Simulation` / `Production` |
| `FLAGSMITH_API_URL` | both | Default `https://api.flagsmith.com`. Change it only if self-hosting (plan §11) |
| `FLAGSMITH_DASHBOARD_URL` | setup.sh | Default `https://app.flagsmith.com`, for the printed link |

Never commit a Master API key. Never put one in `.env.local` files that reach Vercel, or anywhere in the app.

## What setup.sh creates

| Item | Scope | Value |
|---|---|---|
| Flag `plan_builder_examples` | project | Multivariate string. Its own value is `control` (the control). One variation, value `blank`, **key `blank`** (a variation without a key records no exposures, so the script checks the key and fixes it if it's missing). Weight 0 on the environment default, as in Flagsmith's guide |
| Flag `experiments_enabled` | project, turned on per environment | Boolean kill switch, on |
| Metric `plan_first_message` | environment | `occurrence`, direction `up`. Attached first, as **primary**, expected `increase` |
| Metrics `plan_reviewed`, `plan_signed` | environment | `occurrence`, `up`. Expected `increase` |
| Metric `plan_message` | environment | `count`, direction `down`. Guardrail, expected `not_increase`. Flagsmith's `count` is the number of events per visitor, and its results compare the mean of that per visitor, which is plan §2's "mean per visitor". Flagsmith's `mean` aggregation would average each event's numeric `value` instead |
| Experiment "Worked examples in the plan builder" | environment | Status `created` (a draft). Rollout 100%, `blank` 50% and control the rest (50%). It's created with `experiment_rollout.enabled: false`, so nothing is served until `/start/` turns the rollout on |

The `aa` mode works on Development only. It creates the flag `aa_check` (control value `same`, and one variation with
value `same` and key `twin`, so the two versions are identical) and its own draft experiment "A/A check", with
`plan_first_message` as its only metric.

Flags and variations belong to the project, so they are shared by all three environments. Metrics and experiments
belong to one environment, so run `setup.sh` once per environment.

Existing items are never changed. If a metric or experiment differs from the plan, the script warns, because the
pre-registration is frozen after the `prereg` tag. A running or completed experiment is never touched.

## Order to run things

All commands below run in Git Bash from the repo root, except `results.ts`, which runs from `app/`.

```bash
# 0. See the plan without changing anything. If the CLI isn't logged in, this makes no calls at all.
bash scripts/flagsmith/setup.sh dev --dry-run

# 1. Development first: the flag is locked while an experiment runs, so get it right here (plan §11)
bash scripts/flagsmith/setup.sh dev
bash scripts/flagsmith/setup.sh aa          # A/A check flag + experiment (plan C11)

# 2. Start the A/A experiment, run 400 simulated visitors at it, then read it
flagsmith api "api/v1/environments/$FLAGSMITH_ENV_KEY_DEV/experiments/<aa id>/start/" -X POST --input - <<< '{}'
(cd app && npx tsx --tsconfig ../scripts/flagsmith/tsconfig.json ../scripts/flagsmith/results.ts aa)

# 3. Simulation and Production, set up as drafts
bash scripts/flagsmith/setup.sh sim
bash scripts/flagsmith/setup.sh prod        # shortly before the start

# 4. Start Production at Thu 26 Nov 06:00 SAST, and Simulation at 08:00 (plan §5)
flagsmith api "api/v1/environments/$FLAGSMITH_ENV_KEY_PROD/experiments/<id>/start/" -X POST --input - <<< '{}'

# 5. Every 12 hours, and at the stop (Sat 28 Nov 14:00 SAST)
cd app
npx tsx --tsconfig ../scripts/flagsmith/tsconfig.json ../scripts/flagsmith/results.ts prod
npx tsx --tsconfig ../scripts/flagsmith/tsconfig.json ../scripts/flagsmith/results.ts sim   # labelled "simulated"
```

The start command uses the key variable, so the key is never typed or shown. Load the variables into the shell first
with `set -a; . ./.env.local; set +a`. Never `echo` them. The A/A start uses the Development key,
and the Production start uses the Production key.

Results can be refreshed at most once every 5 minutes per experiment. `results.ts` handles the 429 response and uses
the last computed figures. Options: `--no-refresh`, `--wait <seconds>` (default 120), `--experiment-id <id>` and
`--out <dir>`.

### Ending and shipping the winner (Sat 28 Nov 14:30, plan §2)

It's done in two steps:

1. **Complete the experiment.** This also sets what the flag serves afterwards (verified in the OpenAPI schema):
   ```bash
   # keep control
   flagsmith api "api/v1/environments/$FLAGSMITH_ENV_KEY_PROD/experiments/<id>/complete/" -X POST --input - <<< '{"rollout_decision":"control"}'
   # or roll out blank
   flagsmith api "api/v1/environments/$FLAGSMITH_ENV_KEY_PROD/experiments/<id>/complete/" -X POST --input - <<< '{"rollout_decision":"variant","rollout_variant":<variation id>}'
   ```
2. **Confirm what visitors get.** Run `flagsmith evaluate --identity some-test-id` in the Production context, then
   check the live site.

## What results.ts reports

- **Exposures per version**: taken from Flagsmith's exposures timeseries, plus the identities excluded for seeing
  both versions.
- **Per metric**: visitors and conversion rate (occurrence metrics), or mean per visitor (`plan_message`).
  "Collecting data" shows below Flagsmith's floors of 50 identities, and 5 conversions per version.
- **Per treatment**: lift, 95% credible interval, chance to beat control and expected loss, from this script's own
  posterior (Beta(1,1)-Binomial, or normal for the count metric, by seeded Monte Carlo on Flagsmith's counts).
  Flagsmith's own lift, interval and chance to win are printed next to them. Flagsmith doesn't compute expected loss
  ("Not currently planned" in its statistics glossary).
- **SRM**: a chi-squared test of exposures against the configured split, with a warning at p < 0.001 once there are
  100 or more identities. Flagsmith's own `srm_p_value` is shown too. In its current source it is usually null for
  experiments like this one, because it reads the split from the environment default, which the rollout resets to 0%.
  That's why the script runs its own check.
- **Decision rule reading** (plan §2): ship `blank`, keep `control`, or inconclusive. In `aa` mode it gives pass or
  fail for a false winner instead. It is only a reading: the decision is made at the stop.
  "The guardrail gets worse" is read as "at least a 95% chance that `blank` raises messages per visitor".

The snapshot's first field is `"data": "real" | "simulated" | "test"`, followed by a `notice` line. Simulation
snapshots say `SIMULATED` in the file and in the printout. Keep them apart from real results (CLAUDE.md).

## Windows notes

- `setup.sh` needs bash 4 or later (it uses an associative array). Git Bash has bash 5, so run it there, not in
  PowerShell or with macOS's bash 3.2.
- The CLI installed by `install.ps1` is a native `.exe`, so it works from Git Bash. An npm-installed CLI is a `.cmd`
  shim: `results.ts` retries through a shell when that happens.
- If Git Bash can't find `flagsmith` after installing, open a new terminal or add `%USERPROFILE%\.local\bin` to `PATH`.

## What was verified (26 Nov 2026), and what wasn't

Verified against the live docs ([experimentation](https://docs.flagsmith.com/experimentation),
[coding-agent set-up](https://docs.flagsmith.com/experimentation/set-up-with-a-coding-agent),
[CLI](https://docs.flagsmith.com/integrating-with-flagsmith/CLI),
[CLI reference](https://flagsmith.github.io/flagsmith-cli/)), against the live OpenAPI schema
(`https://api.flagsmith.com/api/v1/swagger.json`), and against Flagsmith's public source (`api/experimentation/*` in
github.com/Flagsmith/flagsmith, and `internal/cmd/api.go` and `internal/auth/kind.go` in Flagsmith/flagsmith-cli):

- `GET/POST api/v1/environments/<env key>/experiment-metrics/`, with body
  `{name, description, aggregation: count|sum|mean|occurrence, direction: up|down|informational, definition: {version: 1, event}}`
- `GET/POST api/v1/environments/<env key>/experiments/`, with body
  `{feature, name, hypothesis, metrics: [{metric, expected_direction: increase|decrease|not_increase|not_decrease}], experiment_rollout: {enabled, rollout_percentage, feature_state_value: {type, value}, multivariate_feature_state_values: [{multivariate_feature_option, percentage_allocation}]}}`.
  It returns 409 if an active experiment already exists for the flag.
- `GET …/experiments/<id>/`, and `POST …/experiments/<id>/start/`, `/pause/` and `/complete/` (`{rollout_decision: control|variant|disable, rollout_variant?}`)
- `POST …/experiments/<id>/results/refresh/` and `…/exposures/refresh/` (202, or 429 within 5 minutes, or 400
  before the start), and `GET …/results/` and `…/exposures/`, which return
  `{results: {as_of, last_error_at, refresh_requested_at, payload, is_final}}`. Results payload:
  `{srm_p_value, metrics: [{metric_id, variants: {<key>: {n, sum, sum_squares}}, inference: {<key>: {lift, ci_low, ci_high, chance_to_win} | null}}], exposures_timeseries}`
- `GET api/v1/projects/`, `GET api/v1/environments/?project=<id>`, `GET api/v1/projects/<id>/features/?search=`,
  `GET/POST api/v1/projects/<id>/features/<id>/mv-options/` (`key` is writable here, and read-only in the nested
  create), and `GET/PATCH api/v1/environments/<env key>/featurestates/`
- The experiment status is `created` until `/start/`. The rollout written at creation is applied with the `enabled`
  sent, and `/start/` turns it on (`services.enable_experiment_rollout`).
- CLI: `flagsmith login`, `auth status`, `api <path> -X <method> --input <file|->`, and
  `feature create <name> --value --enabled --description`. Also `feature variant add <feature> --value --key --type --weight`,
  `project create <name> --organisation`, `flag enable <name>`, and the global `--project` and `--environment`
  (`FLAGSMITH_ENVIRONMENT`) flags. `FLAGSMITH_API_KEY` sends `Api-Key`, and a login sends `Bearer`.

Not verified (no account yet). Check these on the first real run on Development:

- That a disabled rollout override still serves `control` to everyone before the start, as expected. Check with
  `flagsmith evaluate --identity x` after `setup.sh`.
- That the first attached metric is the one the dashboard shows as primary. The API has no "primary" field.
- That `feature variant add` turns the flag's type into `MULTIVARIATE`. `setup.sh` stops with an error if it doesn't.
- That `flagsmith feature variant update <feature> <id> --key` addresses a variation by id. This is only used to fix
  an unkeyed variation.
- The exact field names in the experiments list (`feature` as an id or an object). Both are handled.
- `flagsmith flag enable` with the environment passed in `FLAGSMITH_ENVIRONMENT`, and whether environments using v2
  feature versioning accept the curl fallback's `PATCH featurestates`.
- Whether the free Cloud plan includes Experimentation (an open question, plan T2).
