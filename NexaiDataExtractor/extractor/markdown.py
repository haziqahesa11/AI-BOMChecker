"""Markdown rendering for the Data_Compilation library. Every writer here follows the
same shape so an Ollama-side RAG pipeline can rely on it: YAML frontmatter naming the
source/endpoint/run, an H1 title, then content grouped under H2 sections so a chunker
splitting on headings lands on a coherent unit (one USN, one CRD line, one project) —
never a table split mid-entity.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Iterable

import yaml


def escape_cell(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("|", "\\|").replace("\n", " ").strip()


def render_table(columns: list[str] | None, rows: list[dict]) -> str:
    if not rows:
        return "_(no rows)_\n"
    cols = columns or sorted({k for r in rows for k in r.keys()})
    header = "| " + " | ".join(cols) + " |"
    sep = "| " + " | ".join("---" for _ in cols) + " |"
    body_lines = ["| " + " | ".join(escape_cell(r.get(c)) for c in cols) + " |" for r in rows]
    return "\n".join([header, sep, *body_lines]) + "\n"


def frontmatter(fields: dict) -> str:
    body = yaml.safe_dump(fields, sort_keys=False, default_flow_style=False, allow_unicode=True).strip()
    return f"---\n{body}\n---\n"


def group_rows(rows: list[dict], group_fn: Callable[[dict], str] | None) -> dict[str, list[dict]]:
    if group_fn is None:
        return {"_all": rows}
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(group_fn(row), []).append(row)
    return grouped


def chunk_groups(grouped: dict[str, list[dict]], max_per_file: int) -> list[dict[str, list[dict]]]:
    """Packs (group -> rows) into file-sized parts without splitting a group across
    files, unless the group alone exceeds max_per_file — only then does it split
    mid-group, as a last resort."""
    parts: list[dict[str, list[dict]]] = []
    current: dict[str, list[dict]] = {}
    current_count = 0
    for gkey, rows in grouped.items():
        if len(rows) > max_per_file:
            if current:
                parts.append(current)
                current, current_count = {}, 0
            for i in range(0, len(rows), max_per_file):
                parts.append({gkey: rows[i : i + max_per_file]})
            continue
        if current and current_count + len(rows) > max_per_file:
            parts.append(current)
            current, current_count = {}, 0
        current[gkey] = rows
        current_count += len(rows)
    if current:
        parts.append(current)
    return parts or [{}]


def _write(path: Path, sections: list[str]) -> None:
    path.write_text("\n".join(sections), encoding="utf-8")


def write_event_patch(
    out_dir: Path,
    *,
    source: str,
    title: str,
    iso_week: str,
    run_id: str,
    generated_at: str,
    upstream_endpoint: str,
    query: dict,
    total_seen_this_run: int,
    grouped_rows: dict[str, list[dict]],
    columns: list[str] | None,
    max_per_file: int,
) -> list[tuple[Path, int]]:
    """Writes one or more `<source>_patch_<iso_week>[_partNNN].md` files, one H2
    section per group (group_fn's own return value IS the full heading text, e.g.
    "USN R02886305000306D" or "Line 5" — see extractor/sources/*.py). Returns
    [(path, record_count), ...]."""
    out_dir.mkdir(parents=True, exist_ok=True)
    parts = chunk_groups(grouped_rows, max_per_file)
    results: list[tuple[Path, int]] = []
    n_parts = len(parts)
    for idx, part in enumerate(parts, start=1):
        part_count = sum(len(v) for v in part.values())
        suffix = f"_part{idx:03d}" if n_parts > 1 else ""
        fpath = out_dir / f"{source}_patch_{iso_week}{suffix}.md"
        fm = frontmatter(
            {
                "source": source,
                "kind": "event_delta",
                "run_id": run_id,
                "iso_work_week": iso_week,
                "generated_at": generated_at,
                "record_count": part_count,
                "upstream_endpoint": upstream_endpoint,
                "query": query,
                "part": f"{idx} of {n_parts}",
            }
        )
        sections = [
            fm,
            f"\n# {title} — Patch — {iso_week}\n",
            f"{part_count} new record(s) not previously recorded "
            f"(of {total_seen_this_run} total returned by the API for this run's window).\n",
        ]
        for gkey, rows in part.items():
            if gkey != "_all":
                sections.append(f"\n## {gkey}\n")
            sections.append(render_table(columns, rows))
        _write(fpath, sections)
        results.append((fpath, part_count))
    return results


def write_snapshot_diff(
    out_dir: Path,
    *,
    source: str,
    title: str,
    iso_week: str,
    run_id: str,
    generated_at: str,
    upstream_endpoint: str,
    query: dict | None,
    added: list[dict],
    changed: list[tuple[dict, dict]],
    removed: list[dict],
    columns: list[str] | None,
) -> tuple[Path, int] | None:
    if not (added or changed or removed):
        return None
    out_dir.mkdir(parents=True, exist_ok=True)
    fpath = out_dir / f"{source}_patch_{iso_week}.md"
    total = len(added) + len(changed) + len(removed)
    fm = frontmatter(
        {
            "source": source,
            "kind": "snapshot_diff",
            "run_id": run_id,
            "iso_work_week": iso_week,
            "generated_at": generated_at,
            "added": len(added),
            "changed": len(changed),
            "removed": len(removed),
            "upstream_endpoint": upstream_endpoint,
            "query": query or {},
        }
    )
    sections = [fm, f"\n# {title} — Weekly Change — {iso_week}\n"]
    if added:
        sections.append(f"\n## Added ({len(added)})\n")
        sections.append(render_table(columns, added))
    if changed:
        sections.append(f"\n## Changed ({len(changed)})\n")
        for old, new in changed:
            old_row = dict(old, _version="before") if old else {"_version": "before", "note": "(prior value not retained)"}
            new_row = dict(new, _version="after")
            cols = ["_version", *columns] if columns else None
            sections.append(render_table(cols, [old_row, new_row]))
    if removed:
        sections.append(f"\n## Removed ({len(removed)})\n")
        sections.append(render_table(columns, removed))
    _write(fpath, sections)
    return fpath, total


def write_current(
    out_dir: Path,
    *,
    source: str,
    title: str,
    run_id: str,
    generated_at: str,
    upstream_endpoint: str,
    rows: list[dict],
    columns: list[str] | None,
    group_fn: Callable[[dict], str] | None,
    max_per_file: int,
) -> list[tuple[Path, int]]:
    """Overwrites CURRENT.md (and CURRENT_partNNN.md if needed) with the full current
    snapshot — the canonical 'what's true right now' doc, separate from the dated
    audit-trail patches. Stale leftover parts from a previous, larger run are removed
    first so the folder never carries orphaned CURRENT_partNNN.md files."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("CURRENT*.md"):
        stale.unlink()

    grouped = group_rows(rows, group_fn)
    parts = chunk_groups(grouped, max_per_file)
    results: list[tuple[Path, int]] = []
    n_parts = len(parts)
    for idx, part in enumerate(parts, start=1):
        part_count = sum(len(v) for v in part.values())
        suffix = f"_part{idx:03d}" if n_parts > 1 else ""
        fpath = out_dir / f"CURRENT{suffix}.md"
        fm = frontmatter(
            {
                "source": source,
                "kind": "snapshot_current",
                "run_id": run_id,
                "generated_at": generated_at,
                "record_count": len(rows),
                "upstream_endpoint": upstream_endpoint,
                "part": f"{idx} of {n_parts}",
            }
        )
        sections = [fm, f"\n# {title} — Current State\n", f"{len(rows)} record(s) as of {generated_at}.\n"]
        for gkey, grows in part.items():
            if gkey != "_all":
                sections.append(f"\n## {gkey}\n")
            sections.append(render_table(columns, grows))
        _write(fpath, sections)
        results.append((fpath, part_count))
    return results


_INDEX_HEADER = """\
---
generated_at: {generated_at}
run_id: {run_id}
---

# Data Compilation — Index

Auto-generated manifest of every file in this library, newest first. `_state/` holds
internal bookkeeping only (a SQLite dedup/diff ledger) — it is not library content and
should be excluded from ingestion. Each source's `CURRENT.md` is the canonical
present-state document; dated `*_patch_*.md` files are the append-only audit trail of
what changed, work week by work week, since that source was first captured.

| Source | File | Kind | Work Week | Generated At | Records |
|---|---|---|---|---|---|
"""


def write_index(root_dir: Path, conn, run_id: str, generated_at: str) -> Path:
    from . import state

    lines = [_INDEX_HEADER.format(generated_at=generated_at, run_id=run_id)]
    for file_path, source, kind, week, gen_at, count in state.iter_index_entries(conn):
        rel = Path(file_path).resolve().relative_to(root_dir.resolve()).as_posix()
        lines.append(f"| {source} | [{rel}]({rel}) | {kind} | {week or ''} | {gen_at} | {count} |\n")
    out_path = root_dir / "INDEX.md"
    out_path.write_text("".join(lines), encoding="utf-8")
    return out_path
