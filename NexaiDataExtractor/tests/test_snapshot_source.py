from __future__ import annotations

from extractor.api_client import EndpointUnavailableError
from extractor.snapshot_source import run_snapshot_source

from .conftest import make_ctx


def test_snapshot_added_then_changed_then_removed(config, conn):
    state_rows = {"box": [{"modelRef": "M1", "location": "L10"}, {"modelRef": "M2", "location": "L10"}]}

    def fetch_all(client):
        return state_rows["box"]

    kwargs = dict(
        source="models", title="Models", endpoint="/api/models", fetch_all=fetch_all,
        key_fn=lambda r: r["modelRef"], columns=["modelRef", "location"],
    )

    r1 = run_snapshot_source(make_ctx(config, conn, run_id="run1"), **kwargs)
    assert r1.new_count == 2 and r1.changed_count == 0 and r1.removed_count == 0
    current = (config.data_dir / "models" / "CURRENT.md").read_text(encoding="utf-8")
    assert "M1" in current and "M2" in current

    state_rows["box"] = [{"modelRef": "M1", "location": "L11"}, {"modelRef": "M3", "location": "L10"}]
    r2 = run_snapshot_source(make_ctx(config, conn, run_id="run2"), **kwargs)
    assert r2.new_count == 1  # M3 added
    assert r2.changed_count == 1  # M1's location changed
    assert r2.removed_count == 1  # M2 gone
    patch_files = list((config.data_dir / "models").glob("models_patch_*.md"))
    assert len(patch_files) == 1
    patch_text = patch_files[0].read_text(encoding="utf-8")
    assert "## Added" in patch_text and "## Changed" in patch_text and "## Removed" in patch_text

    r3 = run_snapshot_source(make_ctx(config, conn, run_id="run3"), **kwargs)
    assert (r3.new_count, r3.changed_count, r3.removed_count) == (0, 0, 0)
    # No-change run must not add a second patch file.
    assert len(list((config.data_dir / "models").glob("models_patch_*.md"))) == 1


def test_snapshot_dry_run_does_not_write_or_mutate(config, conn):
    def fetch_all(client):
        return [{"modelRef": "M1", "location": "L10"}]

    ctx = make_ctx(config, conn, dry_run=True)
    result = run_snapshot_source(
        ctx, source="models", title="Models", endpoint="/api/models", fetch_all=fetch_all,
        key_fn=lambda r: r["modelRef"], columns=["location"],
    )
    assert result.new_count == 1
    assert not (config.data_dir / "models").exists()

    # A real run afterward still sees it as new — nothing was persisted by the dry run.
    real = run_snapshot_source(
        make_ctx(config, conn), source="models", title="Models", endpoint="/api/models",
        fetch_all=fetch_all, key_fn=lambda r: r["modelRef"], columns=["location"],
    )
    assert real.new_count == 1


def test_snapshot_unavailable_endpoint(config, conn):
    def fetch_all(client):
        raise EndpointUnavailableError("GET /api/models returned HTML")

    result = run_snapshot_source(
        make_ctx(config, conn), source="models", title="Models", endpoint="/api/models",
        fetch_all=fetch_all, key_fn=lambda r: r["modelRef"], columns=["location"],
    )
    assert result.status == "unavailable"
