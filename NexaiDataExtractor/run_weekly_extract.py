#!/usr/bin/env python3
"""Entry point for the weekly NEXAi Data Compilation extractor.

    python run_weekly_extract.py                  # normal weekly run (skips if this
                                                    # ISO work week already ran)
    python run_weekly_extract.py --force           # re-run even if this week already ran
    python run_weekly_extract.py --dry-run         # fetch + diff, print counts, write nothing
    python run_weekly_extract.py --catch-up-fully  # first-ever bootstrap: loop past
                                                    # --max-chunks until every event
                                                    # source is caught up to today
                                                    # (recommended under tmux/nohup —
                                                    # see README.md)

Same code path for the first-ever run and every run after it: event sources resume
from wherever extractor/state.py's source_cursor left off (or HISTORY_EPOCH if never
run before); snapshot sources always diff the full current pull against last time.
See README.md for what each of the ~13 sources covers and NexaiDataExtractor's plan
doc for the design rationale.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from extractor import markdown, state
from extractor.api_client import ApiClient
from extractor.config import load_config
from extractor.sources import (
    crd_tracker,
    cycle_time,
    first_pass_yield,
    golden_template,
    models as models_source,
    npi_library,
    tpa_history,
    wts_library,
)
from extractor.types import RunContext, SourceResult

logger = logging.getLogger("extractor")

# (name, fn) — fn returns SourceResult or list[SourceResult]. Order is cheapest/most-
# likely-to-work first, so a --dry-run's printed summary reads top-to-bottom sensibly.
SOURCES = [
    ("models", models_source.run),
    ("wts_library", wts_library.run),
    ("npi_library", npi_library.run),
    ("crd_tracker", crd_tracker.run),
    ("golden_template_catalog", golden_template.run),
    ("fpy_summary", first_pass_yield.run_summary),
    ("fpy_blade_raw", first_pass_yield.run_blade_raw),
    ("cycle_time_l11", cycle_time.run_l11),
    ("cycle_time_l10", cycle_time.run_l10),
    ("tpa_history", tpa_history.run),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true", help="Run even if this ISO work week already completed.")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and diff, print a summary, write nothing.")
    parser.add_argument(
        "--catch-up-fully",
        action="store_true",
        help="Remove the --max-chunks cap on event sources; loop until every source is caught up to today.",
    )
    parser.add_argument(
        "--max-chunks",
        type=int,
        default=12,
        help="Per-invocation cap on how many chunk_days windows an event source advances (default: 12).",
    )
    return parser.parse_args()


def _iso_work_week(d: date) -> str:
    year, week, _ = d.isocalendar()
    return f"{year}-W{week:02d}"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = parse_args()
    config = load_config()

    today = date.today()
    iso_week = _iso_work_week(today)
    generated_at = datetime.now(timezone.utc).isoformat()

    db_path = config.data_dir / "_state" / "state.sqlite3"
    conn = state.connect_readonly_snapshot(db_path) if args.dry_run else state.connect(db_path)

    if not args.force and not args.dry_run and state.has_run_this_week(conn, iso_week):
        print(f"A completed run for {iso_week} already exists — nothing to do (use --force to redo).")
        conn.close()
        return 0

    run_id = f"{iso_week}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    if not args.dry_run:
        state.start_run(conn, run_id, iso_week)

    client = ApiClient(config.base_url)
    ctx = RunContext(
        client=client,
        conn=conn,
        config=config,
        run_id=run_id,
        iso_work_week=iso_week,
        generated_at=generated_at,
        today=today,
        out_root=config.data_dir,
        dry_run=args.dry_run,
        catch_up_fully=args.catch_up_fully,
        max_chunks=args.max_chunks,
    )

    results: dict[str, SourceResult] = {}
    print(f"=== NEXAi Data Compilation extractor — run {run_id} ===")
    print(f"API base: {config.base_url}")
    print(f"Output:   {config.data_dir}{'  (dry-run: nothing will be written)' if args.dry_run else ''}\n")

    for name, fn in SOURCES:
        try:
            outcome = fn(ctx)
        except Exception as exc:  # noqa: BLE001 - one bad source must not abort the run
            logger.exception("source %s crashed", name)
            outcome = SourceResult(name, "error", detail=str(exc))
        for res in outcome if isinstance(outcome, list) else [outcome]:
            results[res.source] = res
            flag = {"ok": "OK", "unavailable": "SKIP", "error": "ERROR"}.get(res.status, res.status.upper())
            detail = f" — {res.detail}" if res.detail else ""
            print(
                f"[{flag:>5}] {res.source:28s} new={res.new_count:<5} "
                f"changed={res.changed_count:<5} removed={res.removed_count:<5}{detail}"
            )

    client.close()

    if args.dry_run:
        # Nothing was written: event/snapshot drivers route dry-run through
        # state.is_seen()/preview_diff_snapshot() (read-only) rather than the
        # mark/diff functions that mutate state.sqlite3 — see extractor/event_source.py
        # and extractor/snapshot_source.py.
        conn.close()
        print("\nDry run complete — no files or state were written.")
        return 0

    markdown.write_index(config.data_dir, conn, run_id, generated_at)
    sources_json = json.dumps({r.source: r.status for r in results.values()})
    state.finish_run(conn, run_id, sources_json)
    conn.close()

    unavailable = [r.source for r in results.values() if r.status == "unavailable"]
    if unavailable:
        print(
            f"\n{len(unavailable)} source(s) unavailable on this backend build: {', '.join(unavailable)}. "
            "They will be picked up automatically once that endpoint is deployed — no action needed here."
        )
    print(f"\nDone. INDEX.md updated at {config.data_dir / 'INDEX.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
