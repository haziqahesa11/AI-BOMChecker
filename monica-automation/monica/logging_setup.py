from __future__ import annotations

import logging
from pathlib import Path


def configure_logging(log_path: Path, level: int = logging.INFO) -> None:
    """Attach a file handler to the 'monica' logger tree. Never logs Authorization headers."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(log_path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logger = logging.getLogger("monica")
    logger.setLevel(level)
    logger.addHandler(handler)
