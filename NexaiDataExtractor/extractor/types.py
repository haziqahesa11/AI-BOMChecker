"""Shared dataclasses passed between run_weekly_extract.py, the generic event/snapshot
drivers, and every extractor/sources/*.py module. Kept in their own module (not
sources/models.py) to avoid a name clash with the /api/models source."""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from .api_client import ApiClient
from .config import ExtractorConfig


@dataclass
class RunContext:
    client: ApiClient
    conn: sqlite3.Connection
    config: ExtractorConfig
    run_id: str
    iso_work_week: str
    generated_at: str
    today: date
    out_root: Path
    dry_run: bool = False
    catch_up_fully: bool = False
    max_chunks: int = 12


@dataclass
class SourceResult:
    source: str
    status: str  # "ok" | "unavailable" | "error"
    new_count: int = 0
    changed_count: int = 0
    removed_count: int = 0
    files_written: list[Path] = field(default_factory=list)
    detail: str | None = None
