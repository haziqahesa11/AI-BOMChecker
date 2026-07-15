from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class PartLookupSource(str, Enum):
    PLM_KEYMAKER = "plm_keymaker"
    WISTRON_LEGACY = "wistron_legacy"


@dataclass(frozen=True, slots=True)
class PartInfo:
    part_number: str
    general_description: str
    source: PartLookupSource
