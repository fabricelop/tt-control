$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo
$env:X_AUTH_TOKEN = [Environment]::GetEnvironmentVariable('X_AUTH_TOKEN','User')
$env:X_CT0 = [Environment]::GetEnvironmentVariable('X_CT0','User')
$env:SR_HEADLESS = '1'
$env:SR_PUBLISHED_SINCE = '2026-09-14T00:00:00+02:00'
$env:SR_PUBLISHED_PUSH = '1'
$logDir = Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'published-import-task.log'
"[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] Inicio historico publicado" | Add-Content $log
try {
  $outFile = Join-Path $logDir 'published-import-stdout.log'
  $errFile = Join-Path $logDir 'published-import-stderr.log'
  Remove-Item $outFile,$errFile -Force -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath 'node.exe' -ArgumentList (Join-Path $PSScriptRoot 'import_published.js') -WorkingDirectory $repo -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  if (Test-Path $outFile) { Get-Content $outFile | Add-Content $log }
  if (Test-Path $errFile) {
    $stderr = Get-Content $errFile
    $realErrors = @($stderr | Where-Object { $_ -and $_ -notmatch '^warning: in the working copy of .*LF will be replaced by CRLF' -and $_ -notmatch '^the next time Git touches it' })
    if ($realErrors.Count -gt 0) { $realErrors | Add-Content $log }
  }
  if ($p.ExitCode -ne 0) { throw "import_published.js termino con codigo $($p.ExitCode)" }
  "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] Fin correcto" | Add-Content $log
} catch {
  "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] ERROR: $($_.Exception.Message)" | Add-Content $log
  exit 1
}
