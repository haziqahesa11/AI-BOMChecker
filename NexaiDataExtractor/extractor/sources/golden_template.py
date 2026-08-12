"""Golden Template CPN catalog — see BackEnd/services/goldenTemplateService.js.
Deliberately calls POST /api/golden-template/catalog/refresh rather than GET
/catalog: that route handler is `res.json(await goldenTemplateService.refreshCatalog())`
— synchronous, so the POST response body IS the freshly-recrawled catalog, with no
follow-up GET and no race against the server's own cache. Using plain GET /catalog
instead would silently serve whatever was last built (possibly long stale, if no one
has opened the Golden Template page recently).

Entity key is the bare CPN; modelRefs/variants (lists in the API response) are joined
into display strings since markdown table cells are one line each.
"""
from __future__ import annotations

from ..snapshot_source import run_snapshot_source
from ..types import RunContext, SourceResult

_COLUMNS = ["cpn", "variantCount", "modelRefs", "variants"]


def _key(row: dict) -> str:
    return str(row.get("cpn"))


def run(ctx: RunContext) -> SourceResult:
    def fetch_all(client) -> list[dict]:
        body, _url = client.post_json("/api/golden-template/catalog/refresh")
        # builtAt/failedModelCount are crawl-run metadata, not part of any one CPN's
        # identity — deliberately excluded from the per-entity dict below, since
        # anything included there feeds the content_hash used to decide "did this CPN
        # change this week", and a crawl timestamp changes on every single run.
        entries = body.get("entries", [])
        return [
            {
                "cpn": e.get("cpn"),
                "variantCount": e.get("variantCount"),
                "modelRefs": ", ".join(e.get("modelRefs", [])),
                "variants": ", ".join(e.get("variants", [])),
            }
            for e in entries
        ]

    return run_snapshot_source(
        ctx,
        source="golden_template_catalog",
        title="Golden Template — CPN Catalog",
        endpoint="POST /api/golden-template/catalog/refresh",
        fetch_all=fetch_all,
        key_fn=_key,
        columns=_COLUMNS,
    )
