from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

from extractor.config import load_config


def _write_env(path: Path, **kv) -> None:
    path.write_text("\n".join(f"{k}={v}" for k, v in kv.items()), encoding="utf-8")


def test_load_config_from_explicit_env_path(tmp_path, monkeypatch):
    monkeypatch.delenv("NEXAI_EXTRACTOR_ENV", raising=False)
    env_file = tmp_path / "nexai_extractor.env"
    _write_env(
        env_file,
        AI_BOM_API_BASE_URL="http://example.local:8000",
        DATA_COMPILATION_DIR=str(tmp_path / "out"),
    )
    config = load_config(env_path=env_file)
    assert config.base_url == "http://example.local:8000"
    assert config.data_dir == tmp_path / "out"
    assert config.history_epoch == date(2015, 1, 1)  # default


def test_load_config_via_nexai_extractor_env_var(tmp_path, monkeypatch):
    env_file = tmp_path / "custom.env"
    _write_env(
        env_file,
        AI_BOM_API_BASE_URL="http://example.local:9000",
        DATA_COMPILATION_DIR=str(tmp_path / "out2"),
    )
    monkeypatch.setenv("NEXAI_EXTRACTOR_ENV", str(env_file))
    config = load_config()
    assert config.base_url == "http://example.local:9000"


def test_load_config_raises_a_clear_error_when_nothing_is_configured(tmp_path, monkeypatch):
    # Regression test: NEXAI_EXTRACTOR_ENV unset must fall through to
    # _DEFAULT_ENV_PATH, not silently resolve to Path(".") — which previously raised
    # IsADirectoryError instead of the intended "AI_BOM_API_BASE_URL is not set"
    # RuntimeError. _DEFAULT_ENV_PATH is fixed relative to config.py's own file
    # location (not cwd), so it's monkeypatched directly here to a path that's
    # guaranteed not to exist, rather than relying on chdir.
    import extractor.config as config_module

    monkeypatch.delenv("NEXAI_EXTRACTOR_ENV", raising=False)
    monkeypatch.setattr(config_module, "_DEFAULT_ENV_PATH", tmp_path / "does-not-exist.env")
    with pytest.raises(RuntimeError, match="AI_BOM_API_BASE_URL"):
        load_config()
