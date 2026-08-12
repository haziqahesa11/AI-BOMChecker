from __future__ import annotations

from datetime import date

from extractor import state
from extractor.api_client import EndpointUnavailableError
from extractor.event_source import run_event_source, run_event_source_oneshot

from .conftest import make_ctx


def _fake_backend(rows_by_window):
    """rows_by_window: list of (frm, to, rows) — returns rows for any window whose
    [frm, to] fully covers a stored window's frm (good enough for these tests, which
    use chunk_days >= the whole fixture span so there's exactly one call)."""

    def fetch_page(client, frm: date, to: date):
        out = []
        for w_frm, w_to, rows in rows_by_window:
            if frm <= w_frm <= to:
                out.extend(rows)
        return out

    return fetch_page


def test_first_run_backfills_everything_and_advances_cursor(config, conn):
    ctx = make_ctx(config, conn, today=date(2026, 2, 1))
    rows = [{"usn": "U1", "stage": "WA", "trndate": "2026-01-05"}, {"usn": "U1", "stage": "AI", "trndate": "2026-01-06"}]
    fetch_page = _fake_backend([(date(2026, 1, 1), date(2026, 1, 1), rows)])

    result = run_event_source(
        ctx, source="cycle_time_l11", title="Cycle Time — L11", endpoint="/api/cycle-time/l11",
        fetch_page=fetch_page, key_fn=lambda r: f"{r['usn']}|{r['stage']}|{r['trndate']}",
        group_fn=lambda r: r["usn"], columns=["stage", "trndate"],
    )
    assert result.status == "ok"
    assert result.new_count == 2
    assert len(result.files_written) == 1
    assert state.get_cursor(conn, "cycle_time_l11") == date(2026, 2, 1)


def test_second_run_same_day_is_idempotent(config, conn):
    rows = [{"usn": "U1", "stage": "WA", "trndate": "2026-01-05"}]
    fetch_page = _fake_backend([(date(2026, 1, 1), date(2026, 1, 1), rows)])
    kwargs = dict(
        source="cycle_time_l11", title="Cycle Time — L11", endpoint="/api/cycle-time/l11",
        fetch_page=fetch_page, key_fn=lambda r: f"{r['usn']}|{r['stage']}|{r['trndate']}",
        group_fn=lambda r: r["usn"], columns=["stage", "trndate"],
    )
    ctx1 = make_ctx(config, conn, today=date(2026, 2, 1), run_id="run1")
    run_event_source(ctx1, **kwargs)

    ctx2 = make_ctx(config, conn, today=date(2026, 2, 1), run_id="run2")
    result2 = run_event_source(ctx2, **kwargs)
    assert result2.new_count == 0
    assert result2.files_written == []


def test_dry_run_writes_nothing_and_does_not_move_cursor(config, conn):
    rows = [{"usn": "U1", "stage": "WA", "trndate": "2026-01-05"}]
    fetch_page = _fake_backend([(date(2026, 1, 1), date(2026, 1, 1), rows)])
    ctx = make_ctx(config, conn, today=date(2026, 2, 1), dry_run=True)
    result = run_event_source(
        ctx, source="cycle_time_l11", title="Cycle Time — L11", endpoint="/api/cycle-time/l11",
        fetch_page=fetch_page, key_fn=lambda r: f"{r['usn']}|{r['stage']}|{r['trndate']}",
        group_fn=lambda r: r["usn"], columns=["stage", "trndate"],
    )
    assert result.new_count == 1
    assert result.files_written == []
    assert state.get_cursor(conn, "cycle_time_l11") is None
    assert not (config.data_dir / "cycle_time_l11").exists()


def test_unavailable_endpoint_is_reported_not_raised(config, conn):
    def fetch_page(client, frm, to):
        raise EndpointUnavailableError("GET /api/cycle-time/l11 returned HTML")

    ctx = make_ctx(config, conn, today=date(2026, 2, 1))
    result = run_event_source(
        ctx, source="cycle_time_l11", title="Cycle Time — L11", endpoint="/api/cycle-time/l11",
        fetch_page=fetch_page, key_fn=lambda r: "x", group_fn=lambda r: "x", columns=None,
    )
    assert result.status == "unavailable"
    assert "HTML" in result.detail


def test_max_chunks_caps_progress_and_resumes_next_run(config, conn):
    # 3 weekly chunks needed (chunk_days=7 from the config fixture) to reach today;
    # max_chunks=1 should stop after the first chunk, leaving the rest for next time.
    ctx = make_ctx(config, conn, today=date(2026, 1, 22), max_chunks=1)
    calls = []

    def fetch_page(client, frm, to):
        calls.append((frm, to))
        return []

    run_event_source(
        ctx, source="src", title="t", endpoint="/e", fetch_page=fetch_page,
        key_fn=lambda r: "x", group_fn=lambda r: "x", columns=None,
    )
    assert len(calls) == 1
    assert state.get_cursor(conn, "src") < date(2026, 1, 22)


def test_oneshot_dedupes_across_runs_without_a_cursor(config, conn):
    calls = {"n": 0}

    def fetch_all(client):
        calls["n"] += 1
        return [{"lineId": 1, "isoYear": 2026, "workWeek": 5, "weekLabel": "WW05"}]

    kwargs = dict(
        source="crd_tracker_line_history", title="t", endpoint="/e", fetch_all=fetch_all,
        key_fn=lambda r: f"{r['lineId']}|{r['isoYear']}|{r['workWeek']}",
        group_fn=lambda r: str(r["lineId"]), columns=["weekLabel"],
    )
    ctx1 = make_ctx(config, conn, run_id="run1")
    r1 = run_event_source_oneshot(ctx1, **kwargs)
    assert r1.new_count == 1

    ctx2 = make_ctx(config, conn, run_id="run2")
    r2 = run_event_source_oneshot(ctx2, **kwargs)
    assert r2.new_count == 0
    assert calls["n"] == 2  # oneshot always re-fetches (no cursor) — dedup happens on write
