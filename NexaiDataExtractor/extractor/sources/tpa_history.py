"""TPA (MonicaTPApprover.exe) approval audit log — /api/tpa-history, see
BackEnd/services/tpaHistoryService.js. That service itself proxies a separate small
HTTP API (TPA_HISTORY_URL) someone stood up in front of bom.dbo.ReviewList; its exact
column names aren't pinned down by reading server-side code (unlike Cycle Time, which
has an explicit SQL SELECT list), so rows are hashed whole for the dedup key and
rendered with dynamic columns rather than a guessed, possibly-wrong schema.
"""
from __future__ import annotations

from datetime import date

from ..event_source import run_event_source
from ..state import content_hash
from ..types import RunContext, SourceResult


def _key(row: dict) -> str:
    return content_hash(row)


def _group(row: dict) -> str:
    value = row.get("ModelRef") or row.get("modelRef") or row.get("PartNumber") or row.get("partNumber") or "unknown"
    return f"Model Reference / Part Number {value}"


def run(ctx: RunContext) -> SourceResult:
    def fetch_page(client, frm: date, to: date) -> list[dict]:
        body, _url = client.get_json("/api/tpa-history", params={"from": frm.isoformat(), "to": to.isoformat()})
        rows = body.get("rows", body) if isinstance(body, dict) else body
        return rows or []

    return run_event_source(
        ctx,
        source="tpa_history",
        title="TPA Approval History",
        endpoint="/api/tpa-history",
        fetch_page=fetch_page,
        key_fn=_key,
        group_fn=_group,
        columns=None,  # schema owned by an external API, not this repo — render dynamically
    )
