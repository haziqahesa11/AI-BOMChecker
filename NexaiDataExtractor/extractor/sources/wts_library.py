"""WTS document library index — /api/wts/index, see BackEnd/services/wtsService.js.
Confirmed live 2026-08: {"items":[{"workItemId":182426,"project":"...", "model":...,
"title":..., "state":..., "keyword":..., "sequence":..., "revision":..., "changedDate":
..., "fileName":..., "fileType":...}, ...]}. Keyed by workItemId (one Azure DevOps work
item = one tracked CRD/SKU/FRU document). `downloadedAt` is deliberately left out of
the tracked entity content — it's when wts_fetch.py happened to run, not a property of
the document itself, so including it would make every item look "Changed" merely
because the fetcher ran again.
"""
from __future__ import annotations

from ..snapshot_source import run_snapshot_source
from ..types import RunContext, SourceResult

_COLUMNS = ["workItemId", "project", "model", "title", "state", "keyword", "sequence", "revision", "changedDate", "fileName", "fileType"]


def _key(row: dict) -> str:
    return str(row.get("workItemId"))


def _group(row: dict) -> str:
    return f"Project {row.get('project')}"


def run(ctx: RunContext) -> SourceResult:
    def fetch_all(client) -> list[dict]:
        body, _url = client.get_json("/api/wts/index")
        return [{k: v for k, v in item.items() if k != "downloadedAt"} for item in body.get("items", [])]

    return run_snapshot_source(
        ctx,
        source="wts_library",
        title="WTS Document Library",
        endpoint="/api/wts/index",
        fetch_all=fetch_all,
        key_fn=_key,
        columns=_COLUMNS,
        group_fn=_group,
    )
