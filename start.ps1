$ErrorActionPreference = 'Stop'

$labelToolRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $labelToolRoot 'backend'
$frontendPath = Join-Path $labelToolRoot 'frontend'
$runtimePath = Join-Path $labelToolRoot '.runtime'
$virtualEnvPython = Join-Path $backendPath '.venv\Scripts\python.exe'
$bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'

New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null

function Get-ListeningPid([int]$Port) {
    $pattern = '^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$'
    foreach ($netstatLine in @(netstat -ano -p tcp)) {
        if ($netstatLine -match $pattern) { return [int]$Matches[1] }
    }
    return $null
}

function Test-HttpUrl([string]$Url) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

$backendPid = Get-ListeningPid 5001
$frontendPid = Get-ListeningPid 5173
if ($backendPid -and -not (Test-HttpUrl 'http://127.0.0.1:5001/api/health')) { throw 'Port 5001 is occupied by an unexpected service.' }
if ($frontendPid -and -not (Test-HttpUrl 'http://127.0.0.1:5173/')) { throw 'Port 5173 is occupied by an unexpected service.' }

if (Test-Path -LiteralPath $virtualEnvPython) {
    $pythonExecutable = $virtualEnvPython
} else {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) { $pythonExecutable = $pythonCommand.Source }
    elseif (Test-Path -LiteralPath $bundledPython) { $pythonExecutable = $bundledPython }
    else { throw 'Python was not found. Install Python 3.11 or later.' }
}

if (-not (Test-Path -LiteralPath (Join-Path $frontendPath 'node_modules'))) { throw 'Frontend dependencies are missing. In frontend, run: npm install' }

if (-not $backendPid) {
    Start-Process -FilePath $pythonExecutable -ArgumentList 'app.py' -WorkingDirectory $backendPath -RedirectStandardOutput (Join-Path $runtimePath 'backend.log') -RedirectStandardError (Join-Path $runtimePath 'backend-error.log') -WindowStyle Hidden | Out-Null
}
if (-not $frontendPid) {
    Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev', '--', '--host', '127.0.0.1', '--strictPort' -WorkingDirectory $frontendPath -RedirectStandardOutput (Join-Path $runtimePath 'frontend.log') -RedirectStandardError (Join-Path $runtimePath 'frontend-error.log') -WindowStyle Hidden | Out-Null
}

$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ((Test-HttpUrl 'http://127.0.0.1:5001/api/health') -and (Test-HttpUrl 'http://127.0.0.1:5173/')) {
        $ready = $true
        break
    }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw 'Startup failed. Check files in the .runtime directory.' }

$backendPid = Get-ListeningPid 5001
$frontendPid = Get-ListeningPid 5173
if ($backendPid) { Set-Content -LiteralPath (Join-Path $runtimePath 'backend.pid') -Value $backendPid -Encoding ASCII }
if ($frontendPid) { Set-Content -LiteralPath (Join-Path $runtimePath 'frontend.pid') -Value $frontendPid -Encoding ASCII }

Write-Host 'Label tool started:' -ForegroundColor Green
Write-Host 'http://127.0.0.1:5173/'
Write-Host 'To stop the services, run: .\stop.ps1'
