from __future__ import annotations

from pathlib import Path

import pytest

from monica.tpg_xml import LocationSpec, get_locations

_SAMPLE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<CONFIGURATION>
  <SETTING>
    <SQL IP="MonicaMTE.wiwynn.com" NAME="WYHQ_SQL" LOCATION="WYHQ" IN="SQLEXPRESS" />
  </SETTING>
  <MODEL>
    <C2012_L11 LEVEL="L11">
      <LOCATION NAME="CRD" TYPE="DOC" REMARK="CRD FILE" />
      <LOCATION NAME="B01" TYPE="HW" REMARK="Blade Slot" />
      <LOCATION NAME="B02" TYPE="HW" REMARK="Blade Slot" />
    </C2012_L11>
  </MODEL>
</CONFIGURATION>
"""


@pytest.fixture
def sample_xml(tmp_path: Path) -> Path:
    p = tmp_path / "MonicaTPGenerator.xml"
    p.write_text(_SAMPLE_XML, encoding="utf-8")
    return p


def test_get_locations_returns_ordered_list(sample_xml: Path) -> None:
    locations = get_locations("C2012_L11", sample_xml)
    assert locations == [
        LocationSpec(name="CRD", type="DOC", remark="CRD FILE"),
        LocationSpec(name="B01", type="HW", remark="Blade Slot"),
        LocationSpec(name="B02", type="HW", remark="Blade Slot"),
    ]


def test_get_locations_unknown_model_raises(sample_xml: Path) -> None:
    with pytest.raises(KeyError):
        get_locations("NOT_A_REAL_MODEL", sample_xml)
