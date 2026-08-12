"""Generic driver for 'snapshot' sources: current-state data (models list, CRD tracker
lines, the Golden Template catalog, WTS/NPI library indexes) where the API always
returns the full current picture rather than a time-windowed slice. Each run diffs the
fresh pull against what was last recorded, keyed by a natural entity id, and produces:

  - a dated `..._patch_<week>.md` with Added/Changed/Removed sections (skipped entirely
    if nothing changed since last run — no empty patch files),
  - an evergreen `CURRENT.md`, fully overwritten every run — the doc a RAG query about
    "what's the state right now" should be pointed at.

extractor/sources/*.py snapshot sources just supply fetch_all/key_fn/columns — see
extractor/sources/models.py for the smallest example.
"""
from __future__ import annotations

from typing import Callable

from . import markdown, state
from .api_client import EndpointUnavailableError
from .types import RunContext, SourceResult


def run_snapshot_source(
    ctx: RunContext,
    *,
    source: str,
    title: str,
    endpoint: str,
    fetch_all: Callable[..., list[dict]],
    key_fn: Callable[[dict], str],
    columns: list[str] | None,
    group_fn: Callable[[dict], str] | None = None,
    query: dict | None = None,
) -> SourceResult:
    try:
        rows = fetch_all(ctx.client)
    except EndpointUnavailableError as exc:
        return SourceResult(source, "unavailable", detail=str(exc))

    keyed = {key_fn(r): r for r in rows}

    if ctx.dry_run:
        added, changed, removed = state.preview_diff_snapshot(ctx.conn, source, keyed)
        return SourceResult(source, "ok", new_count=len(added), changed_count=len(changed), removed_count=len(removed))

    added, changed, removed = state.diff_snapshot(ctx.conn, source, keyed, ctx.run_id)

    out_dir = ctx.out_root / source
    index_entries = []
    files_written = []

    diff_result = markdown.write_snapshot_diff(
        out_dir,
        source=source,
        title=title,
        iso_week=ctx.iso_work_week,
        run_id=ctx.run_id,
        generated_at=ctx.generated_at,
        upstream_endpoint=endpoint,
        query=query,
        added=added,
        changed=changed,
        removed=removed,
        columns=columns,
    )
    if diff_result:
        path, count = diff_result
        index_entries.append((str(path), source, "snapshot_diff", ctx.iso_work_week, ctx.generated_at, count))
        files_written.append(path)

    current_results = markdown.write_current(
        out_dir,
        source=source,
        title=title,
        run_id=ctx.run_id,
        generated_at=ctx.generated_at,
        upstream_endpoint=endpoint,
        rows=list(keyed.values()),
        columns=columns,
        group_fn=group_fn,
        max_per_file=ctx.config.max_entities_per_file,
    )
    for path, count in current_results:
        index_entries.append((str(path), source, "snapshot_current", None, ctx.generated_at, count))
        files_written.append(path)

    state.record_index_entries(ctx.conn, index_entries)

    return SourceResult(
        source,
        "ok",
        new_count=len(added),
        changed_count=len(changed),
        removed_count=len(removed),
        files_written=files_written,
    )
