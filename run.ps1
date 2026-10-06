$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
    while (-not (Test-Path -LiteralPath 'data\stop')) {
        & cmd.exe /d /c 'node --env-file=.env src/main.js >> logs\bot.log 2>> logs\bot-error.log'
        if ($LASTEXITCODE -eq 2) { break }
        if (-not (Test-Path -LiteralPath 'data\stop')) { Start-Sleep -Seconds 5 }
    }
} finally {
    Remove-Item -LiteralPath 'data\supervisor.pid' -Force -ErrorAction SilentlyContinue
}
