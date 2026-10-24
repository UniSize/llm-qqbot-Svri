@echo off
rem ============================================================
rem  Reload the bot so .env and personas/ changes take effect.
rem  Double-click this file. No administrator rights needed.
rem
rem  This wrapper is intentionally pure ASCII: cmd.exe renders
rem  non-ASCII batch files with the console code page, which
rem  turns Chinese text into garbage. All user-facing messages
rem  live in reload.ps1 (saved as UTF-8 with BOM).
rem ============================================================
setlocal
chcp 65001 >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0reload.ps1" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo [reload] exited with code %RC%
)
echo.
pause
exit /b %RC%
