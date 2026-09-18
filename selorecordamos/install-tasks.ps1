$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$listenerHidden = Join-Path $PSScriptRoot 'run-telegram-hidden.vbs'
$searchHidden = Join-Path $PSScriptRoot 'run-search-hidden.vbs'

if (-not (Test-Path $listenerHidden)) { throw "No existe $listenerHidden" }
if (-not (Test-Path $searchHidden)) { throw "No existe $searchHidden" }

$listenerTask = 'SeLoRecordamos-Telegram'
$searchTask = 'SeLoRecordamos-Search'
$wscript = "$env:SystemRoot\System32\wscript.exe"
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$listenerAction = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + $listenerHidden + '"')
$searchAction = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + $searchHidden + '"')
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

# Recupera ejecuciones tras apagado/suspension y no se detiene por bateria.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

Write-Host 'Creando tarea del listener de Telegram...'
$listenerTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
Register-ScheduledTask -TaskName $listenerTask -Action $listenerAction -Trigger $listenerTrigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host 'Creando tarea de busqueda horaria robusta...'
# Compatibilidad amplia con Windows PowerShell 5.1:
# schtasks crea de forma fiable la repeticion horaria; despues ajustamos settings
# y anadimos un segundo trigger al iniciar sesion con el modulo ScheduledTasks.
$searchCmd = '"' + $wscript + '" "' + $searchHidden + '"'
& schtasks.exe /Create /TN $searchTask /TR $searchCmd /SC HOURLY /MO 1 /ST 00:05 /RL LIMITED /F | Out-Host
if ($LASTEXITCODE -ne 0) { throw "No se pudo crear $searchTask" }

$searchTaskObj = Get-ScheduledTask -TaskName $searchTask
Set-ScheduledTask -TaskName $searchTask -Settings $settings | Out-Null

# Anadimos disparador al iniciar sesion conservando el trigger horario existente.
$existingTriggers = @((Get-ScheduledTask -TaskName $searchTask).Triggers)
$searchLogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
Set-ScheduledTask -TaskName $searchTask -Trigger @($existingTriggers + $searchLogonTrigger) | Out-Null

Write-Host 'Arrancando listener ahora...'
Start-ScheduledTask -TaskName $listenerTask

Write-Host 'Ejecutando una busqueda ahora para validar y recuperar el periodo apagado...'
Start-ScheduledTask -TaskName $searchTask

Start-Sleep -Seconds 2

Write-Host ''
Write-Host 'Tareas instaladas:' -ForegroundColor Green
Get-ScheduledTask -TaskName $listenerTask, $searchTask | ForEach-Object {
    $info = Get-ScheduledTaskInfo -TaskName $_.TaskName
    [PSCustomObject]@{
        TaskName = $_.TaskName
        State = $_.State
        LastRunTime = $info.LastRunTime
        LastTaskResult = $info.LastTaskResult
        NextRunTime = $info.NextRunTime
    }
} | Format-Table -AutoSize
Write-Host ''
Write-Host 'SeLoRecordamos queda configurado sin ventanas visibles.' -ForegroundColor Green
Write-Host 'La busqueda se ejecuta al iniciar sesion y cada hora a los :05; StartWhenAvailable recupera ejecuciones perdidas.'
