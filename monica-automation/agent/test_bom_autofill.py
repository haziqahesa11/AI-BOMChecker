"""On-host agent: fills MonicaTPGenerator.exe's Test BOM tab via its native
Save/Load CSV round-trip (CONTEXT.md Phase 4's "escape hatch" — TPG validates
Current PN vs Saved PN and only fills currently-unset cells, so a generated
CSV drives the grid through the app's own logic instead of UI-scripting
individual cells). Never clicks Submit — a human reviews the grid (red/green
cells) and submits manually, matching qvl_autofill_agent.py's write-gate
discipline.

STATUS 2026-07-14: NOT YET VERIFIED END TO END.
  - Model Reference / Part Number combo selectors ARE confirmed against the
    real app (see ../PHASE_QVL_DISCOVERY_FINDINGS.md) — selecting them was
    tested live.
  - bom_builder.build_csv() currently raises NotImplementedError — the real
    CSV column order/delimiter/quoting was never empirically confirmed (that
    requires hand-filling a row and clicking Save in the live app, which is
    on hold pending a decision on how to safely derive it). This function
    will fail at that step until it's unblocked.
  - The Load file dialog's exact title/control layout is UNCONFIRMED — never
    actually clicked Load against the real app this round. By symmetry with
    the confirmed "Save File" dialog (native Windows dialog, filename Edit
    control at automation_id="1001", found via the UIA backend — see
    click_save_uia2.py-style discovery in the session that produced
    PHASE_QVL_DISCOVERY_FINDINGS.md), it is assumed to be titled "Open File"
    with the same layout, but this is a guess, not a confirmed fact — verify
    with a dedicated discovery pass (extend tpg_control_discovery.py/.ps1 to
    enumerate the open #32770 window) before trusting this in production.
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

from pywinauto import Application, Desktop

from monica.bom_builder import build_csv, resolve_test_bom_rows

from .config import AgentConfig
from .job_client import Job

logger = logging.getLogger("agent.test_bom_autofill")

STAGING_DIR = Path(__file__).resolve().parent.parent / "staging"

# UNCONFIRMED — see module docstring.
_OPEN_DIALOG_TITLE = "Open File"
_FILENAME_FIELD_AUTO_ID = "1001"


class DialogValidationError(RuntimeError):
    """Raised when TPG's own Load validation rejects the file (e.g. PN mismatch)."""


def _staged_csv_path(job: Job) -> Path:
    STAGING_DIR.mkdir(exist_ok=True)
    safe_pn = job.part_number.replace("/", "_").replace("\\", "_").replace("$", "_")
    return STAGING_DIR / f"test_bom_{job.model_ref}_{safe_pn}_{job.job_id}.csv"


def fill_test_bom_tab(config: AgentConfig, job: Job) -> None:
    rows = resolve_test_bom_rows(job.model_ref, job.part_number)
    csv_path = _staged_csv_path(job)
    build_csv(rows, csv_path)  # raises NotImplementedError until the schema is confirmed

    app = Application(backend="win32").connect(path=config.tpg_exe_path, timeout=5)
    window = app.window(title_re=".*Monica.*Test.*Program.*Generator.*")
    window.set_focus()

    top_tab = window.child_window(auto_id="tabCtl", control_type="System.Windows.Forms.TabControl")
    top_tab.select("Test BOM")

    model_combo = window.child_window(
        auto_id="cmBoxTestbomModelReferenceList", control_type="System.Windows.Forms.ComboBox"
    )
    model_combo.wait("exists enabled", timeout=15)
    model_combo.select(job.model_ref)

    pn_combo = window.child_window(auto_id="cmBoxTestbomPNList", control_type="System.Windows.Forms.ComboBox")
    pn_combo.wait("exists enabled", timeout=15)
    pn_combo.select(job.part_number)
    time.sleep(1.0)  # let the grid load before opening Load's dialog

    load_btn = window.child_window(auto_id="btnTestbomLoadXml", control_type="System.Windows.Forms.Button")
    load_btn.click_input()

    dlg_handle = None
    for _ in range(10):
        time.sleep(0.4)
        windows = Desktop(backend="win32").windows(title=_OPEN_DIALOG_TITLE, class_name="#32770")
        if windows:
            dlg_handle = windows[0].handle
            break
    if dlg_handle is None:
        raise RuntimeError(f"{_OPEN_DIALOG_TITLE!r} dialog never appeared after clicking Load")

    uia_app = Application(backend="uia").connect(handle=dlg_handle)
    uia_dlg = uia_app.window(handle=dlg_handle)
    name_ctrl = uia_dlg.child_window(auto_id=_FILENAME_FIELD_AUTO_ID)
    name_ctrl.set_edit_text(str(csv_path))
    time.sleep(0.3)

    open_btn = uia_dlg.child_window(title="Open", control_type="Button")
    open_btn.click_input()
    time.sleep(1.5)

    # TPG shows a message box (e.g. "INCORRECT PART NUMBER!") on validation
    # failure — treat any unexpected modal as an error rather than silently
    # continuing. A real discovery pass should confirm this dialog's exact
    # title/class before this check can be trusted.
    error_dialogs = Desktop(backend="win32").windows(class_name="#32770")
    error_dialogs = [d for d in error_dialogs if d.handle != dlg_handle]
    if error_dialogs:
        text = error_dialogs[0].window_text()
        raise DialogValidationError(f"TPG rejected the Load: {text!r}")

    logger.info(
        "Test BOM loaded for %s / %s from %s — awaiting human review, not submitting",
        job.model_ref, job.part_number, csv_path,
    )
