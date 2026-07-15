"""Run this ON 10.251.231.65, with MonicaTPGenerator.exe already open on the QVL tab.

Prints every window/control's automation id, class name, and text so the real
pywinauto selectors in qvl_autofill_agent.py can be filled in from actual output
instead of guessed — per CONTEXT.md's "verify every phase" rule. Read-only:
this only inspects the running window, it never clicks or types anything.

Usage (from monica-automation/, with the venv active):
    python -m agent.tpg_control_discovery
"""
from __future__ import annotations

from pywinauto import Desktop


def main() -> None:
    windows = Desktop(backend="win32").windows(title_re=".*Monica.*Test.*Program.*Generator.*")
    if not windows:
        print("No MonicaTPGenerator window found — open the app first, then re-run this.")
        return

    window = windows[0]
    print(f"Found window: {window.window_text()!r}")
    window.print_control_identifiers()


if __name__ == "__main__":
    main()
