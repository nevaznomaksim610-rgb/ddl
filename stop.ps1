$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
New-Item -ItemType File -Path 'data\stop' -Force | Out-Null
foreach ($pidFile in @('data\bot.pid', 'data\supervisor.pid')) {
    if (Test-Path -LiteralPath $pidFile) {
        $botProcessId = [int](Get-Content -LiteralPath $pidFile)
        $owned = Get-CimInstance Win32_Process -Filter "ProcessId = $botProcessId"
        if ($owned -and ($owned.CommandLine -like '*src/main.js*' -or $owned.CommandLine -like "*$PSScriptRoot\run.ps1*")) {
            Stop-Process -Id $botProcessId -Force
            Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        }
    }
}
Write-Output 'Бот остановлен'
