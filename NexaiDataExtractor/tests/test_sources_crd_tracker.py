from __future__ import annotations

import httpx
import respx

from extractor.sources import crd_tracker

from .conftest import make_ctx

_LINES_BODY = {
    "currentIsoYear": 2026,
    "currentWorkWeek": 5,
    "rows": [
        {"lineId": 1, "componentId": 1, "no": 1, "gen": "8.00", "isTest": False},
        {"lineId": 1, "componentId": 2, "no": 1, "gen": "8.00", "isTest": False},
        {"lineId": 2, "componentId": 3, "no": 2, "gen": "9.00", "isTest": False},
        {"lineId": -1, "componentId": -1, "no": 1, "gen": "8.00", "isTest": True},
    ],
}


@respx.mock
def test_real_lines_filters_out_test_rows_and_keys_by_line_and_component(config, conn):
    respx.get("http://test-ai-bom.local/api/crd-tracker/lines").mock(
        return_value=httpx.Response(200, json=_LINES_BODY)
    )
    respx.get("http://test-ai-bom.local/api/crd-tracker/revision-codes").mock(
        return_value=httpx.Response(200, json={"source": "db", "codes": [{"code": "A", "seq": 1}]})
    )
    respx.get("http://test-ai-bom.local/api/crd-tracker/lines/1/history").mock(
        return_value=httpx.Response(200, json={"lineId": 1, "history": [{"weekLabel": "WW05", "isoYear": 2026, "workWeek": 5, "weekStartDate": "2026-01-26", "crdCode": "A"}]})
    )
    respx.get("http://test-ai-bom.local/api/crd-tracker/lines/2/history").mock(
        return_value=httpx.Response(200, json={"lineId": 2, "history": []})
    )

    results = crd_tracker.run(make_ctx(config, conn))
    by_source = {r.source: r for r in results}

    # 2 real lines x their component rows = 3 entities; the isTest=-1 row is excluded.
    assert by_source["crd_tracker_lines"].new_count == 3
    assert by_source["crd_tracker_revision_codes"].new_count == 1
    # /history was only called for the two REAL lineIds (1 and 2), never for -1.
    assert by_source["crd_tracker_line_history"].new_count == 1  # only line 1 had history rows

    lines_current = (config.data_dir / "crd_tracker_lines" / "CURRENT.md").read_text(encoding="utf-8")
    assert "Line 1" in lines_current and "Line 2" in lines_current


@respx.mock
def test_history_unavailable_when_lines_endpoint_missing(config, conn):
    respx.get("http://test-ai-bom.local/api/crd-tracker/lines").mock(
        return_value=httpx.Response(200, headers={"content-type": "text/html"}, text="<html></html>")
    )
    respx.get("http://test-ai-bom.local/api/crd-tracker/revision-codes").mock(
        return_value=httpx.Response(200, json={"source": "db", "codes": [{"code": "A", "seq": 1}]})
    )
    results = crd_tracker.run(make_ctx(config, conn))
    by_source = {r.source: r for r in results}
    assert by_source["crd_tracker_lines"].status == "unavailable"
    assert by_source["crd_tracker_line_history"].status == "unavailable"
