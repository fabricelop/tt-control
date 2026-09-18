param([switch]$Force)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$productionState = Join-Path $PSScriptRoot 'production-state.json'
if ((Test-Path $productionState) -and -not $Force) {
    try { $state = Get-Content $productionState -Raw | ConvertFrom-Json } catch { $state = $null }
    if ($state -and $state.launched) {
        Write-Host 'SLR ya esta en produccion. No se repetira la carga inicial.' -ForegroundColor Yellow
        Write-Host 'Para una ejecucion normal usa la tarea SeLoRecordamos-Search. Para reiniciar deliberadamente desde cero usa este script con -Force.' -ForegroundColor Yellow
        exit 0
    }
}

$env:X_AUTH_TOKEN = [Environment]::GetEnvironmentVariable('X_AUTH_TOKEN', 'User')
$env:X_CT0 = [Environment]::GetEnvironmentVariable('X_CT0', 'User')
$env:SR_TELEGRAM_BOT_TOKEN = [Environment]::GetEnvironmentVariable('SR_TELEGRAM_BOT_TOKEN', 'User')
$env:SR_TELEGRAM_CHAT_ID = [Environment]::GetEnvironmentVariable('SR_TELEGRAM_CHAT_ID', 'User')
$env:SR_HEADLESS = '1'
$env:SR_BACKFILL_DAYS = '0'
$env:SR_BACKFILL_SINCE = '2026-09-01T00:00:00+02:00'

Write-Host 'Parando listener SLR...' -ForegroundColor Cyan
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*run-telegram-listener.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host 'Limpiando estado local de preproduccion...' -ForegroundColor Cyan
$runtime = Join-Path $PSScriptRoot 'runtime'
if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

$candidates = Join-Path $PSScriptRoot 'candidates'
if (Test-Path $candidates) { Get-ChildItem $candidates -Filter '*.json' -File | Remove-Item -Force }

Write-Host 'Buscando desde 01/09/2026 00:00 Europe/Madrid...' -ForegroundColor Cyan
node (Join-Path $PSScriptRoot 'search_x.js')
if ($LASTEXITCODE -ne 0) { throw "search_x.js termino con codigo $LASTEXITCODE" }

Write-Host 'Enviando candidatos iniciales a Telegram...' -ForegroundColor Cyan
node (Join-Path $PSScriptRoot 'telegram_local.js') send
if ($LASTEXITCODE -ne 0) { throw "telegram_local.js send termino con codigo $LASTEXITCODE" }

Remove-Item Env:SR_BACKFILL_SINCE -ErrorAction SilentlyContinue

$state = [ordered]@{
    launched = $true
    initial_since = '2026-09-01T00:00:00+02:00'
    launched_at = (Get-Date).ToString('o')
}
$state | ConvertTo-Json | Set-Content -Path $productionState -Encoding UTF8

Write-Host 'Arrancando listener SLR...' -ForegroundColor Cyan
schtasks /Run /TN 'SeLoRecordamos-Telegram' | Out-Null

Write-Host 'SLR en produccion. A partir de ahora las ejecuciones normales son incrementales.' -ForegroundColor Green
