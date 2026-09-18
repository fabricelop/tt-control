$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$env:SR_TELEGRAM_BOT_TOKEN = [Environment]::GetEnvironmentVariable('SR_TELEGRAM_BOT_TOKEN', 'User')
$env:SR_TELEGRAM_CHAT_ID = [Environment]::GetEnvironmentVariable('SR_TELEGRAM_CHAT_ID', 'User')

$runtime = Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$log = Join-Path $runtime 'telegram-listener.log'

while ($true) {
    try {
        "[$(Get-Date -Format s)] Arrancando listener" | Add-Content $log
        & node (Join-Path $PSScriptRoot 'telegram_local.js') poll *>> $log
        "[$(Get-Date -Format s)] Listener terminó con código $LASTEXITCODE; reintento en 5s" | Add-Content $log
    }
    catch {
        "[$(Get-Date -Format s)] ERROR: $($_.Exception.Message)" | Add-Content $log
    }
    Start-Sleep -Seconds 5
}
