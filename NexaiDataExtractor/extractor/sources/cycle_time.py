"""L11 + L10 stage cycle-time history, from /api/cycle-time/l11 and /l10 — see
BackEnd/services/cycleTimeService.js for the upstream SQL these mirror. Row shape per
that service's final SELECT: usn, upn, stage, model_describe, trndate,
prev_stage_trndate, cycle_time. Keyed by (usn, stage, trndate) — the natural identity
of one stage-transition event.
"""
from __future__ import annotations

from datetime import date

from ..event_source import run_event_source
from ..types import RunContext, SourceResult

_COLUMNS = ["stage", "trndate", "prev_stage_trndate", "cycle_time", "model_describe"]


def _key(row: dict) -> str:
    return f"{row.get('usn')}|{row.get('stage')}|{row.get('trndate')}"


def _group(row: dict) -> str:
    return f"USN {row.get('usn')}"


def _make_run(source: str, title: str, endpoint: str):
    def fetch_page(client, frm: date, to: date) -> list[dict]:
        body, _url = client.get_json(endpoint, params={"from": frm.isoformat(), "to": to.isoformat()})
        return body.get("rows", [])

    def run(ctx: RunContext) -> SourceResult:
        return run_event_source(
            ctx,
            source=source,
            title=title,
            endpoint=endpoint,
            fetch_page=fetch_page,
            key_fn=_key,
            group_fn=_group,
            columns=_COLUMNS,
        )

    return run


run_l11 = _make_run("cycle_time_l11", "Cycle Time — L11", "/api/cycle-time/l11")
run_l10 = _make_run("cycle_time_l10", "Cycle Time — L10", "/api/cycle-time/l10")
