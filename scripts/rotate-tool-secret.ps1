# Makes one new ELEVENLABS_TOOL_SECRET and puts it in all three places that must match:
#   the ElevenLabs workspace secret "heirloom_tool_secret" (the header the voice agents send),
#   and ELEVENLABS_TOOL_SECRET on both Vercel projects ("heirloom" = demo, "heirloom-devnet" = devnet).
# It also points devnet at its own voice agent (ELEVENLABS_AGENT_ID, not a secret).
#
#   powershell -ExecutionPolicy Bypass -File scripts\rotate-tool-secret.ps1
#
# Reads ELEVENLABS_API_KEY from .env.local (repo root) or app\.env.local. Nothing secret is printed or written to disk.
# Afterwards both sites must be redeployed (Claude does that) before calls work again.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$secretId = "rorEyqbL9GLlqu3VR2GX"
$secretName = "heirloom_tool_secret"
$devnetAgent = "agent_1501m87f8q2eea1vafdqmmyn1r7n"

$apiKey = $null
foreach ($file in @((Join-Path $root ".env.local"), (Join-Path $root "app\.env.local"))) {
  if (-not (Test-Path $file)) { continue }
  foreach ($line in Get-Content $file) {
    if ($line -match '^\s*ELEVENLABS_API_KEY\s*=\s*"?([^"]+)"?\s*$') { $apiKey = $matches[1].Trim() }
  }
}
if (-not $apiKey) { throw "ELEVENLABS_API_KEY not found in .env.local or app\.env.local." }

# 48 random bytes as hex.
$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })

# 1. ElevenLabs workspace secret (same id, so both agents' tools pick it up).
$body = @{ type = "update"; name = $secretName; value = $secret } | ConvertTo-Json
Invoke-RestMethod -Method Patch -Uri "https://api.elevenlabs.io/v1/convai/secrets/$secretId" `
  -Headers @{ "xi-api-key" = $apiKey } -ContentType "application/json" -Body $body | Out-Null
Write-Host "  set   ElevenLabs secret $secretName"

# 2. Both Vercel projects.
function Set-VercelEnv([string]$project, [string]$name, [string]$value, [string]$type) {
  $ErrorActionPreference = "Continue"
  & npx.cmd vercel env add $name --environment production $type --force --yes -p $project --value $value 2>&1 | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($code -ne 0) { throw "Vercel refused $name on $project (exit $code). Is the CLI logged in as tumo-mogame?" }
  Write-Host "  set   $name on $project"
}
Set-VercelEnv "heirloom" "ELEVENLABS_TOOL_SECRET" $secret "--sensitive"
Set-VercelEnv "heirloom-devnet" "ELEVENLABS_TOOL_SECRET" $secret "--sensitive"
Set-VercelEnv "heirloom-devnet" "ELEVENLABS_AGENT_ID" $devnetAgent "--sensitive"

# 3. Local copy for dev runs: tell Tumo, never write it here.
Write-Host "Done. Tell Claude to redeploy both sites. (Your local .env.local still has the old tool secret: local calls will fail until you update it.)"
