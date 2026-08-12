from __future__ import annotations

from extractor import markdown


def test_render_table_escapes_pipes_and_newlines():
    out = markdown.render_table(["a", "b"], [{"a": "x|y", "b": "line1\nline2"}])
    assert "x\\|y" in out
    assert "line1 line2" in out
    assert "\n\n" not in out.strip("\n")  # no literal embedded newline from the cell


def test_render_table_empty_rows():
    assert "no rows" in markdown.render_table(["a"], [])


def test_render_table_dynamic_columns_union_sorted():
    rows = [{"b": 1}, {"a": 2, "c": 3}]
    out = markdown.render_table(None, rows)
    header = out.splitlines()[0]
    assert header == "| a | b | c |"


def test_frontmatter_roundtrip():
    fm = markdown.frontmatter({"source": "x", "record_count": 3, "query": {"from": "2026-01-01"}})
    assert fm.startswith("---\n")
    assert fm.strip().endswith("---")
    assert "source: x" in fm
    assert "record_count: 3" in fm


def test_chunk_groups_keeps_small_groups_together():
    grouped = {"g1": [{"i": 1}], "g2": [{"i": 2}], "g3": [{"i": 3}]}
    parts = markdown.chunk_groups(grouped, max_per_file=2)
    assert sum(sum(len(v) for v in p.values()) for p in parts) == 3
    for p in parts:
        assert sum(len(v) for v in p.values()) <= 2
    # groups never split across parts here since each is size 1
    for p in parts:
        for rows in p.values():
            assert len(rows) == 1


def test_chunk_groups_splits_an_oversized_single_group():
    grouped = {"big": [{"i": i} for i in range(7)]}
    parts = markdown.chunk_groups(grouped, max_per_file=3)
    assert [sum(len(v) for v in p.values()) for p in parts] == [3, 3, 1]


def test_write_event_patch_and_current_roundtrip(tmp_path):
    out_dir = tmp_path / "cycle_time_l11"
    grouped = {"USN USN1": [{"stage": "WA", "trndate": "2026-01-01"}]}
    results = markdown.write_event_patch(
        out_dir,
        source="cycle_time_l11",
        title="Cycle Time — L11",
        iso_week="2026-W05",
        run_id="run1",
        generated_at="2026-02-01T00:00:00Z",
        upstream_endpoint="/api/cycle-time/l11",
        query={"from": "2026-01-01", "to": "2026-01-31"},
        total_seen_this_run=1,
        grouped_rows=grouped,
        columns=["stage", "trndate"],
        max_per_file=300,
    )
    assert len(results) == 1
    path, count = results[0]
    assert count == 1
    assert path.exists()
    text = path.read_text(encoding="utf-8")
    assert "## USN USN1" in text
    assert "cycle_time_l11_patch_2026-W05.md" == path.name


def test_write_current_overwrites_stale_parts(tmp_path):
    out_dir = tmp_path / "models"
    # first write: 2 parts
    markdown.write_current(
        out_dir, source="models", title="Models", run_id="run1", generated_at="t1",
        upstream_endpoint="/api/models", rows=[{"modelRef": f"M{i}"} for i in range(5)],
        columns=["modelRef"], group_fn=None, max_per_file=2,
    )
    assert len(list(out_dir.glob("CURRENT*.md"))) == 3  # ceil(5/2)

    # second write: shrinks to 1 part — stale CURRENT_part002/003.md must be gone
    markdown.write_current(
        out_dir, source="models", title="Models", run_id="run2", generated_at="t2",
        upstream_endpoint="/api/models", rows=[{"modelRef": "M1"}],
        columns=["modelRef"], group_fn=None, max_per_file=2,
    )
    files = sorted(p.name for p in out_dir.glob("CURRENT*.md"))
    assert files == ["CURRENT.md"]
