"""Full Model Reference list — /api/models, see BackEnd/services/qvlService.js's
fetchAllModels (EXEC BOM.dbo.SP_LocationTable_Model_Distinct). Confirmed live 2026-08:
{"models":[{"modelRef":"ASEPro2_L10","location":"L10"}, ...]}, modelRef unique."""
from __future__ import annotations

from ..snapshot_source import run_snapshot_source
from ..types import RunContext, SourceResult

_COLUMNS = ["modelRef", "location"]


def _key(row: dict) -> str:
    return str(row.get("modelRef"))


def run(ctx: RunContext) -> SourceResult:
    def fetch_all(client) -> list[dict]:
        body, _url = client.get_json("/api/models")
        return body.get("models", [])

    return run_snapshot_source(
        ctx,
        source="models",
        title="Model Reference List",
        endpoint="/api/models",
        fetch_all=fetch_all,
        key_fn=_key,
        columns=_COLUMNS,
    )
