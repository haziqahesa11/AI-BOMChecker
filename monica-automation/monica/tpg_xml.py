from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree

_REPO_ROOT: Path = Path(__file__).resolve().parent.parent.parent
LIVE_XML_PATH: Path = _REPO_ROOT / "@BOM-Based-APP" / "New MTPG" / "MonicaTPGenerator.xml"


@dataclass(frozen=True, slots=True)
class LocationSpec:
    name: str
    type: str
    remark: str


def get_locations(model_ref: str, xml_path: Path | None = None) -> list[LocationSpec]:
    """Read-only: the authoritative, ordered list of locations for a model reference,
    parsed from the live MonicaTPGenerator.xml (per CONTEXT.md: parse this file, don't
    hardcode location lists).

    Note: this XML's own TYPE attribute (e.g. "HW", "FW", "DOC") does not match the
    Type column SP_SysBom_PN_List returns for the same locations (e.g. "BLADE") —
    confirmed 2026-07-14 against real data. REMARK does match ("Blade Slot" in both).
    Callers building a Test BOM row set should prefer SysBom's Type/Remark when a
    location has existing SysBom data, and only fall back to this XML's TYPE/REMARK
    for locations with no SysBom row yet (e.g. a brand-new part number).
    """
    xml_path = xml_path or LIVE_XML_PATH
    tree = ElementTree.parse(xml_path)
    model_el = tree.getroot().find(f"./MODEL/{model_ref}")
    if model_el is None:
        raise KeyError(f"Model reference {model_ref!r} not found in {xml_path}")

    return [
        LocationSpec(
            name=loc.attrib["NAME"],
            type=loc.attrib.get("TYPE", ""),
            remark=loc.attrib.get("REMARK", ""),
        )
        for loc in model_el.findall("LOCATION")
    ]
