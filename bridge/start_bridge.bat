@echo off
REM Zone Watch MT5 bridge - double-click to start.
REM Edit the four values below once, save, then just run this file.

set ZW_BRIDGE_TOKEN=change-me-to-a-long-random-string
set MT5_LOGIN=your-demo-account-number
set MT5_PASSWORD=your-demo-password
set MT5_SERVER=Exness-MT5Trial8

cd /d "%~dp0"
python mt5_bridge.py
pause
