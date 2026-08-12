from __future__ import annotations

from extractor import state


def test_mark_seen_if_new_is_idempotent(conn):
    h = state.content_hash({"a": 1})
    assert state.mark_seen_if_new(conn, "src", "key1", h, "run1") is True
    assert state.mark_seen_if_new(conn, "src", "key1", h, "run2") is False
    assert state.is_seen(conn, "src", "key1") is True
    assert state.is_seen(conn, "src", "key-never-seen") is False


def test_mark_seen_content_hash_mismatch_does_not_reemit(conn, caplog):
    h1 = state.content_hash({"a": 1})
    h2 = state.content_hash({"a": 2})
    assert state.mark_seen_if_new(conn, "src", "key1", h1, "run1") is True
    # Same key, different content — treated as immutable: not re-emitted as new.
    assert state.mark_seen_if_new(conn, "src", "key1", h2, "run2") is False


def test_cursor_roundtrip(conn):
    from datetime import date

    assert state.get_cursor(conn, "src") is None
    state.set_cursor(conn, "src", date(2026, 3, 1))
    assert state.get_cursor(conn, "src") == date(2026, 3, 1)
    state.set_cursor(conn, "src", date(2026, 3, 8))
    assert state.get_cursor(conn, "src") == date(2026, 3, 8)


def test_diff_snapshot_added_changed_removed(conn):
    run1 = {"a": {"id": "a", "v": 1}, "b": {"id": "b", "v": 1}}
    added, changed, removed = state.diff_snapshot(conn, "snap", run1, "run1")
    assert {r["id"] for r in added} == {"a", "b"}
    assert changed == []
    assert removed == []

    # Second run: 'a' unchanged, 'b' changed, 'c' new, previous 'a'/'b' still present
    # except we drop 'b' isn't dropped here — only omission = removal.
    run2 = {"a": {"id": "a", "v": 1}, "b": {"id": "b", "v": 2}, "c": {"id": "c", "v": 1}}
    added2, changed2, removed2 = state.diff_snapshot(conn, "snap", run2, "run2")
    assert [r["id"] for r in added2] == ["c"]
    assert len(changed2) == 1
    old, new = changed2[0]
    assert old == {"id": "b", "v": 1}
    assert new == {"id": "b", "v": 2}
    assert removed2 == []

    # Third run: 'a' disappears entirely -> removed
    run3 = {"b": {"id": "b", "v": 2}, "c": {"id": "c", "v": 1}}
    added3, changed3, removed3 = state.diff_snapshot(conn, "snap", run3, "run3")
    assert added3 == []
    assert changed3 == []
    assert [r["id"] for r in removed3] == ["a"]


def test_diff_snapshot_is_idempotent_when_nothing_changes(conn):
    run1 = {"a": {"id": "a", "v": 1}}
    state.diff_snapshot(conn, "snap", run1, "run1")
    added, changed, removed = state.diff_snapshot(conn, "snap", run1, "run2")
    assert (added, changed, removed) == ([], [], [])


def test_preview_diff_snapshot_does_not_write(conn):
    run1 = {"a": {"id": "a", "v": 1}}
    added, changed, removed = state.preview_diff_snapshot(conn, "snap", run1)
    assert [r["id"] for r in added] == ["a"]
    # Nothing was persisted — a real diff against the same input still sees it as new.
    added2, _, _ = state.diff_snapshot(conn, "snap", run1, "run1")
    assert [r["id"] for r in added2] == ["a"]


def test_has_run_this_week(conn):
    assert state.has_run_this_week(conn, "2026-W05") is False
    state.start_run(conn, "run1", "2026-W05")
    assert state.has_run_this_week(conn, "2026-W05") is False  # not finished yet
    state.finish_run(conn, "run1", "{}")
    assert state.has_run_this_week(conn, "2026-W05") is True
