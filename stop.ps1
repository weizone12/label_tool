$ErrorActionPreference = 'Stop'

$allowedNames = @('python', 'node')
$stopped = @()

function Get-ListeningPids([int]$Port) {
    $result = @()
    $pattern = '^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$'
    foreach ($netstatLine in @(netstat -ano -p tcp)) {
        if ($netstatLine -match $pattern) { $result += [int]$Matches[1] }
    }
    return @($result | Select-Object -Unique)
}

foreach ($port in @(5001, 5173)) {
    foreach ($targetPid in @(Get-ListeningPids $port)) {
        $targetProcess = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
        if (-not $targetProcess) { continue }
        $processName = $targetProcess.ProcessName.ToLowerInvariant()
        if ($allowedNames -notcontains $processName) { throw "Port $port is owned by $processName (PID $targetPid). Refusing to stop an unknown process." }
        Stop-Process -Id $targetPid -Force
        $stopped += New-Object PSObject -Property @{ Port = $port; PID = $targetPid; Process = $processName }
    }
}

$runtimePath = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '.runtime'
foreach ($pidFile in @('backend.pid', 'frontend.pid')) {
    $pidPath = Join-Path $runtimePath $pidFile
    if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
}

if ($stopped.Count -eq 0) {
    Write-Host 'The label tool is not running.'
} else {
    $stopped | Select-Object Port, PID, Process | Format-Table -AutoSize
    Write-Host 'Label tool stopped.' -ForegroundColor Green
}
