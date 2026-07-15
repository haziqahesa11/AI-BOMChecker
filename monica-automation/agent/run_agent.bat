@echo off
rem Convenience launcher for the QVL autofill agent, meant to run inside the
rem persistent logged-in session on 10.251.231.65 (e.g. from Task Scheduler,
rem "run only when user is logged on", or just left open in a terminal).
cd /d "%~dp0.."
if not exist ".venv\Scripts\python.exe" (
  echo No .venv found here. Run: python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
  exit /b 1
)
.venv\Scripts\python.exe -m agent.qvl_autofill_agent
