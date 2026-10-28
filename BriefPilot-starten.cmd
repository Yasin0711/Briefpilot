@echo off
rem BriefPilot unter Windows starten: beim ersten Mal einrichten, dann Server starten und Browser oeffnen.
chcp 65001 >nul
title BriefPilot
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js wurde nicht gefunden.
  echo Bitte auf https://nodejs.org die Version "LTS" installieren und diese Datei danach erneut starten.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1,2 delims=." %%a in ('node -p "process.versions.node"') do (
  set NODE_MAJOR=%%a
  set NODE_MINOR=%%b
)
if %NODE_MAJOR% LSS 22 goto zu_alt
if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 13 goto zu_alt
goto version_ok
:zu_alt
echo.
echo Ihre Node.js-Version ist zu alt. Bitte die aktuelle LTS-Version von https://nodejs.org installieren.
echo.
pause
exit /b 1
:version_ok

if not exist ".env" (
  echo Erster Start: Einstellungen werden eingerichtet ...
  call npm run setup
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo.
echo BriefPilot startet. Das Browserfenster oeffnet sich in wenigen Sekunden.
echo Zum Beenden dieses Fenster schliessen oder Strg+C druecken.
echo.
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
call npm start
echo.
echo BriefPilot wurde beendet.
pause
