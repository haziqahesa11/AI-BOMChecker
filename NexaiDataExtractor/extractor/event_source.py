"""Generic driver for 'event' sources: immutable, append-only history where a record's
identity is a composite key (e.g. usn|stage|trndate). Every extractor/sources/*.py
event source is just this loop parameterized with a fetch_page/key_fn/group_fn/columns
— see cycle_time.py for the smallest example.

Backfill and steady-state weekly patching are the SAME loop: it starts from wherever
`source_cursor` left off (or config.history_epoch if this source has never run before)
and advances in `config.chunk_days`-sized windows, deduping every row against
`seen_records` before deciding whether it's new. A brand-new source therefore just
produces one very large first patch (or several, split by --max-chunks across cron
ticks) instead of needing separate "backfill mode" code.

Cycle Time and FPY-blade always return a matched usn/unit's FULL history regardless of
the requested date window (that's how the underlying app's own SQL works — see
BackEnd/services/cycleTimeService.js's comment on findUsnsInRange), so the same row
reappears in every window an active unit touches. Because dedup happens here, at
write-time, on the row's own key — never on "is this the first window we've queried"
— that duplication is absorbed for free and never reaches a markdown file twice.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Callable

from . import markdown, state
from .api_client import EndpointUnavailableError
from .types import RunContext, SourceResult

logger = logging.getLogger("extractor.event_source")

# Deliberate re-query overlap on every advance: cheap insurance against an
# off-by-one/timezone gap between NEXAi's clock and the source DB's stored trndate.
# Idempotent by construction (dedup is key-based), so overlap costs nothing but a
# few redundant re-checks.
OVERLAP_DAYS = 2


def run_event_source(
    ctx: RunContext,
    *,
    source: str,
    title: str,
    endpoint: str,
    fetch_page: Callable[..., list[dict]],
    key_fn: Callable[[dict], str],
    group_fn: Callable[[dict], str],
    columns: list[str] | None,
) -> SourceResult:
    cursor = state.get_cursor(ctx.conn, source)
    start = (cursor - timedelta(days=OVERLAP_DAYS)) if cursor else ctx.config.history_epoch
    start = min(start, ctx.today)

    frm: date = start
    span_start = frm
    to = frm
    new_rows: list[dict] = []
    total_seen = 0
    chunks_done = 0

    try:
        while frm <= ctx.today:
            to = min(frm + timedelta(days=ctx.config.chunk_days - 1), ctx.today)
            rows = fetch_page(ctx.client, frm, to)
            for row in rows:
                total_seen += 1
                key = key_fn(row)
                chash = state.content_hash(row)
                if ctx.dry_run:
                    is_new = not state.is_seen(ctx.conn, source, key)
                else:
                    is_new = state.mark_seen_if_new(ctx.conn, source, key, chash, ctx.run_id)
                if is_new:
                    new_rows.append(row)

            if not ctx.dry_run:
                state.set_cursor(ctx.conn, source, to)

            chunks_done += 1
            reached_today = to >= ctx.today
            frm = to + timedelta(days=1)
            if reached_today:
                break
            if not ctx.catch_up_fully and chunks_done >= ctx.max_chunks:
                logger.info(
                    "source=%s hit --max-chunks=%d before catching up to today; "
                    "resuming from %s next run",
                    source,
                    ctx.max_chunks,
                    to.isoformat(),
                )
                break
    except EndpointUnavailableError as exc:
        return SourceResult(source, "unavailable", detail=str(exc))

    files_written = []
    if not ctx.dry_run and new_rows:
        grouped = markdown.group_rows(new_rows, group_fn)
        out_dir = ctx.out_root / source
        results = markdown.write_event_patch(
            out_dir,
            source=source,
            title=title,
            iso_week=ctx.iso_work_week,
            run_id=ctx.run_id,
            generated_at=ctx.generated_at,
            upstream_endpoint=endpoint,
            query={"from": span_start.isoformat(), "to": to.isoformat()},
            total_seen_this_run=total_seen,
            grouped_rows=grouped,
            columns=columns,
            max_per_file=ctx.config.max_entities_per_file,
        )
        state.record_index_entries(
            ctx.conn,
            [
                (str(path), source, "event_delta", ctx.iso_work_week, ctx.generated_at, count)
                for path, count in results
            ],
        )
        files_written = [path for path, _ in results]

    return SourceResult(source, "ok", new_count=len(new_rows), files_written=files_written)


def run_event_source_oneshot(
    ctx: RunContext,
    *,
    source: str,
    title: str,
    endpoint: str,
    fetch_all: Callable[..., list[dict]],
    key_fn: Callable[[dict], str],
    group_fn: Callable[[dict], str],
    columns: list[str] | None,
    query: dict | None = None,
) -> SourceResult:
    """Same append-only dedup as run_event_source, for event-shaped sources whose API
    has no date-range filtering at all (e.g. /api/crd-tracker/lines/:lineId/history
    always returns a line's FULL history) — one fetch per run, no cursor/chunking,
    since chunking by date would just mean re-fetching the identical full response
    over and over for no benefit."""
    try:
        rows = fetch_all(ctx.client)
    except EndpointUnavailableError as exc:
        return SourceResult(source, "unavailable", detail=str(exc))

    new_rows = []
    for row in rows:
        key = key_fn(row)
        chash = state.content_hash(row)
        if ctx.dry_run:
            is_new = not state.is_seen(ctx.conn, source, key)
        else:
            is_new = state.mark_seen_if_new(ctx.conn, source, key, chash, ctx.run_id)
        if is_new:
            new_rows.append(row)

    files_written = []
    if not ctx.dry_run and new_rows:
        grouped = markdown.group_rows(new_rows, group_fn)
        out_dir = ctx.out_root / source
        results = markdown.write_event_patch(
            out_dir,
            source=source,
            title=title,
            iso_week=ctx.iso_work_week,
            run_id=ctx.run_id,
            generated_at=ctx.generated_at,
            upstream_endpoint=endpoint,
            query=query or {},
            total_seen_this_run=len(rows),
            grouped_rows=grouped,
            columns=columns,
            max_per_file=ctx.config.max_entities_per_file,
        )
        state.record_index_entries(
            ctx.conn,
            [
                (str(path), source, "event_delta", ctx.iso_work_week, ctx.generated_at, count)
                for path, count in results
            ],
        )
        files_written = [path for path, _ in results]

    return SourceResult(source, "ok", new_count=len(new_rows), files_written=files_written)
