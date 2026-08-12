"""NPI Library index — /api/npi/index, see BackEnd/scripts/build-npi-index.js and
BackEnd/services/npiLibraryService.js. Confirmed live 2026-08:
{"items":[{"itemNumber":"M1246491-001","revision":...}, ...], "crossTables":[...]}.

Two genuinely different entity shapes share this one endpoint (SKU BOM masters vs.
Gen cross-reference tables), so they're tracked as two separate sources —
`npi_library_skus` (keyed by itemNumber|revision) and `npi_library_cross_tables`
(keyed by gen|fileName) — rather than forcing one column schema onto both. Only
top-level scalar fields are kept: `partProperties` (the full Name/Value dump of the
source spreadsheet's "Part Properties" sheet) and the `orders`/`ancillaryFiles` lists
are intentionally left out of the tracked/hashed content to keep the weekly diff
focused on the fields a person would actually ask about, and to keep the SQLite
snapshot table from ballooning with a near-duplicate of the whole spreadsheet per SKU.
"""
from __future__ import annotations

from ..snapshot_source import run_snapshot_source
from ..types import RunContext, SourceResult

_SKU_COLUMNS = ["itemNumber", "gen", "revision", "partDescription", "buildPhase", "partMaturityLevel", "fileName", "modifiedAt"]
_SKU_FIELDS = {"itemNumber", *_SKU_COLUMNS}

_CROSS_TABLE_COLUMNS = ["gen", "fileName", "sheetNames", "modifiedAt"]


def _sku_key(row: dict) -> str:
    return f"{row.get('itemNumber')}|{row.get('revision')}"


def _sku_group(row: dict) -> str:
    return f"Gen {row.get('gen')}"


def _cross_table_key(row: dict) -> str:
    return f"{row.get('gen')}|{row.get('fileName')}"


def _cross_table_group(row: dict) -> str:
    return f"Gen {row.get('gen')}"


def run(ctx: RunContext) -> list[SourceResult]:
    def fetch_skus(client) -> list[dict]:
        body, _url = client.get_json("/api/npi/index")
        return [{k: v for k, v in item.items() if k in _SKU_FIELDS} for item in body.get("items", [])]

    def fetch_cross_tables(client) -> list[dict]:
        body, _url = client.get_json("/api/npi/index")
        rows = []
        for ct in body.get("crossTables", []):
            rows.append(
                {
                    "gen": ct.get("gen"),
                    "fileName": ct.get("fileName"),
                    "sheetNames": ", ".join(ct.get("sheetNames", [])),
                    "modifiedAt": ct.get("modifiedAt"),
                }
            )
        return rows

    sku_result = run_snapshot_source(
        ctx,
        source="npi_library_skus",
        title="NPI Library — SKU BOM Masters",
        endpoint="/api/npi/index",
        fetch_all=fetch_skus,
        key_fn=_sku_key,
        columns=_SKU_COLUMNS,
        group_fn=_sku_group,
    )
    cross_table_result = run_snapshot_source(
        ctx,
        source="npi_library_cross_tables",
        title="NPI Library — Gen Cross-Reference Tables",
        endpoint="/api/npi/index",
        fetch_all=fetch_cross_tables,
        key_fn=_cross_table_key,
        columns=_CROSS_TABLE_COLUMNS,
        group_fn=_cross_table_group,
    )
    return [sku_result, cross_table_result]
