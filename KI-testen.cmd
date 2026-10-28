@echo off
rem Prueft, ob der KI-Schluessel in .env funktioniert (kleine Testanfrage ohne Briefdaten).
chcp 65001 >nul
title BriefPilot - KI testen
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js wurde nicht gefunden. Bitte zuerst die LTS-Version von https://nodejs.org installieren.
  pause
  exit /b 1
)
call npm run ki-test --silent
echo.
pause
