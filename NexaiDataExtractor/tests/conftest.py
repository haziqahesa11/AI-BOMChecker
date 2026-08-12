from __future__ import annotations

import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from extractor import state
from extractor.api_client import ApiClient
from extractor.config import ExtractorConfig
from extractor.types import RunContext


@pytest.fixture
def config(tmp_path) -> ExtractorConfig:
    return ExtractorConfig(
        base_url="http://test-ai-bom.local",
        data_dir=tmp_path / "Data_Compilation",
        history_epoch=date(2026, 1, 1),
        max_entities_per_file=5,
        chunk_days=7,
    )


@pytest.fixture
def conn(config):
    c = state.connect(config.data_dir / "_state" / "state.sqlite3")
    yield c
    c.close()


def make_ctx(config, conn, *, today=date(2026, 2, 1), run_id="2026-W05-test", dry_run=False, catch_up_fully=False, max_chunks=12) -> RunContext:
    return RunContext(
        client=ApiClient(config.base_url),
        conn=conn,
        config=config,
        run_id=run_id,
        iso_work_week="2026-W05",
        generated_at=datetime(2026, 2, 1, tzinfo=timezone.utc).isoformat(),
        today=today,
        out_root=config.data_dir,
        dry_run=dry_run,
        catch_up_fully=catch_up_fully,
        max_chunks=max_chunks,
    )


@pytest.fixture
def ctx_factory(config, conn):
    def _make(**kwargs):
        return make_ctx(config, conn, **kwargs)

    return _make
