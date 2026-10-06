$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
New-Item -ItemType Directory -Path 'logs', 'data' -Force | Out-Null
if (Test-Path -LiteralPath 'data\supervisor.pid') {
    $runnerId = [int](Get-Content -LiteralPath 'data\supervisor.pid')
    if (Get-Process -Id $runnerId -ErrorAction SilentlyContinue) {
        Write-Output "Бот уже запущен (supervisor PID $runnerId)"
        exit 0
    }
}
Remove-Item -LiteralPath 'data\stop' -Force -ErrorAction SilentlyContinue
$runner = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSScriptRoot\run.ps1`"") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Set-Content -LiteralPath 'data\supervisor.pid' -Value $runner.Id
Write-Output "Запущен supervisor PID $($runner.Id). Логи: logs\bot.log, logs\bot-error.log"
