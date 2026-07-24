from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

from monica.config import _parse_env_file

_AGENT_DIR = Path(__file__).resolve().parent
_PROJECT_DIR = _AGENT_DIR.parent


@dataclass(frozen=True)
class AgentConfig:
    backend_base_url: str
    poll_interval_seconds: float
    tpg_exe_path: str
    agent_token: str


def load_agent_config(settings_path: Path | None = None) -> AgentConfig:
    settings_path = settings_path or (_PROJECT_DIR / "config" / "settings.toml")
    with settings_path.open("rb") as fh:
        settings = tomllib.load(fh)

    agent = settings["automation_agent"]
    credentials_path = (settings_path.parent / agent["credentials_env"]).resolve()
    credentials = _parse_env_file(credentials_path)
    token = credentials.get("AUTOMATION_AGENT_TOKEN")
    if not token:
        raise RuntimeError(
            f"AUTOMATION_AGENT_TOKEN not set in {credentials_path} — copy "
            "automation.env.example to automation.env, fill in the real token "
            "(must match the value BackEnd/server.js was started with), and retry."
        )

    # tpg_exe_path is stored relative to _PROJECT_DIR (monica-automation/) so
    # the same settings.toml works for any engineer's checkout regardless of
    # their Windows username/OneDrive folder — resolve it to an absolute path
    # here rather than baking one into the repo.
    tpg_exe_path = str((_PROJECT_DIR / agent["tpg_exe_path"]).resolve())

    return AgentConfig(
        backend_base_url=agent["backend_base_url"].rstrip("/"),
        poll_interval_seconds=float(agent["poll_interval_seconds"]),
        tpg_exe_path=tpg_exe_path,
        agent_token=token,
    )
