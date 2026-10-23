@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Sites.ps1" %*
pause
