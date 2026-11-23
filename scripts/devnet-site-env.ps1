# Copies Heirloom's secret settings into the second Vercel site, "heirloom-devnet" (chain mode on Solana devnet).
# The demo site (heirloom-one-iota.vercel.app, mock mode) is not touched.
#
#   powershell -ExecutionPolicy Bypass -File scripts\devnet-site-env.ps1
#
# Reads, in order (later files win): .env.local (repo root), app\.env.local, scripts\.env.devnet.
# Only the names in $names are sent, as Vercel "Secret" variables for Production. No value is printed or written to disk.
# The public settings (chain mode, devnet, USDT mint, program id, site URL, voice agent id) are already set on the project.
#
# Note: the site is public. Anyone visiting can use the devnet agent wallet as fee sponsor (if SPONSOR_ENABLED is set),
# limited by SPONSOR_DAILY_BUDGET_LAMPORTS. Devnet SOL and test USDT only; never real money.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$project = "heirloom-devnet"

$names = @(
  "AGENT_SEED_PHRASE", "SCHEDULER_SECRET", "CRON_SECRET",
  "NEXT_PUBLIC_DEMO_WAITING_SECS", "NEXT_PUBLIC_DEMO_INTERVAL_SECS",
  "SOLANA_RPC_URL", "NEXT_PUBLIC_SOLANA_RPC_URL",
  "GEMINI_API_KEY", "GEMINI_MODEL",
  "ELEVENLABS_API_KEY", "ELEVENLABS_TOOL_SECRET", "ELEVENLABS_HEIRLOOM_VOICE_ID", "LEGACY_SPEAK_SECRET",
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ASSET_PHOTO_URL_SECRET",
  "SPONSOR_ENABLED", "SPONSOR_MAX_FEE_LAMPORTS", "SPONSOR_PAYS_RENT", "SPONSOR_DAILY_BUDGET_LAMPORTS", "SPONSOR_MIN_BALANCE_LAMPORTS",
  "FX_FALLBACK_USDT_ZAR"
)

$values = @{}
function Import-EnvFile([string]$file) {
  if (-not (Test-Path $file)) { return }
  foreach ($line in Get-Content $file) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $value = $matches[2].Trim()
      if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      if ($value) { $values[$matches[1]] = $value }
    }
  }
}
Import-EnvFile (Join-Path $root ".env.local")
Import-EnvFile (Join-Path $root "app\.env.local")
Import-EnvFile (Join-Path $PSScriptRoot ".env.devnet")

if (-not $values["AGENT_SEED_PHRASE"]) { throw "scripts\.env.devnet is missing (it holds the devnet agent wallet)." }

Set-Location $root
foreach ($name in $names) {
  if (-not $values.ContainsKey($name)) { Write-Host "  skip  $name (not set locally)"; continue }
  $type = if ($name.StartsWith("NEXT_PUBLIC_")) { "--no-sensitive" } else { "--sensitive" }
  # The Vercel CLI writes its banner to stderr; in Windows PowerShell 5.1 that counts as an error under "Stop",
  # so only the exit code decides here.
  $ErrorActionPreference = "Continue"
  # --value, not a pipe: Windows PowerShell 5.1 adds CR LF to piped text, which corrupts seed phrases and keys.
  & npx.cmd vercel env add $name --environment production $type --force --yes -p $project --value $values[$name] 2>&1 | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($code -ne 0) { throw "Vercel refused $name (exit $code). Is the CLI logged in as tumo-mogame?" }
  Write-Host "  set   $name"
}
Write-Host "Done. Tell Claude, and it will connect the site to GitHub and deploy it."
