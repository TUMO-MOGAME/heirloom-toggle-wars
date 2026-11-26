#!/usr/bin/env bash
# Toggle Wars (plan §2, §4, C7): create or confirm everything Flagsmith needs for one environment.
#
#   scripts/flagsmith/setup.sh <dev|sim|prod|aa> [--dry-run]
#
#   dev | sim | prod   the main experiment "Worked examples in the plan builder" in Development, Simulation or
#                      Production: flags plan_builder_examples (control + keyed "blank", 50/50) and
#                      experiments_enabled (on), the four metrics, and the experiment as a DRAFT (never started).
#   aa                 the A/A check on Development: flag aa_check with two identical versions and its own draft
#                      experiment "A/A check".
#   --dry-run          print what would be done; never writes. Reads are made only if the CLI is logged in.
#
# Idempotent: every step looks first and only creates what is missing. Existing metrics and experiments are
# never changed (pre-registration), only reported, with a warning if they differ from the plan.
#
# Auth: the Flagsmith CLI's own login (`flagsmith login`, done by Tumo) or a Master API key in
# FLAGSMITH_ADMIN_TOKEN (Tumo's machine only). Keys are never printed: the environment key is looked up by name,
# kept in a variable, and masked out of any error text.
#
# Endpoints and commands: see scripts/flagsmith/README.md ("What was verified").

set -euo pipefail

# ---------- settings (plan §2; frozen after the prereg tag) ----------
PROJECT_NAME="${FLAGSMITH_PROJECT_NAME:-Heirloom}"
API_URL="${FLAGSMITH_API_URL:-https://api.flagsmith.com}"
DASHBOARD_URL="${FLAGSMITH_DASHBOARD_URL:-https://app.flagsmith.com}"

EXP_FLAG="plan_builder_examples"
EXP_CONTROL_VALUE="control"
EXP_VARIANT_VALUE="blank"
EXP_VARIANT_KEY="blank"
EXP_NAME="Worked examples in the plan builder"
EXP_HYPOTHESIS="People don't know how to describe an estate plan. Seeing worked examples makes the first step easy, so with examples at least 10% more visitors send a first message, and more reach 'review my plan'. Pre-registered: docs/preregistration.md (tag prereg)."  # docs/preregistration.md, the frozen version

AA_FLAG="aa_check"
AA_CONTROL_VALUE="same"
AA_VARIANT_VALUE="same"   # identical on purpose: an A/A check
AA_VARIANT_KEY="twin"
AA_NAME="${FLAGSMITH_AA_NAME:-A/A check}"   # a fresh A/A needs a new name (a completed one is never reused)
AA_HYPOTHESIS="A/A check of the wiring (plan C11): two identical versions. Expect about 50/50 exposures, no sample ratio mismatch and no winner on plan_first_message."

KILL_FLAG="experiments_enabled"
SPLIT_PERCENT=50       # the variation's share inside the experiment; control gets the rest
ROLLOUT_PERCENT=100    # every visitor who reaches the plan builder enters
VARIANT_ENV_WEIGHT=0   # the variation's weight on the environment default, as in Flagsmith's coding-agent guide.
                       # Flagsmith resets it to 0 itself when the experiment's rollout is first applied.

# metric name | aggregation | metric direction | expected direction in the experiment
# Flagsmith's "count" is per-identity event count; its results compare the mean of that per visitor, which is
# plan §2's "mean per visitor". (Flagsmith's "mean" aggregation averages each event's numeric `value` instead,
# which our events don't carry, so it would be the wrong one.)
# expected_direction is for the variation (blank) against control: the hypothesis (docs/preregistration.md) expects blank to be lower.
METRICS=(
  "plan_first_message|occurrence|up|decrease"
  "plan_reviewed|occurrence|up|decrease"
  "plan_signed|occurrence|up|decrease"
  "plan_message|count|down|not_increase"
)
AA_METRICS=("plan_first_message|occurrence|up|increase")

# ---------- arguments ----------
MODE="${1:-}"
DRY_RUN=0
for a in "$@"; do [[ "$a" == "--dry-run" ]] && DRY_RUN=1; done
case "$MODE" in
  dev)  ENV_NAME="${FLAGSMITH_ENV_NAME_DEV:-Development}"; ENV_VAR="FLAGSMITH_ENV_KEY_DEV" ;;
  sim)  ENV_NAME="${FLAGSMITH_ENV_NAME_SIM:-Simulation}";  ENV_VAR="FLAGSMITH_ENV_KEY_SIM" ;;
  prod) ENV_NAME="${FLAGSMITH_ENV_NAME_PROD:-Production}"; ENV_VAR="FLAGSMITH_ENV_KEY_PROD" ;;
  aa)   ENV_NAME="${FLAGSMITH_ENV_NAME_DEV:-Development}"; ENV_VAR="FLAGSMITH_ENV_KEY_DEV" ;;
  *) echo "usage: $0 <dev|sim|prod|aa> [--dry-run]" >&2; exit 2 ;;
esac
if [[ "$MODE" == "aa" ]]; then
  FLAG="$AA_FLAG"; CONTROL_VALUE="$AA_CONTROL_VALUE"; VARIANT_VALUE="$AA_VARIANT_VALUE"; VARIANT_KEY="$AA_VARIANT_KEY"
  NAME="$AA_NAME"; HYPOTHESIS="$AA_HYPOTHESIS"; WANT_METRICS=("${AA_METRICS[@]}")
else
  FLAG="$EXP_FLAG"; CONTROL_VALUE="$EXP_CONTROL_VALUE"; VARIANT_VALUE="$EXP_VARIANT_VALUE"; VARIANT_KEY="$EXP_VARIANT_KEY"
  NAME="$EXP_NAME"; HYPOTHESIS="$EXP_HYPOTHESIS"; WANT_METRICS=("${METRICS[@]}")
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
# On Git Bash, give Windows programs (node, flagsmith.exe) a path they can open: /tmp/x → C:/Users/…/Temp/x.
if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; fi
trap 'rm -rf "$TMP"' EXIT
umask 077

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
plan() { printf '  [dry-run] would %s' "$*" | mask; echo; }

command -v node >/dev/null || die "node is needed (it parses the JSON). Install Node 20+."

# ---------- the environment key: env var, else .env.local (FLAGSMITH_ENV_KEY_* lines only), else by name ----------
ENV_KEY="${!ENV_VAR:-}"
if [[ -z "$ENV_KEY" ]]; then
  for f in "$ROOT/.env.local" "$ROOT/app/.env.local"; do
    [[ -f "$f" ]] || continue
    line="$(grep -E "^[[:space:]]*${ENV_VAR}=" "$f" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      ENV_KEY="${line#*=}"; ENV_KEY="${ENV_KEY%$'\r'}"; ENV_KEY="${ENV_KEY%\"}"; ENV_KEY="${ENV_KEY#\"}"
      break
    fi
  done
fi

# Replace the environment key (and the admin token) with placeholders in anything shown.
mask() {
  local s; s="$(cat)"
  [[ -n "${ENV_KEY:-}" ]] && s="${s//$ENV_KEY/<env-key>}"
  [[ -n "${FLAGSMITH_ADMIN_TOKEN:-}" ]] && s="${s//$FLAGSMITH_ADMIN_TOKEN/<admin-token>}"
  printf '%s' "$s"
}

# ---------- transport: the Flagsmith CLI if installed, else curl with FLAGSMITH_ADMIN_TOKEN ----------
HAVE_CLI=0; command -v flagsmith >/dev/null && HAVE_CLI=1
if [[ $HAVE_CLI -eq 1 && -n "${FLAGSMITH_ADMIN_TOKEN:-}" ]]; then
  export FLAGSMITH_API_KEY="$FLAGSMITH_ADMIN_TOKEN"   # the CLI's own variable for a Master API key
fi
export FLAGSMITH_NO_INPUT=1                            # the CLI never prompts or opens a browser from here

if [[ $HAVE_CLI -eq 0 && -z "${FLAGSMITH_ADMIN_TOKEN:-}" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then AUTHED=0; else
    die "neither the Flagsmith CLI (flagsmith login) nor FLAGSMITH_ADMIN_TOKEN is available. See scripts/flagsmith/README.md."
  fi
fi

# api METHOD PATH [JSON-BODY]  -> response body on stdout; non-zero exit on HTTP error (body on stderr, masked)
api() {
  local method="$1" path="$2" body="${3:-}" out="$TMP/out" err="$TMP/err" rc=0
  path="${path#/}"
  if [[ $HAVE_CLI -eq 1 ]]; then
    if [[ -n "$body" ]]; then
      printf '%s' "$body" > "$TMP/body.json"
      flagsmith api "$path" -X "$method" --input "$TMP/body.json" >"$out" 2>"$err" || rc=$?
    else
      flagsmith api "$path" -X "$method" >"$out" 2>"$err" || rc=$?
    fi
  else
    printf 'Authorization: Api-Key %s' "$FLAGSMITH_ADMIN_TOKEN" > "$TMP/auth.h"
    local code
    if [[ -n "$body" ]]; then
      printf '%s' "$body" > "$TMP/body.json"
      code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" -H @"$TMP/auth.h" -H 'Content-Type: application/json' \
        --data-binary @"$TMP/body.json" "${API_URL%/}/$path" 2>"$err")" || rc=$?
    else
      code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" -H @"$TMP/auth.h" "${API_URL%/}/$path" 2>"$err")" || rc=$?
    fi
    rm -f "$TMP/auth.h"
    if [[ $rc -eq 0 && ( "$code" -lt 200 || "$code" -ge 300 ) ]]; then
      { printf '%s %s returned HTTP %s\n' "$method" "$path" "$code"; cat "$out"; } > "$err"; rc=1
    fi
  fi
  if [[ $rc -ne 0 ]]; then
    { cat "$err"; echo; } | mask >&2
    return 1
  fi
  cat "$out"
}

# cli ARGS...  -> runs a Flagsmith CLI command; output masked (to stderr if it failed, so it is never swallowed)
cli() {
  local rc=0
  flagsmith "$@" >"$TMP/cli.out" 2>&1 || rc=$?
  if [[ $rc -ne 0 ]]; then { mask < "$TMP/cli.out"; echo; } >&2; return $rc; fi
  mask < "$TMP/cli.out"; echo
}

# js 'EXPR'  -> evaluates EXPR with `j` = the JSON on stdin (null when empty); prints strings raw, else JSON
js() {
  node -e '
    let d = ""; process.stdin.on("data", c => (d += c)).on("end", () => {
      const j = d.trim() ? JSON.parse(d) : null;
      const list = x => (Array.isArray(x) ? x : (x && Array.isArray(x.results) ? x.results : []));
      const r = (0, eval)("(j, list) => (" + process.argv[1] + ")")(j, list);
      if (r === undefined || r === null) return;
      process.stdout.write(typeof r === "string" || typeof r === "number" ? String(r) : JSON.stringify(r));
    });' "$1"
}
# jobj KEY=VALUE...  -> a JSON object of strings (values safely escaped)
jobj() { node -e 'const o={}; for (const a of process.argv.slice(1)) { const i=a.indexOf("="); o[a.slice(0,i)]=a.slice(i+1); } process.stdout.write(JSON.stringify(o));' "$@"; }

# ---------- can we read? ----------
AUTHED="${AUTHED:-1}"
if [[ $HAVE_CLI -eq 1 && -z "${FLAGSMITH_ADMIN_TOKEN:-}" ]]; then
  if ! flagsmith auth status >/dev/null 2>&1; then
    if [[ $DRY_RUN -eq 1 ]]; then AUTHED=0; else die "the Flagsmith CLI is not logged in. Tumo: run 'flagsmith login'."; fi
  fi
fi

say "Flagsmith setup: mode=$MODE environment=\"$ENV_NAME\" project=\"$PROJECT_NAME\"$([[ $DRY_RUN -eq 1 ]] && echo ' (dry run)')"
if [[ $HAVE_CLI -eq 1 ]]; then say "Transport: Flagsmith CLI ($(flagsmith --version 2>/dev/null | head -n 1))"
elif [[ -n "${FLAGSMITH_ADMIN_TOKEN:-}" ]]; then say "Transport: curl + FLAGSMITH_ADMIN_TOKEN"
else say "Transport: none (no CLI, no token): dry run only"; fi
if [[ $AUTHED -eq 0 ]]; then
  say "Not logged in, so this dry run makes no calls at all and shows the full plan with placeholders."
fi

# ---------- 1. project ----------
step "Project \"$PROJECT_NAME\""
PROJECT_ID=""
PROJECT_JSON="$(jobj n="$PROJECT_NAME" | js 'JSON.stringify(j.n)')"
if [[ $AUTHED -eq 1 ]]; then
  PROJECT_ID="$(api GET "api/v1/projects/" | js "list(j).filter(p => p.name === $PROJECT_JSON).map(p => p.id)[0]")"
fi
if [[ -n "$PROJECT_ID" ]]; then
  say "  exists: id $PROJECT_ID"
else
  ORG="${FLAGSMITH_ORGANISATION:-}"
  if [[ -z "$ORG" && $AUTHED -eq 1 ]]; then
    ORGS="$(api GET "api/v1/organisations/" | js 'list(j).map(o => o.id)')"
    [[ "$(printf '%s' "$ORGS" | js 'j.length')" == "1" ]] && ORG="$(printf '%s' "$ORGS" | js 'j[0]')"
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    plan "create project \"$PROJECT_NAME\" in organisation ${ORG:-<FLAGSMITH_ORGANISATION>}: flagsmith project create \"$PROJECT_NAME\" --organisation <org>"
    PROJECT_ID="<project-id>"
  else
    [[ -n "$ORG" ]] || die "project \"$PROJECT_NAME\" not found and the organisation is ambiguous. Set FLAGSMITH_ORGANISATION to its id."
    if [[ $HAVE_CLI -eq 1 ]]; then cli project create "$PROJECT_NAME" --organisation "$ORG"
    else api POST "api/v1/projects/" "{\"name\":$PROJECT_JSON,\"organisation\":$ORG}" >/dev/null; fi
    PROJECT_ID="$(api GET "api/v1/projects/" | js "list(j).filter(p => p.name === $PROJECT_JSON).map(p => p.id)[0]")"
    [[ -n "$PROJECT_ID" ]] || die "project was not created"
    say "  created: id $PROJECT_ID"
  fi
fi

# ---------- 2. environment (Tumo creates environments in the dashboard, plan T4) ----------
step "Environment \"$ENV_NAME\""
ENV_ID=""
if [[ $AUTHED -eq 1 && "$PROJECT_ID" != "<project-id>" ]]; then
  ENVS="$(api GET "api/v1/environments/?project=$PROJECT_ID")"
  ENVNAME_JSON="$(jobj n="$ENV_NAME" | js 'JSON.stringify(j.n)')"
  if [[ -n "$ENV_KEY" ]]; then
    printf '%s' "$ENV_KEY" > "$TMP/k"
    ENV_ID="$(printf '%s' "$ENVS" | js "list(j).filter(e => e.api_key === require('fs').readFileSync('$TMP/k','utf8')).map(e => e.id)[0]")"
    [[ -n "$ENV_ID" ]] || die "$ENV_VAR does not match any environment in project \"$PROJECT_NAME\"."
    GOT_NAME="$(printf '%s' "$ENVS" | js "list(j).filter(e => e.id === $ENV_ID).map(e => e.name)[0]")"
    [[ "$GOT_NAME" == "$ENV_NAME" ]] || warn "$ENV_VAR belongs to environment \"$GOT_NAME\", not \"$ENV_NAME\". Check .env.local."
  else
    ENV_ID="$(printf '%s' "$ENVS" | js "list(j).filter(e => e.name === $ENVNAME_JSON).map(e => e.id)[0]")"
    [[ -n "$ENV_ID" ]] && ENV_KEY="$(printf '%s' "$ENVS" | js "list(j).filter(e => e.id === $ENV_ID).map(e => e.api_key)[0]")"
  fi
  rm -f "$TMP/k"
fi
if [[ -z "$ENV_ID" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    plan "use environment \"$ENV_NAME\" (Tumo creates it in the dashboard, plan T4; the key goes in $ENV_VAR)"
    ENV_ID="<environment-id>"
  else
    die "environment \"$ENV_NAME\" not found in project \"$PROJECT_NAME\". Tumo: create it in the dashboard (plan T4)."
  fi
else
  say "  exists: id $ENV_ID (key read, not shown)"
fi
LIVE=0; [[ $AUTHED -eq 1 && "$ENV_ID" != "<environment-id>" ]] && LIVE=1
E="api/v1/environments/${ENV_KEY:-<env-key>}"

# ---------- 3. warehouse (one per environment; the managed Flagsmith warehouse is connected in the dashboard) ----------
step "Warehouse connection"
if [[ $LIVE -eq 1 ]]; then
  WH="$(api GET "$E/warehouse-connections/" || echo '[]')"
  N_WH="$(printf '%s' "$WH" | js 'list(j).length')"
  if [[ "${N_WH:-0}" == "0" ]]; then
    warn "no warehouse connected to \"$ENV_NAME\". Tumo: Experiments > connect the managed Flagsmith warehouse in the dashboard, or no events are stored."
  else
    say "  $N_WH connection(s): $(printf '%s' "$WH" | js 'list(j).map(w => (w.warehouse_type || w.type || "?") + "/" + (w.status || "?")).join(", ")')"
  fi
else
  plan "check GET $E/warehouse-connections/ (connect the managed warehouse in the dashboard if empty)"
fi

# ---------- helpers for features ----------
get_feature() { # name -> feature JSON or empty
  local n="$1"
  api GET "api/v1/projects/$PROJECT_ID/features/?search=$n&page_size=100" \
    | js "list(j).filter(f => f.name === '$n')[0]"
}

ensure_enabled_in_env() { # feature name, feature id
  local n="$1" fid="$2"
  if [[ $LIVE -eq 0 || $DRY_RUN -eq 1 ]]; then
    if [[ $LIVE -eq 1 ]]; then
      local st; st="$(api GET "$E/featurestates/?feature=$fid" | js 'list(j).filter(s => !s.identity && !s.feature_segment).map(s => s.enabled)[0]')"
      [[ "$st" == "true" ]] && { say "  $n is on in \"$ENV_NAME\""; return; }
    fi
    plan "turn $n on in \"$ENV_NAME\": FLAGSMITH_ENVIRONMENT=<env-key> flagsmith flag enable $n --project <project-id>"
    return
  fi
  local fs; fs="$(api GET "$E/featurestates/?feature=$fid" | js 'list(j).filter(s => !s.identity && !s.feature_segment)[0]')"
  if [[ "$(printf '%s' "$fs" | js 'j && j.enabled')" == "true" ]]; then say "  $n is on in \"$ENV_NAME\""; return; fi
  if [[ $HAVE_CLI -eq 1 ]]; then
    FLAGSMITH_ENVIRONMENT="$ENV_KEY" cli flag enable "$n" --project "$PROJECT_ID" >/dev/null
  else
    api PATCH "$E/featurestates/$(printf '%s' "$fs" | js 'j.id')/" '{"enabled":true}' >/dev/null
  fi
  say "  turned $n on in \"$ENV_NAME\""
}

# ---------- 4. the kill switch: experiments_enabled (boolean, on) ----------
step "Flag $KILL_FLAG (boolean kill switch, on)"
KILL_ID=""
[[ $AUTHED -eq 1 && "$PROJECT_ID" != "<project-id>" ]] && KILL_ID="$(get_feature "$KILL_FLAG" | js 'j && j.id')"
if [[ -n "$KILL_ID" ]]; then
  say "  exists: id $KILL_ID ($(get_feature "$KILL_FLAG" | js 'j.type'))"
elif [[ $DRY_RUN -eq 1 ]]; then
  plan "create: flagsmith feature create $KILL_FLAG --enabled --description \"Kill switch: off means everyone sees control and nothing is sent\" --project <project-id>"
  KILL_ID="<kill-flag-id>"
else
  if [[ $HAVE_CLI -eq 1 ]]; then
    cli feature create "$KILL_FLAG" --enabled --description "Kill switch: off means everyone sees control and nothing is sent" --project "$PROJECT_ID" >/dev/null
  else
    api POST "api/v1/projects/$PROJECT_ID/features/" "{\"name\":\"$KILL_FLAG\",\"type\":\"STANDARD\",\"default_enabled\":true,\"description\":\"Kill switch: off means everyone sees control and nothing is sent\"}" >/dev/null
  fi
  KILL_ID="$(get_feature "$KILL_FLAG" | js 'j && j.id')"; [[ -n "$KILL_ID" ]] || die "$KILL_FLAG was not created"
  say "  created: id $KILL_ID"
fi
[[ "$KILL_ID" == "<kill-flag-id>" ]] && plan "turn $KILL_FLAG on in \"$ENV_NAME\"" || ensure_enabled_in_env "$KILL_FLAG" "$KILL_ID"

# ---------- 5. the experiment flag: multivariate string, control value + keyed variation ----------
step "Flag $FLAG (multivariate string: \"$CONTROL_VALUE\" + variation \"$VARIANT_VALUE\" with key \"$VARIANT_KEY\")"
FEATURE="" FEATURE_ID="" VARIANT_ID=""
if [[ $AUTHED -eq 1 && "$PROJECT_ID" != "<project-id>" ]]; then FEATURE="$(get_feature "$FLAG")"; FEATURE_ID="$(printf '%s' "$FEATURE" | js 'j && j.id')"; fi
if [[ -n "$FEATURE_ID" ]]; then
  say "  exists: id $FEATURE_ID, type $(printf '%s' "$FEATURE" | js 'j.type'), value \"$(printf '%s' "$FEATURE" | js 'j.initial_value')\""
  [[ "$(printf '%s' "$FEATURE" | js 'j.initial_value')" == "$CONTROL_VALUE" ]] || warn "$FLAG's own value is not \"$CONTROL_VALUE\". Fix it before the experiment starts."
elif [[ $DRY_RUN -eq 1 ]]; then
  plan "create: flagsmith feature create $FLAG --value $CONTROL_VALUE --enabled --project <project-id>"
  FEATURE_ID="<flag-id>"
else
  if [[ $HAVE_CLI -eq 1 ]]; then
    cli feature create "$FLAG" --value "$CONTROL_VALUE" --enabled --description "Toggle Wars experiment flag (plan §2)" --project "$PROJECT_ID" >/dev/null
  else
    api POST "api/v1/projects/$PROJECT_ID/features/" "{\"name\":\"$FLAG\",\"type\":\"MULTIVARIATE\",\"initial_value\":\"$CONTROL_VALUE\",\"default_enabled\":true,\"description\":\"Toggle Wars experiment flag (plan §2)\"}" >/dev/null
  fi
  FEATURE="$(get_feature "$FLAG")"; FEATURE_ID="$(printf '%s' "$FEATURE" | js 'j && j.id')"; [[ -n "$FEATURE_ID" ]] || die "$FLAG was not created"
  say "  created: id $FEATURE_ID"
fi

# the variation. A variation without a key records no exposures, so the key is checked, not assumed.
if [[ "$FEATURE_ID" != "<flag-id>" && $AUTHED -eq 1 ]]; then
  OPTS="$(api GET "api/v1/projects/$PROJECT_ID/features/$FEATURE_ID/mv-options/?page_size=100")"
  VARIANT_ID="$(printf '%s' "$OPTS" | js "list(j).filter(o => o.key === '$VARIANT_KEY').map(o => o.id)[0]")"
  UNKEYED_ID="$(printf '%s' "$OPTS" | js "list(j).filter(o => !o.key && o.string_value === '$VARIANT_VALUE').map(o => o.id)[0]")"
  N_OPTS="$(printf '%s' "$OPTS" | js 'list(j).length')"
fi
if [[ -n "$VARIANT_ID" ]]; then
  say "  variation exists: id $VARIANT_ID, key \"$VARIANT_KEY\", value \"$(printf '%s' "$OPTS" | js "list(j).filter(o => o.id === $VARIANT_ID).map(o => o.string_value)[0]")\""
  [[ "${N_OPTS:-1}" == "1" ]] || warn "$FLAG has $N_OPTS variations; the plan has exactly one. Remove the extra ones before the experiment starts."
elif [[ -n "${UNKEYED_ID:-}" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then plan "give variation $UNKEYED_ID the key \"$VARIANT_KEY\": flagsmith feature variant update $FLAG $UNKEYED_ID --key $VARIANT_KEY"
  else
    if [[ $HAVE_CLI -eq 1 ]]; then cli feature variant update "$FLAG" "$UNKEYED_ID" --key "$VARIANT_KEY" --project "$PROJECT_ID" >/dev/null
    else api PATCH "api/v1/projects/$PROJECT_ID/features/$FEATURE_ID/mv-options/$UNKEYED_ID/" "{\"key\":\"$VARIANT_KEY\"}" >/dev/null; fi
    say "  variation $UNKEYED_ID had no key; set it to \"$VARIANT_KEY\""
  fi
  VARIANT_ID="$UNKEYED_ID"
elif [[ $DRY_RUN -eq 1 ]]; then
  plan "add variation: flagsmith feature variant add $FLAG --value $VARIANT_VALUE --key $VARIANT_KEY --type string --weight $VARIANT_ENV_WEIGHT --project <project-id>"
  VARIANT_ID="<variation-id>"
else
  if [[ $HAVE_CLI -eq 1 ]]; then
    cli feature variant add "$FLAG" --value "$VARIANT_VALUE" --key "$VARIANT_KEY" --type string --weight "$VARIANT_ENV_WEIGHT" --project "$PROJECT_ID" >/dev/null
  else
    api POST "api/v1/projects/$PROJECT_ID/features/$FEATURE_ID/mv-options/" "{\"feature\":$FEATURE_ID,\"type\":\"unicode\",\"string_value\":\"$VARIANT_VALUE\",\"key\":\"$VARIANT_KEY\",\"default_percentage_allocation\":$VARIANT_ENV_WEIGHT}" >/dev/null
  fi
  VARIANT_ID="$(api GET "api/v1/projects/$PROJECT_ID/features/$FEATURE_ID/mv-options/?page_size=100" | js "list(j).filter(o => o.key === '$VARIANT_KEY').map(o => o.id)[0]")"
  [[ -n "$VARIANT_ID" ]] || die "the variation was not created with key \"$VARIANT_KEY\""
  say "  variation created: id $VARIANT_ID"
fi
if [[ $AUTHED -eq 1 && "$FEATURE_ID" != "<flag-id>" ]]; then
  TYPE="$(get_feature "$FLAG" | js 'j.type')"
  if [[ "$TYPE" != "MULTIVARIATE" ]]; then
    [[ $DRY_RUN -eq 1 ]] && warn "$FLAG is $TYPE; it must be MULTIVARIATE (it should become so once the variation exists)." \
      || die "$FLAG is $TYPE, not MULTIVARIATE; Flagsmith only runs experiments on multivariate flags."
  fi
  ensure_enabled_in_env "$FLAG" "$FEATURE_ID"
else
  plan "turn $FLAG on in \"$ENV_NAME\""
fi

# ---------- 6. metrics (scoped to the environment) ----------
step "Metrics in \"$ENV_NAME\""
declare -A METRIC_ID=()
for m in "${WANT_METRICS[@]}"; do
  IFS='|' read -r mname magg mdir _ <<< "$m"
  mid=""
  if [[ $LIVE -eq 1 ]]; then
    MJ="$(api GET "$E/experiment-metrics/?q=$mname&page_size=100" | js "list(j).filter(x => x.name === '$mname')[0]")"
    mid="$(printf '%s' "$MJ" | js 'j && j.id')"
  fi
  if [[ -n "$mid" ]]; then
    got="$(printf '%s' "$MJ" | js 'j.aggregation + "|" + j.direction + "|" + (j.definition && j.definition.event)')"
    say "  $mname exists: id $mid ($got)"
    [[ "$got" == "$magg|$mdir|$mname" ]] || warn "$mname is $got, the plan says $magg|$mdir|$mname. Not changed (pre-registration): fix by hand if this is before the prereg tag."
  elif [[ $DRY_RUN -eq 1 ]]; then
    plan "POST $E/experiment-metrics/ {name: $mname, aggregation: $magg, direction: $mdir, definition: {version: 1, event: $mname}}"
    mid="<metric-id:$mname>"
  else
    body="{\"name\":\"$mname\",\"description\":\"Toggle Wars (plan §2): event $mname\",\"aggregation\":\"$magg\",\"direction\":\"$mdir\",\"definition\":{\"version\":1,\"event\":\"$mname\"}}"
    mid="$(api POST "$E/experiment-metrics/" "$body" | js 'j && j.id')"
    [[ -n "$mid" ]] || die "metric $mname was not created"
    say "  $mname created: id $mid"
  fi
  METRIC_ID[$mname]="$mid"
done

# ---------- 7. the experiment, as a draft ----------
step "Experiment \"$NAME\" (draft: created, not started)"
EXP_ID="" EXP_STATUS=""
if [[ $LIVE -eq 1 && "$FEATURE_ID" != "<flag-id>" ]]; then
  NAME_JSON="$(jobj n="$NAME" | js 'JSON.stringify(j.n)')"
  EXPS="$(api GET "$E/experiments/?page_size=100")"
  EXP="$(printf '%s' "$EXPS" | js "list(j).filter(x => x.name === $NAME_JSON && (x.feature === $FEATURE_ID || (x.feature && x.feature.id === $FEATURE_ID))).sort((a, b) => (a.status === 'completed') - (b.status === 'completed') || b.id - a.id)[0]")"
  EXP_ID="$(printf '%s' "$EXP" | js 'j && j.id')"; EXP_STATUS="$(printf '%s' "$EXP" | js 'j && j.status')"
fi
# Metrics in pre-registered order. Flagsmith's API has no "primary" field; the first attached is listed as the
# goal metric (unverified, see README), so plan_first_message goes first.
METRICS_JSON="["; sep=""
for m in "${WANT_METRICS[@]}"; do
  IFS='|' read -r mname _ _ mexp <<< "$m"
  METRICS_JSON+="$sep{\"metric\":\"${METRIC_ID[$mname]}\",\"expected_direction\":\"$mexp\"}"; sep=","
done
METRICS_JSON+="]"
# enabled:false keeps it a true draft: creating an experiment writes its rollout override straight away, and
# /start/ turns that override on (Flagsmith source, experimentation/services.py enable_experiment_rollout).
EXP_BODY="$(node -e '
  const [name, hyp, fid, vid, split, rollout, control, metrics] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    feature: Number(fid) || fid, name, hypothesis: hyp, metrics: JSON.parse(metrics),
    experiment_rollout: {
      enabled: false, rollout_percentage: Number(rollout),
      feature_state_value: { type: "string", value: control },
      multivariate_feature_state_values: [{ multivariate_feature_option: Number(vid) || vid, percentage_allocation: Number(split) }],
    },
  }, null, 2));' "$NAME" "$HYPOTHESIS" "$FEATURE_ID" "$VARIANT_ID" "$SPLIT_PERCENT" "$ROLLOUT_PERCENT" "$CONTROL_VALUE" "$METRICS_JSON")"

if [[ -n "$EXP_ID" ]]; then
  say "  exists: id $EXP_ID, status $EXP_STATUS"
  case "$EXP_STATUS" in
    created) say "  still a draft: good" ;;
    running|paused) warn "already $EXP_STATUS. Not touched: a running experiment is locked and is never restarted (plan §2)." ;;
    completed) warn "the only one with this name is completed. Not creating another automatically; delete or rename by hand if a fresh one is really meant." ;;
  esac
elif [[ $DRY_RUN -eq 1 ]]; then
  plan "POST $E/experiments/ with:"
  printf '%s\n' "$EXP_BODY" | sed 's/^/      /'
  EXP_ID="<experiment-id>"; EXP_STATUS="created"
else
  EXP_ID="$(api POST "$E/experiments/" "$EXP_BODY" | js 'j && j.id')"
  [[ -n "$EXP_ID" ]] || die "the experiment was not created"
  EXP_STATUS="$(api GET "$E/experiments/$EXP_ID/" | js 'j.status')"
  say "  created: id $EXP_ID, status $EXP_STATUS"
  [[ "$EXP_STATUS" == "created" ]] || warn "status is $EXP_STATUS, expected created (draft)."
fi
if [[ $LIVE -eq 1 && "$EXP_ID" != "<experiment-id>" && -n "$EXP_ID" ]]; then
  ATT="$(api GET "$E/experiments/$EXP_ID/" | js 'j.metrics.map(m => m.metric_name + ":" + m.expected_direction).join(", ")')"
  say "  metrics attached, in order: $ATT"
fi

# ---------- ids ----------
step "Ids ($ENV_NAME)"
say "  project            $PROJECT_ID"
say "  environment        $ENV_ID   (key: \$$ENV_VAR, not shown)"
say "  $KILL_FLAG  $KILL_ID"
say "  $FLAG  $FEATURE_ID   variation \"$VARIANT_KEY\": $VARIANT_ID"
for m in "${WANT_METRICS[@]}"; do IFS='|' read -r mname _ _ _ <<< "$m"; say "  metric $mname  ${METRIC_ID[$mname]}"; done
say "  experiment         $EXP_ID ($EXP_STATUS)"
say "  dashboard          $DASHBOARD_URL/project/$PROJECT_ID/environment/<env-key>/experiments/$EXP_ID"
say ""
say "Not started. To start it (plan §5: Production at Thu 26 Nov 06:00 SAST), Claude or Tumo runs:"
say "  flagsmith api \"api/v1/environments/\$$ENV_VAR/experiments/$EXP_ID/start/\" -X POST --input - <<< '{}'"
