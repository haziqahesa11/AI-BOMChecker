"""Shared helper: attach to an already-running MonicaTPGenerator.exe, or
launch it fresh from the vendored repo copy if it isn't open yet. Used by
both qvl_autofill_agent.fill_qvl_tab() and test_bom_autofill.fill_test_bom_tab()
so "launch if needed" logic lives in exactly one place.

Only ever attaches or launches — never clicks anything inside the app. The
write-gate discipline (never ADD/MODIFY/DELETE/Submit) lives entirely in the
callers, per ../CONTEXT.md.
"""
from __future__ import annotations

import logging

from pywinauto import Application
from pywinauto.application import ProcessNotFoundError

from .config import AgentConfig

logger = logging.getLogger("agent.tpg_process")

_WINDOW_TITLE_RE = ".*Monica.*Test.*Program.*Generator.*"


def connect_or_launch(config: AgentConfig) -> Application:
    """Return an Application attached to TPG's main window, launching it
    first if no matching process is already running.

    ProcessNotFoundError (raised by .connect(path=...) when nothing matches
    that exe path) means "not open yet" and is the only case that triggers a
    launch. ElementNotFoundError — raised later, by callers, when a specific
    control is missing inside an already-attached window — is a real bug and
    must NOT be caught here or it would launch a redundant second instance
    every time a selector goes stale.
    """
    try:
        app = Application(backend="win32").connect(path=config.tpg_exe_path, timeout=3)
        logger.info("attached to already-running TPG instance")
    except ProcessNotFoundError:
        logger.info("no running TPG instance found at %s — launching it", config.tpg_exe_path)
        app = Application(backend="win32").start(config.tpg_exe_path)

    window = app.window(title_re=_WINDOW_TITLE_RE)
    window.wait("visible ready", timeout=45)
    window.set_focus()
    return app
