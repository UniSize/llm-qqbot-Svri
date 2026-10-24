@echo off
rem WebUI console launcher.
rem Pure ASCII on purpose: cmd.exe renders non-ASCII batch files with the
rem console code page, which turns UTF-8 text into mojibake.
chcp 65001 >nul 2>&1
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo [webui] node.exe not found in PATH. Install Node.js 18+ first.
  pause
  exit /b 1
)
node "%~dp0bin\webui.js" %*
if errorlevel 1 echo.
echo [webui] exited.
pause
