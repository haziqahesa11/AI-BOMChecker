"""Loads NexaiDataExtractor's settings from config/credentials/nexai_extractor.env,
using the exact same flat KEY=value parser as HQ Fetching/wts_dashboard/wts_fetch.py's
_parse_env_file, so this fits the repo's existing per-system credentials convention.

Layout assumption: this file lives at <repo>/NexaiDataExtractor/extractor/config.py, so
config/credentials/ is two levels up from NexaiDataExtractor/ — i.e. parents[2] from here.
When deployed standalone to NEXAi, keep NexaiDataExtractor/ and config/credentials/ in that
same relative arrangement (see README.md), or set NEXAI_EXTRACTOR_ENV to an absolute path.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Final

_PROJECT_DIR: Final[Path] = Path(__file__).resolve().parent.parent
_DEFAULT_ENV_PATH: Final[Path] = _PROJECT_DIR.parent / "config" / "credentials" / "nexai_extractor.env"


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def _get(env_file: dict[str, str], key: str, default: str = "") -> str:
    return os.environ.get(key, "").strip() or env_file.get(key, "").strip() or default


@dataclass(frozen=True)
class ExtractorConfig:
    base_url: str
    data_dir: Path
    history_epoch: date
    max_entities_per_file: int
    chunk_days: int


def load_config(env_path: Path | None = None) -> ExtractorConfig:
    # NOTE: Path("").expanduser() resolves to Path(".") — a real, truthy Path — so
    # `Path(os.environ.get(...)) or _DEFAULT_ENV_PATH` never falls through even when
    # the env var is unset. Check the raw string's truthiness first, before
    # constructing a Path from it, to actually get the intended fallback behavior.
    env_var = os.environ.get("NEXAI_EXTRACTOR_ENV", "").strip()
    path = env_path or (Path(env_var).expanduser() if env_var else _DEFAULT_ENV_PATH)
    env_file = _parse_env_file(path)

    base_url = _get(env_file, "AI_BOM_API_BASE_URL")
    if not base_url:
        raise RuntimeError(
            f"AI_BOM_API_BASE_URL is not set. Copy nexai_extractor.env.example to "
            f"{path} (or point NEXAI_EXTRACTOR_ENV at your own copy) and fill it in."
        )

    data_dir_raw = _get(env_file, "DATA_COMPILATION_DIR")
    if not data_dir_raw:
        raise RuntimeError(f"DATA_COMPILATION_DIR is not set in {path}.")

    epoch_raw = _get(env_file, "HISTORY_EPOCH", "2015-01-01")
    max_entities = int(_get(env_file, "MAX_ENTITIES_PER_FILE", "300"))
    chunk_days = int(_get(env_file, "CHUNK_DAYS", "30"))

    return ExtractorConfig(
        base_url=base_url.rstrip("/"),
        data_dir=Path(data_dir_raw).expanduser(),
        history_epoch=date.fromisoformat(epoch_raw),
        max_entities_per_file=max_entities,
        chunk_days=chunk_days,
    )
