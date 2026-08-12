"""SQLite-backed ledger that makes 'fetch since the beginning, then patch every work
week' a single code path instead of two: event sources record which composite keys
have ever been seen (seen_records); snapshot/current-state sources record the last
known content per entity (snapshots) and diff against it every run. A bootstrap run
against an empty DB naturally produces "everything is new" — the same logic a normal
weekly run uses to produce a handful of new rows.

One SQLite file lives at <DATA_COMPILATION_DIR>/_state/state.sqlite3 — deliberately
inside the output tree so it travels with the library, but excluded from the content a
RAG ingester should read (see INDEX.md's own header note, written in markdown.py).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    iso_work_week TEXT NOT NULL,
    sources_json TEXT
);
CREATE TABLE IF NOT EXISTS seen_records (
    source TEXT NOT NULL,
    record_key TEXT NOT NULL,
    content_hash TEXT,
    first_seen_run TEXT,
    PRIMARY KEY (source, record_key)
);
CREATE TABLE IF NOT EXISTS snapshots (
    source TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content_json TEXT NOT NULL,
    last_seen_run TEXT,
    PRIMARY KEY (source, entity_key)
);
CREATE TABLE IF NOT EXISTS source_cursor (
    source TEXT PRIMARY KEY,
    covered_to TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS index_entries (
    file_path TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    iso_work_week TEXT,
    generated_at TEXT NOT NULL,
    record_count INTEGER NOT NULL
);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    """isolation_level=None puts sqlite3 in autocommit mode: every INSERT/UPDATE/
    DELETE below commits the instant it runs, with no batched transaction to lose.
    This is deliberate, not an oversight — it's what makes the chunked event-source
    catch-up loop (extractor/event_source.py) safely resumable: if the whole process
    dies mid-backfill (crash, OOM, cron timeout), every chunk already processed before
    that point stays durably recorded, and the next run picks up exactly where the
    cursor was left, instead of losing an entire in-flight transaction."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(_SCHEMA)
    return conn


def connect_readonly_snapshot(db_path: Path) -> sqlite3.Connection:
    """For --dry-run: an in-memory connection seeded from the real state.sqlite3 (via
    sqlite3's backup API) if it exists, so dry-run diffs/dedup checks are computed
    against real history — a meaningful preview, not "everything looks new" — while
    guaranteeing zero bytes are written to disk. Doesn't even create DATA_COMPILATION_DIR
    if it doesn't already exist, unlike connect() above."""
    mem = sqlite3.connect(":memory:", isolation_level=None)
    if db_path.exists():
        src = sqlite3.connect(db_path)
        try:
            src.backup(mem)
        finally:
            src.close()
    else:
        mem.executescript(_SCHEMA)
    return mem


def content_hash(obj: Any) -> str:
    return hashlib.sha1(json.dumps(obj, sort_keys=True, default=str).encode("utf-8")).hexdigest()


# ── event sources (append-only) ─────────────────────────────────────────────

def is_seen(conn: sqlite3.Connection, source: str, key: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM seen_records WHERE source=? AND record_key=?", (source, key)
    ).fetchone()
    return row is not None


def mark_seen_if_new(conn: sqlite3.Connection, source: str, key: str, chash: str, run_id: str) -> bool:
    """Returns True the first time this key is seen. If the key is already known but
    its content_hash changed, that's logged (not raised) — event rows are treated as
    immutable by design (e.g. a manufacturing transaction timestamp never gets
    corrected after the fact), so a mismatch here is a signal worth a human look, not
    a reason to re-emit the row as if it were new."""
    row = conn.execute(
        "SELECT content_hash FROM seen_records WHERE source=? AND record_key=?", (source, key)
    ).fetchone()
    if row is None:
        conn.execute(
            "INSERT INTO seen_records(source, record_key, content_hash, first_seen_run) VALUES (?,?,?,?)",
            (source, key, chash, run_id),
        )
        return True
    if row[0] != chash:
        import logging

        logging.getLogger("extractor.state").warning(
            "source=%s key=%s content changed since first seen — event rows are assumed "
            "immutable; this key will NOT be re-emitted as a patch",
            source,
            key,
        )
    return False


def get_cursor(conn: sqlite3.Connection, source: str) -> date | None:
    row = conn.execute("SELECT covered_to FROM source_cursor WHERE source=?", (source,)).fetchone()
    return date.fromisoformat(row[0]) if row else None


def set_cursor(conn: sqlite3.Connection, source: str, covered_to: date) -> None:
    conn.execute(
        "INSERT INTO source_cursor(source, covered_to) VALUES (?,?) "
        "ON CONFLICT(source) DO UPDATE SET covered_to=excluded.covered_to",
        (source, covered_to.isoformat()),
    )


# ── snapshot sources (current-state diff) ───────────────────────────────────

def diff_snapshot(
    conn: sqlite3.Connection, source: str, current: dict[str, dict], run_id: str
) -> tuple[list[dict], list[tuple[dict, dict]], list[dict]]:
    """Diffs `current` (entity_key -> row) against the stored snapshot for `source`,
    updates the table to match, and returns (added, changed[(old,new)], removed)."""
    existing = {
        row[0]: (row[1], row[2])
        for row in conn.execute(
            "SELECT entity_key, content_hash, content_json FROM snapshots WHERE source=?", (source,)
        )
    }
    added: list[dict] = []
    changed: list[tuple[dict, dict]] = []
    seen_keys: set[str] = set()

    for key, obj in current.items():
        seen_keys.add(key)
        chash = content_hash(obj)
        if key not in existing:
            added.append(obj)
            conn.execute(
                "INSERT INTO snapshots(source, entity_key, content_hash, content_json, last_seen_run) "
                "VALUES (?,?,?,?,?)",
                (source, key, chash, json.dumps(obj, default=str), run_id),
            )
        elif existing[key][0] != chash:
            old_obj = json.loads(existing[key][1])
            changed.append((old_obj, obj))
            conn.execute(
                "UPDATE snapshots SET content_hash=?, content_json=?, last_seen_run=? "
                "WHERE source=? AND entity_key=?",
                (chash, json.dumps(obj, default=str), run_id, source, key),
            )
        else:
            conn.execute(
                "UPDATE snapshots SET last_seen_run=? WHERE source=? AND entity_key=?",
                (run_id, source, key),
            )

    removed = []
    for key, (_, content_json) in existing.items():
        if key not in seen_keys:
            removed.append(json.loads(content_json))
            conn.execute("DELETE FROM snapshots WHERE source=? AND entity_key=?", (source, key))

    return added, changed, removed


def preview_diff_snapshot(
    conn: sqlite3.Connection, source: str, current: dict[str, dict]
) -> tuple[list[dict], list[tuple[dict, dict]], list[dict]]:
    """Read-only version of diff_snapshot for --dry-run: same Added/Changed/Removed
    counts, no writes. 'Changed' entries carry an empty dict for the old value since
    a preview has no reason to pull it back out of storage."""
    existing = {
        row[0]: row[1]
        for row in conn.execute(
            "SELECT entity_key, content_hash FROM snapshots WHERE source=?", (source,)
        )
    }
    added, changed = [], []
    for key, obj in current.items():
        chash = content_hash(obj)
        if key not in existing:
            added.append(obj)
        elif existing[key] != chash:
            changed.append(({}, obj))
    removed = [{"entity_key": k} for k in set(existing) - set(current)]
    return added, changed, removed


# ── index / run ledger ───────────────────────────────────────────────────────

def record_index_entries(
    conn: sqlite3.Connection,
    entries: list[tuple[str, str, str, str | None, str, int]],
) -> None:
    """entries: (file_path, source, kind, iso_work_week, generated_at, record_count)"""
    conn.executemany(
        "INSERT OR REPLACE INTO index_entries "
        "(file_path, source, kind, iso_work_week, generated_at, record_count) VALUES (?,?,?,?,?,?)",
        entries,
    )


def iter_index_entries(conn: sqlite3.Connection):
    return conn.execute(
        "SELECT file_path, source, kind, iso_work_week, generated_at, record_count "
        "FROM index_entries ORDER BY generated_at DESC"
    ).fetchall()


def has_run_this_week(conn: sqlite3.Connection, iso_work_week: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM runs WHERE iso_work_week=? AND finished_at IS NOT NULL", (iso_work_week,)
    ).fetchone()
    return row is not None


def start_run(conn: sqlite3.Connection, run_id: str, iso_work_week: str) -> None:
    conn.execute(
        "INSERT INTO runs(run_id, started_at, iso_work_week) VALUES (?,?,?)",
        (run_id, datetime.now(timezone.utc).isoformat(), iso_work_week),
    )


def finish_run(conn: sqlite3.Connection, run_id: str, sources_json: str) -> None:
    conn.execute(
        "UPDATE runs SET finished_at=?, sources_json=? WHERE run_id=?",
        (datetime.now(timezone.utc).isoformat(), sources_json, run_id),
    )
