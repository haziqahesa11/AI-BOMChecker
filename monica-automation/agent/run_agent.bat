@echo off
rem Convenience launcher for the QVL autofill agent. Runs on a normal
rem engineering laptop alongside BackEnd/server.js and TPG itself — see
rem ../../tools/monica-access/README.md for why this works directly (no RDP
rem needed). Leave this running in a terminal, or launch it at logon.
cd /d "%~dp0.."
if not exist ".venv\Scripts\python.exe" (
  echo No .venv found here. Run: python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
  exit /b 1
)
.venv\Scripts\python.exe -m agent.qvl_autofill_agent
