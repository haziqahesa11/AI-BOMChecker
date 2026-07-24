"""On-host agent: polls the backend's automation job queue and dispatches
each job by jobType — 'qvl_autofill' fills MonicaTPGenerator.exe's QVL tab
(Model Reference, Location, Part Number, Description; this module), while
'test_bom_autofill' fills the Test BOM tab via its Save/Load CSV round-trip
(test_bom_autofill.py). Neither ever clicks ADD / MODIFY or Submit — a human
always reviews and submits, matching the write-gate discipline in
../CONTEXT.md.

Runs entirely on a normal engineering laptop, alongside BackEnd/server.js and
TPG itself — see ../../tools/monica-access/README.md for why this works
without RDP/a remote host (TPG's own MonicaTPGenerator.xml now points its SQL
connection directly at 10.251.231.65, which is reachable from an ordinary
corporate laptop). If TPG isn't already open when a job arrives,
tpg_process.connect_or_launch() launches it from the repo-vendored copy
(../../@BOM-Based-APP/New MTPG/) — no manual pre-step required.

The QVL pywinauto selectors are confirmed against the real running app — see
../PHASE_QVL_DISCOVERY_FINDINGS.md for the discovery session that produced
them (all four of the previous guesses were wrong). The Test BOM path's
status is more mixed — see test_bom_autofill.py's module docstring.

Usage (from monica-automation/, with the venv active):
    python -m agent.qvl_autofill_agent
"""
from __future__ import annotations

import logging
import time
from pathlib import Path

import httpx
from pywinauto.findwindows import ElementNotFoundError

from monica.logging_setup import configure_logging

from .config import AgentConfig, load_agent_config
from .job_client import Job, fetch_next_job, report_result
from .test_bom_autofill import fill_test_bom_tab
from .tpg_process import connect_or_launch

logger = logging.getLogger("agent.qvl_autofill")


def fill_qvl_tab(config: AgentConfig, job: Job) -> None:
    """Launch/attach MonicaTPGenerator.exe and fill the QVL tab. Never submits.

    Selectors confirmed 2026-07-14 against the real running app — see
    ../PHASE_QVL_DISCOVERY_FINDINGS.md for the discovery session. The Model
    Reference and Location combos hold the exact raw strings used in job
    payloads (e.g. "C2012_L11", "L11" — confirmed present as combo items,
    "L11" is a legitimate whole-rack Location value alongside per-bay codes
    like "B01").
    """
    # connect_or_launch handles both cases: attach if TPG is already open, or
    # launch it fresh from the vendored repo copy if not — see tpg_process.py.
    # Its own connect(path=...) call is safe even with multiple running
    # instances of the same exe (confirmed empirically 2026-07-14):
    # pywinauto's process_from_module reverses its process list and attaches
    # to the MOST RECENTLY LAUNCHED matching instance, not an arbitrary/random
    # one. Still, if a TE has an older TPG window open and someone launches a
    # newer one, this will attach to the newer window, not necessarily the
    # one currently in focus/visible — the fill-only, never-submit design
    # means a wrong-window fill can't corrupt data, but it can confuse a
    # human watching the wrong window. Not hardened further here — out of
    # scope for this round.
    app = connect_or_launch(config)
    window = app.window(title_re=".*Monica.*Test.*Program.*Generator.*")

    top_tab = window.child_window(auto_id="tabCtl", control_type="System.Windows.Forms.TabControl")
    top_tab.select("QVL")

    # .wait("exists enabled") guards against a freshly-launched window whose
    # controls aren't interactive yet (TPG is still opening its SQL
    # connection) — a no-op if TPG was already open and warmed up, since the
    # condition is already true. test_bom_autofill.py's Test BOM path already
    # needed this same guard; the QVL path previously assumed an
    # already-open, already-warm instance and had no wait at all.
    model_ref_combo = window.child_window(
        auto_id="cmBoxQvlModelReferenceList", control_type="System.Windows.Forms.ComboBox"
    )
    model_ref_combo.wait("exists enabled", timeout=30)
    model_ref_combo.select(job.model_ref)

    location_combo = window.child_window(
        auto_id="cmBoxQvlLocation", control_type="System.Windows.Forms.ComboBox"
    )
    location_combo.wait("exists enabled", timeout=15)
    location_combo.select(job.location)

    pn_edit = window.child_window(auto_id="txtBoxQvlPN", control_type="System.Windows.Forms.TextBox")
    pn_edit.set_text(job.part_number)

    if job.description:
        description_edit = window.child_window(
            auto_id="txtBoxQvlDescription", control_type="System.Windows.Forms.TextBox"
        )
        description_edit.set_text(job.description)

    logger.info(
        "filled QVL tab for %s / %s / %s — awaiting human review, not submitting",
        job.model_ref, job.location, job.part_number,
    )


def run_forever(config: AgentConfig | None = None) -> None:
    config = config or load_agent_config()
    logger.info("polling %s every %.1fs", config.backend_base_url, config.poll_interval_seconds)
    with httpx.Client() as client:
        while True:
            try:
                job = fetch_next_job(client, config)
            except httpx.HTTPError as exc:
                logger.warning("poll failed: %s", exc)
                time.sleep(config.poll_interval_seconds)
                continue

            if job is None:
                time.sleep(config.poll_interval_seconds)
                continue

            logger.info(
                "got job %s (%s): %s / %s / %s",
                job.job_id, job.job_type, job.model_ref, job.location, job.part_number,
            )
            try:
                if job.job_type == "test_bom_autofill":
                    fill_test_bom_tab(config, job)
                    report_result(client, config, job.job_id, "filled", "Test BOM loaded; awaiting human review")
                else:
                    fill_qvl_tab(config, job)
                    report_result(client, config, job.job_id, "filled", "QVL tab populated; awaiting human review")
            except ElementNotFoundError as exc:
                logger.error("control not found for job %s: %s", job.job_id, exc)
                report_result(client, config, job.job_id, "error", str(exc))
            except Exception as exc:  # noqa: BLE001 - one bad job must not kill the poll loop
                logger.exception("unexpected error handling job %s", job.job_id)
                report_result(client, config, job.job_id, "error", str(exc))


if __name__ == "__main__":
    configure_logging(Path(__file__).resolve().parent.parent / "cache" / "agent.log")
    run_forever()
