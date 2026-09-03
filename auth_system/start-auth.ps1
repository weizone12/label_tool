$ErrorActionPreference = 'Stop'

$authRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $authRoot 'backend'
$frontendPath = Join-Path $authRoot 'frontend'
$runtimePath = Join-Path $authRoot '.runtime'
$pythonExecutable = Join-Path $backendPath '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw 'Auth backend dependencies are missing. Create backend/.venv and install backend/requirements.txt.' }
if (-not (Test-Path -LiteralPath (Join-Path $frontendPath 'node_modules'))) { throw 'Auth frontend dependencies are missing. Run npm install in auth_system/frontend.' }
New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null

function Get-ListeningPid([int]$Port) {
    $pattern = '^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$'
    foreach ($line in @(netstat -ano -p tcp)) { if ($line -match $pattern) { return [int]$Matches[1] } }
    return $null
}

if (Get-ListeningPid 5002) { throw 'Auth backend port 5002 is already in use.' }
if (Get-ListeningPid 5174) { throw 'Auth frontend port 5174 is already in use.' }

$backend = Start-Process -FilePath $pythonExecutable -ArgumentList 'app.py' -WorkingDirectory $backendPath -RedirectStandardOutput (Join-Path $runtimePath 'backend.log') -RedirectStandardError (Join-Path $runtimePath 'backend-error.log') -WindowStyle Hidden -PassThru
$frontend = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev', '--', '--host', '127.0.0.1', '--strictPort' -WorkingDirectory $frontendPath -RedirectStandardOutput (Join-Path $runtimePath 'frontend.log') -RedirectStandardError (Join-Path $runtimePath 'frontend-error.log') -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $runtimePath 'backend.pid') -Value $backend.Id -Encoding ASCII
Set-Content -LiteralPath (Join-Path $runtimePath 'frontend.pid') -Value $frontend.Id -Encoding ASCII

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5002/api/health' -TimeoutSec 2
        $frontendReady = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5174/login' -TimeoutSec 2).StatusCode -eq 200
        if ($health.service -eq 'auth' -and $frontendReady) {
            Write-Host 'Standalone auth system started: http://127.0.0.1:5174/login' -ForegroundColor Green
            exit 0
        }
    } catch {}
    Start-Sleep -Milliseconds 500
}
throw 'Auth startup failed. Check auth_system/.runtime logs.'
