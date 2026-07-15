from __future__ import annotations

from pathlib import Path

import pytest

import monica.bom_builder as bom_builder
from monica.bom_builder import NO_DEVICE, WILDCARD_REVISION, TestBomRow, build_csv, resolve_test_bom_rows

_SAMPLE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<CONFIGURATION>
  <MODEL>
    <C2012_L11 LEVEL="L11">
      <LOCATION NAME="B01" TYPE="HW" REMARK="Blade Slot" />
      <LOCATION NAME="B02" TYPE="HW" REMARK="Blade Slot" />
      <LOCATION NAME="CRD" TYPE="DOC" REMARK="CRD FILE" />
    </C2012_L11>
  </MODEL>
</CONFIGURATION>
"""


@pytest.fixture
def sample_xml(tmp_path: Path) -> Path:
    p = tmp_path / "MonicaTPGenerator.xml"
    p.write_text(_SAMPLE_XML, encoding="utf-8")
    return p


def test_resolve_prefers_existing_sysbom_data(monkeypatch: pytest.MonkeyPatch, sample_xml: Path) -> None:
    def fake_get_sysbom_rows(parent_part_number: str, *, config=None):
        assert parent_part_number == "B81.04E01.0001"
        return [
            {
                "Location": "B01",
                "Type": "BLADE",
                "Level": "L11",
                "ChildPartNumber": "M1237043-900$A2",
                "ChildRevision": "*",
                "Remark": "Blade Slot",
            }
        ]

    monkeypatch.setattr(bom_builder, "get_sysbom_rows", fake_get_sysbom_rows)

    rows = resolve_test_bom_rows("C2012_L11", "B81.04E01.0001", xml_path=sample_xml)

    assert rows == [
        TestBomRow(location="B01", type="BLADE", level="L11", cpn="M1237043-900$A2", revision="*", remark="Blade Slot"),
        TestBomRow(location="B02", type="HW", level="", cpn=NO_DEVICE, revision=WILDCARD_REVISION, remark="Blade Slot"),
        TestBomRow(location="CRD", type="DOC", level="", cpn=NO_DEVICE, revision=WILDCARD_REVISION, remark="CRD FILE"),
    ]


def test_resolve_logs_unmatched_sysbom_locations(
    monkeypatch: pytest.MonkeyPatch, sample_xml: Path, caplog: pytest.LogCaptureFixture
) -> None:
    def fake_get_sysbom_rows(parent_part_number: str, *, config=None):
        return [
            {
                "Location": "NOT_IN_XML",
                "Type": "BLADE",
                "Level": "L11",
                "ChildPartNumber": "M1234567-001",
                "ChildRevision": "*",
                "Remark": "",
            }
        ]

    monkeypatch.setattr(bom_builder, "get_sysbom_rows", fake_get_sysbom_rows)

    with caplog.at_level("WARNING"):
        rows = resolve_test_bom_rows("C2012_L11", "B81.04E01.0001", xml_path=sample_xml)

    assert "NOT_IN_XML" in caplog.text
    # every row falls back to defaults since the only SysBom row didn't match any location
    assert all(row.cpn == NO_DEVICE for row in rows)


def test_build_csv_not_yet_implemented(tmp_path: Path) -> None:
    rows = [TestBomRow(location="B01", type="HW", level="L11", cpn=NO_DEVICE, revision="*", remark="Blade Slot")]
    with pytest.raises(NotImplementedError):
        build_csv(rows, tmp_path / "out.csv")
