#Requires -Version 5.1
<#
.SYNOPSIS
  Installs the Zone Watch MT5 bridge on a Windows machine so the app can reach
  your Exness account 24/5 without you keeping a laptop open.

.DESCRIPTION
  Run this once on a Windows VPS (or a PC you leave on). It does all of it:

    - installs Python and the MetaTrader5 package
    - installs the Exness MetaTrader 5 terminal and launches it
    - copies the bridge, writes its configuration, locks the file down
    - registers a scheduled task that starts MT5 and the bridge at logon and
      restarts the bridge if it ever dies
    - opens the port in Windows Firewall
    - prints the two values to paste into the app

  It is safe to run twice: everything is overwritten, not duplicated.

.EXAMPLE
  # On the VPS, in PowerShell opened as Administrator, from the bridge folder:
  .\setup-windows.ps1 -Login 12345678 -Password 'your-mt5-password' -Server Exness-MT5Trial8

.EXAMPLE
  # Real account: add -Live. Nothing about a live account happens by accident.
  .\setup-windows.ps1 -Login 12345678 -Password 'x' -Server Exness-Real -Live

.NOTES
  A live account is refused by the bridge itself unless ALLOW_LIVE=1, which
  -Live sets. Practise on the demo first: same commands, different account.
#>
[CmdletBinding()]
param(
    # MT5 account number and password (the broker login, not your email).
    [Parameter(Mandatory = $true)][string]$Login,
    [Parameter(Mandatory = $true)][string]$Password,

    # The server string exactly as MT5 shows it, e.g. Exness-MT5Trial8.
    [string]$Server = "Exness-MT5Trial8",

    # Bridge secret. Generated if omitted; the same value goes into the app.
    [string]$Token = "",

    [int]$Port = 8787,
    [string]$InstallDir = "C:\ZoneWatch",

    # Exness's MT5 installer. Replace with another broker's installer if needed.
    [string]$Mt5Installer = "https://download.mql5.com/cdn/web/exness.technologies.ltd/mt5/exness5setup.exe",

    # Where mt5_bridge.py lives. Defaults to this script's own folder.
    [string]$BridgeSource = "",

    # Allow trading a real-money account.
    [switch]$Live,

    # Sign Windows in automatically after a reboot, so the task can start with
    # nobody watching. Stores the password in the registry (see the warning).
    [switch]$EnableAutoLogon
)

$ErrorActionPreference = "Stop"

function Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Note($message) { Write-Host "    $message" -ForegroundColor DarkGray }
function Stop-Here($message) {
    Write-Host "!!  $message" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- preflight --
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Stop-Here "Open PowerShell as Administrator (right-click -> Run as administrator) and run this again."
}

if ($Live -and $Server -notmatch "real|live") {
    Write-Host "!!  -Live was passed but the server '$Server' does not look like a real-account server." -ForegroundColor Yellow
    Write-Host "    That is allowed, but check the account number: this is the switch that spends money." -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Note "installing into $InstallDir"

if (-not $Token) {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Note "generated a bridge secret"
}

# ------------------------------------------------------------------ python --
function Find-Python {
    foreach ($candidate in @("py", "python")) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if (-not $command) { continue }
        try {
            if ($candidate -eq "py") { $major = & py -3 -c "import sys;print(sys.version_info[0])" 2>$null }
            else { $major = & python -c "import sys;print(sys.version_info[0])" 2>$null }
        } catch { continue }
        if ("$major".Trim() -eq "3") { return $candidate }
    }
    return $null
}

$python = Find-Python
if (-not $python) {
    Step "Installing Python"
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements | Out-Null
    } else {
        $installer = Join-Path $env:TEMP "python-setup.exe"
        Invoke-WebRequest "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe" -OutFile $installer
        Start-Process $installer -ArgumentList "/quiet", "InstallAllUsers=1", "PrependPath=1" -Wait
    }
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    $python = Find-Python
    if (-not $python) { Stop-Here "Python did not install. Get it from python.org, tick 'Add python.exe to PATH', then run this again." }
}

$pythonExe = (& $python -c "import sys;print(sys.executable)" | Select-Object -First 1).Trim()
Note "python: $pythonExe"

Step "Installing the MetaTrader5 package"
& $pythonExe -m pip install --upgrade pip --quiet --disable-pip-version-check
& $pythonExe -m pip install --upgrade MetaTrader5 --quiet --disable-pip-version-check
& $pythonExe -c "import MetaTrader5" 2>$null
if ($LASTEXITCODE -ne 0) {
    Stop-Here "The MetaTrader5 package did not import. Run: `"$pythonExe`" -m pip install MetaTrader5"
}

# --------------------------------------------------------------------- mt5 --
$terminalCandidates = @(
    "C:\Program Files\MetaTrader 5\terminal64.exe",
    "C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe",
    "C:\Program Files (x86)\MetaTrader 5\terminal64.exe"
)
$terminal = $terminalCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $terminal) {
    Step "Installing MetaTrader 5"
    $setup = Join-Path $env:TEMP "mt5-setup.exe"
    try {
        Invoke-WebRequest $Mt5Installer -OutFile $setup -UseBasicParsing
        Start-Process $setup -ArgumentList "/auto" -Wait
    } catch {
        Write-Host "!!  Could not install MT5 automatically: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    Start-Sleep -Seconds 20
    $terminal = $terminalCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ($terminal) { Note "terminal: $terminal" }
else { Write-Host "!!  MT5 was not found. Install it, log in once with 'Save account information' ticked, then run this again." -ForegroundColor Yellow }

# ------------------------------------------------------------------ bridge --
$bridgeFile = if ($BridgeSource) { $BridgeSource } else { Join-Path $PSScriptRoot "mt5_bridge.py" }
if (-not (Test-Path $bridgeFile)) {
    Stop-Here "mt5_bridge.py not found at $bridgeFile. Copy the whole bridge folder to the server, or pass -BridgeSource."
}
Copy-Item $bridgeFile (Join-Path $InstallDir "bridge.py") -Force

$envFile = Join-Path $InstallDir "bridge.env"
$allowLive = if ($Live) { "1" } else { "0" }
@(
    "ZW_BRIDGE_TOKEN=$Token"
    "ZW_BRIDGE_PORT=$Port"
    "MT5_LOGIN=$Login"
    "MT5_PASSWORD=$Password"
    "MT5_SERVER=$Server"
    "ALLOW_LIVE=$allowLive"
) | Set-Content -Path $envFile -Encoding ASCII

# The file holds a trading password: only this user, SYSTEM and admins may read it.
& icacls $envFile /inheritance:r /grant:r "$($env:USERNAME):(R)" "SYSTEM:(R)" "Administrators:(F)" | Out-Null

# One script that starts the terminal, then keeps the bridge alive in a loop.
$runner = Join-Path $InstallDir "run-bridge.cmd"
$runnerBody = @"
@echo off
setlocal
for /f "usebackq tokens=1,* delims==" %%A in ("$envFile") do set "%%A=%%B"

rem The terminal must be running and logged in; the Python package talks to it.
if not exist "%ProgramFiles%\MetaTrader 5\terminal64.exe" if exist "%ProgramFiles%\MetaTrader 5 EXNESS\terminal64.exe" set "TERM=%ProgramFiles%\MetaTrader 5 EXNESS\terminal64.exe"
if not defined TERM set "TERM=%ProgramFiles%\MetaTrader 5\terminal64.exe"
tasklist /fi "imagename eq terminal64.exe" 2>nul | find /i "terminal64.exe" >nul || start "" "%TERM%"
timeout /t 25 /nobreak >nul

:loop
"$pythonExe" "$InstallDir\bridge.py" >> "$InstallDir\bridge.log" 2>&1
timeout /t 15 /nobreak >nul
goto loop
"@
Set-Content -Path $runner -Value $runnerBody -Encoding ASCII

# --------------------------------------------------------------- autostart --
Step "Registering the startup task"
$action = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $InstallDir
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"),
    (New-ScheduledTaskTrigger -AtStartup)
)
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "ZoneWatchBridge" `
    -Action $action -Trigger $triggers -Settings $settings `
    -RunLevel Highest -User "$env:USERDOMAIN\$env:USERNAME" -Force | Out-Null

if ($EnableAutoLogon) {
    Step "Enabling automatic sign-in after a reboot"
    $winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
    Set-ItemProperty $winlogon -Name "AutoAdminLogon" -Value "1"
    Set-ItemProperty $winlogon -Name "DefaultUserName" -Value $env:USERNAME
    Set-ItemProperty $winlogon -Name "DefaultPassword" -Value $Password
    Set-ItemProperty $winlogon -Name "DefaultDomainName" -Value $env:COMPUTERNAME
    Write-Host "!!  The Windows password is now stored in the registry so the machine can sign itself in." -ForegroundColor Yellow
    Write-Host "    That is what makes a reboot recover unattended. Skip -EnableAutoLogon if you prefer to log in yourself." -ForegroundColor Yellow
}

# ----------------------------------------------------------------- firewall --
Step "Opening port $Port"
New-NetFirewallRule -DisplayName "Zone Watch bridge ($Port)" `
    -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow `
    -ErrorAction SilentlyContinue | Out-Null

# -------------------------------------------------------------------- start --
Step "Starting the bridge"
Start-Process $runner -WindowStyle Hidden
Start-Sleep -Seconds 20

$bridgeOk = $false
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Headers @{ "x-bridge-token" = $Token } -TimeoutSec 20
    if ($health.ok) {
        $kind = if ($health.demo) { "DEMO" } else { "LIVE" }
        Write-Host "    connected to $($health.login) on $($health.server) ($kind), balance $($health.balance) $($health.currency)" -ForegroundColor Green
        $bridgeOk = $true
    } else {
        Write-Host "    bridge answered but not healthy: $($health.error)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "    bridge not answering yet. It retries every 15 seconds; check $InstallDir\bridge.log" -ForegroundColor Yellow
}

# ------------------------------------------------------------------ summary --
$publicIp = ""
try { $publicIp = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 10).Trim() } catch { }

Write-Host ""
Write-Host "------------------------------- done -------------------------------" -ForegroundColor Green
Write-Host "In Zone Watch -> Risk -> Auto-trading:"
Write-Host "  Mode          Bridge (MetaTrader 5)"
if ($publicIp) { Write-Host "  Bridge URL    http://${publicIp}:$Port" }
else { Write-Host "  Bridge URL    http://<this machine's public IP>:$Port" }
Write-Host "  Bridge secret $Token"
Write-Host ""
Write-Host "Then press Test bridge -> Read Exness account -> Read live spreads."
Write-Host "Logs: $InstallDir\bridge.log     Settings: $envFile"
Write-Host "The task 'ZoneWatchBridge' starts everything at boot; it also restarts the bridge if it dies."
if (-not $bridgeOk) {
    Write-Host ""
    Write-Host "Next: open MetaTrader 5, log in, tick 'Save account information', then close and reopen it." -ForegroundColor Yellow
    Write-Host "Then run this script again (same command) so it verifies the connection." -ForegroundColor Yellow
}
Write-Host "-------------------------------------------------------------------"
