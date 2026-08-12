"""CRD Tracker covers three related endpoints (see BackEnd/server.js's CRD Tracker
routes and BackEnd/DB.js's annonPool):

- `lines` (snapshot) — /api/crd-tracker/lines, one row per line+L10 component ("latest
  week only"). Confirmed live 2026-08: a single line can carry multiple component rows
  sharing one `lineId` (distinguished by `componentId`), so the entity key must be
  `lineId|componentId`, not `lineId` alone. Rows with `isTest: true` are the app's own
  in-memory, never-persisted "Test" rows (see server.js's crdTestLines Map) and are
  filtered out here — they aren't real tracked data and would otherwise show up as
  permanently "Added" every time someone plays with the New SKU > Test flow.
- `revision_codes` (snapshot) — /api/crd-tracker/revision-codes, a small, rarely-
  changing reference vocabulary (A, B, C, ... AA, AB, ...).
- `line_history` (event) — /api/crd-tracker/lines/:lineId/history, one call per real
  lineId found in `lines` above (both steps share the one `_real_lines` filter so they
  can never drift apart). Confirmed live shape: {weekLabel, isoYear, workWeek,
  weekStartDate, crdCode}, keyed by (lineId, isoYear, workWeek).
"""
from __future__ import annotations

from ..event_source import run_event_source_oneshot
from ..snapshot_source import run_snapshot_source
from ..types import RunContext, SourceResult

_LINE_COLUMNS = [
    "lineId", "componentId", "no", "gen", "l11Msf", "l11Sku", "crdNumber", "l10Msf", "l10Sku",
    "wtsTicket", "currentCrdTe", "dateUpdate", "latestWeekLabel", "latestCrdCode",
]
_REVISION_COLUMNS = ["code", "seq"]
_HISTORY_COLUMNS = ["isoYear", "workWeek", "weekLabel", "weekStartDate", "crdCode"]


def _real_lines(rows: list[dict]) -> list[dict]:
    return [r for r in rows if not r.get("isTest") and (r.get("lineId") or 0) > 0]


def _line_key(row: dict) -> str:
    return f"{row.get('lineId')}|{row.get('componentId')}"


def _line_group(row: dict) -> str:
    return f"Line {row.get('no')}"


def _revision_key(row: dict) -> str:
    return str(row.get("code"))


def _history_key(row: dict) -> str:
    return f"{row.get('_lineId')}|{row.get('isoYear')}|{row.get('workWeek')}"


def _history_group(row: dict) -> str:
    return f"Line {row.get('_lineId')}"


def run(ctx: RunContext) -> list[SourceResult]:
    results: list[SourceResult] = []
    # Populated as a side effect of fetch_lines() below, so line_history can reuse the
    # exact same pull instead of issuing a second, redundant GET /api/crd-tracker/lines.
    fetched_lines: list[dict] = []

    def fetch_lines(client) -> list[dict]:
        body, _url = client.get_json("/api/crd-tracker/lines")
        real = _real_lines(body.get("rows", []))
        fetched_lines[:] = real
        return real

    lines_result = run_snapshot_source(
        ctx,
        source="crd_tracker_lines",
        title="CRD Tracker — Lines",
        endpoint="/api/crd-tracker/lines",
        fetch_all=fetch_lines,
        key_fn=_line_key,
        columns=_LINE_COLUMNS,
        group_fn=_line_group,
    )
    results.append(lines_result)

    def fetch_revision_codes(client) -> list[dict]:
        body, _url = client.get_json("/api/crd-tracker/revision-codes")
        return body.get("codes", [])

    results.append(
        run_snapshot_source(
            ctx,
            source="crd_tracker_revision_codes",
            title="CRD Tracker — Revision Code Vocabulary",
            endpoint="/api/crd-tracker/revision-codes",
            fetch_all=fetch_revision_codes,
            key_fn=_revision_key,
            columns=_REVISION_COLUMNS,
        )
    )

    # line_history needs to know which real lineIds exist. If the lines fetch itself
    # was unavailable (route missing on the deployed build), history can't run either —
    # report it the same way rather than crashing or silently fetching nothing.
    if lines_result.status == "unavailable":
        results.append(SourceResult("crd_tracker_line_history", "unavailable", detail=lines_result.detail))
        return results

    line_ids = sorted({r["lineId"] for r in fetched_lines})

    def fetch_all(client) -> list[dict]:
        rows: list[dict] = []
        for line_id in line_ids:
            hist_body, _url = client.get_json(f"/api/crd-tracker/lines/{line_id}/history")
            for h in hist_body.get("history", []):
                rows.append({"_lineId": line_id, **h})
        return rows

    results.append(
        run_event_source_oneshot(
            ctx,
            source="crd_tracker_line_history",
            title="CRD Tracker — Per-Line Weekly History",
            endpoint="/api/crd-tracker/lines/:lineId/history",
            fetch_all=fetch_all,
            key_fn=_history_key,
            group_fn=_history_group,
            columns=_HISTORY_COLUMNS,
        )
    )
    return results
