from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from .db import SqlConfig, get_sysbom_rows
from .tpg_xml import LIVE_XML_PATH, get_locations

logger = logging.getLogger("monica.bom_builder")

NO_DEVICE: str = "NO_DEVICE"
WILDCARD_REVISION: str = "*"


@dataclass(frozen=True, slots=True)
class TestBomRow:
    __test__ = False  # not a pytest test class despite the name

    location: str
    type: str
    level: str
    cpn: str
    revision: str
    remark: str
    # Description is auto-populated by MonicaTPGenerator itself once a CPN is chosen
    # (confirmed 2026-07-14: selecting a CPN in the live grid filled Description
    # automatically) — not resolved here.


def resolve_test_bom_rows(
    model_ref: str,
    parent_part_number: str,
    *,
    xml_path: Path | None = None,
    config: SqlConfig | None = None,
) -> list[TestBomRow]:
    """Read-only: resolve the full set of Test BOM rows for a model reference + assembly
    part number, one row per location defined for that model in MonicaTPGenerator.xml.

    For each location, prefer the existing SysBom row's Type/Level/ChildPartNumber/
    ChildRevision/Remark (SP_SysBom_PN_List — real, current data) when one exists.
    Locations present in the XML but absent from SysBom (e.g. a brand-new part number
    with nothing keyed in yet) fall back to the XML's Type/Remark, "NO_DEVICE" CPN, and
    "*" revision. Any SysBom row whose Location doesn't match a single XML location name
    is logged loudly (not silently dropped) — location naming can differ subtly (e.g.
    "PCIe Slot #1.R1.PCIEM1") and a silent mismatch would produce an incomplete or wrong
    Test BOM.
    """
    xml_path = xml_path or LIVE_XML_PATH
    locations = get_locations(model_ref, xml_path)
    sysbom_rows = get_sysbom_rows(parent_part_number, config=config)

    sysbom_by_location = {row["Location"]: row for row in sysbom_rows}
    xml_location_names = {loc.name for loc in locations}

    unmatched = set(sysbom_by_location) - xml_location_names
    if unmatched:
        logger.warning(
            "SysBom has %d location(s) for %s not present in MonicaTPGenerator.xml's "
            "%s location list — these will be DROPPED from the Test BOM row set: %s",
            len(unmatched), parent_part_number, model_ref, sorted(unmatched),
        )

    rows: list[TestBomRow] = []
    for loc in locations:
        sysbom_row = sysbom_by_location.get(loc.name)
        if sysbom_row is not None:
            rows.append(
                TestBomRow(
                    location=loc.name,
                    type=sysbom_row.get("Type") or loc.type,
                    level=sysbom_row.get("Level") or "",
                    cpn=sysbom_row.get("ChildPartNumber") or NO_DEVICE,
                    revision=sysbom_row.get("ChildRevision") or WILDCARD_REVISION,
                    remark=sysbom_row.get("Remark") or loc.remark,
                )
            )
        else:
            logger.info(
                "no SysBom row for location %r on %s — defaulting to %s/%s",
                loc.name, parent_part_number, NO_DEVICE, WILDCARD_REVISION,
            )
            rows.append(
                TestBomRow(
                    location=loc.name,
                    type=loc.type,
                    level="",
                    cpn=NO_DEVICE,
                    revision=WILDCARD_REVISION,
                    remark=loc.remark,
                )
            )

    return rows


def build_csv(rows: list[TestBomRow], out_path: Path) -> None:
    """Write rows in MonicaTPGenerator's Test BOM Save/Load CSV format.

    NOT YET IMPLEMENTED: the real column order, delimiter, quoting, and unset-cell
    representation must be derived empirically from a real Save (see monica-automation/
    CONTEXT.md Phase 4 step 1 and monica-automation/docs/tbm_csv_schema.md, not yet
    written). CONTEXT.md's "5 comma-separated fields" is an unverified claim, not a
    confirmed schema — do not guess it here. Raises deliberately rather than emitting a
    plausible-looking but unverified file that Load could silently misinterpret.
    """
    raise NotImplementedError(
        "Test BOM CSV schema not yet empirically confirmed — see the docstring above "
        "and monica-automation/CONTEXT.md Phase 4 step 1 before implementing this."
    )
