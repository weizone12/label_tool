$ErrorActionPreference = 'Stop'

$authRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimePath = Join-Path $authRoot '.runtime'

function Get-ListeningPid([int]$Port) {
    $pattern = '^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$'
    foreach ($line in @(netstat -ano -p tcp)) { if ($line -match $pattern) { return [int]$Matches[1] } }
    return $null
}

foreach ($name in @('backend.pid', 'frontend.pid')) {
    $pidPath = Join-Path $runtimePath $name
    if (-not (Test-Path -LiteralPath $pidPath)) { continue }
    $processId = [int](Get-Content -LiteralPath $pidPath -Raw)
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) { Stop-Process -Id $processId -Force }
    Remove-Item -LiteralPath $pidPath -Force
}
foreach ($port in @(5002, 5174)) {
    $listeningPid = Get-ListeningPid $port
    if ($listeningPid) { Stop-Process -Id $listeningPid -Force -ErrorAction SilentlyContinue }
}
Write-Host 'Standalone auth system stopped.' -ForegroundColor Green
