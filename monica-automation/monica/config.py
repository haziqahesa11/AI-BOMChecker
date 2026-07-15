from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

_MONICA_DIR = Path(__file__).resolve().parent
_PROJECT_DIR = _MONICA_DIR.parent


def _parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    # utf-8-sig transparently strips a leading BOM if present (common in
    # .env files saved by Windows editors/PowerShell) and is a no-op
    # otherwise — plain "utf-8" would leave a stray ﻿ on the first key.
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


@dataclass(frozen=True)
class PlmConfig:
    primary_url: str
    legacy_url: str
    cache_dir: Path
    timeout_seconds: float
    max_retries: int
    site_jwts: dict[str, str]
    site_override: str | None


def load_plm_config(settings_path: Path | None = None) -> PlmConfig:
    settings_path = settings_path or (_PROJECT_DIR / "config" / "settings.toml")
    with settings_path.open("rb") as fh:
        settings = tomllib.load(fh)

    plm = settings["plm"]
    cache = settings["cache"]
    http = settings["http"]

    credentials_path = (settings_path.parent / plm["credentials_env"]).resolve()
    credentials = _parse_env_file(credentials_path)
    site_jwts = {k: v for k, v in credentials.items() if k.startswith("PLM_JWT_") and v}

    return PlmConfig(
        primary_url=plm["primary_base_url"] + plm["primary_path"],
        legacy_url=plm["legacy_base_url"] + plm["legacy_path"],
        cache_dir=_PROJECT_DIR / cache["plm_cache_dir"],
        timeout_seconds=float(http["timeout_seconds"]),
        max_retries=int(http["max_retries"]),
        site_jwts=site_jwts,
        site_override=credentials.get("PLM_SITE_CODE") or None,
    )
