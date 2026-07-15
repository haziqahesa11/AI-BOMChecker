from __future__ import annotations

import pytest

from monica.db import WriteProcedureBlockedError, call_read_only_proc, is_read_only_proc


@pytest.mark.parametrize(
    "name,expected",
    [
        ("SP_QVL_Query", True),
        ("SP_QVL_Query_DESC", True),
        ("SP_QVL_Query_ModelRef", True),
        ("SP_LocationTable_Query", True),
        ("SP_LocationTable_Model_Distinct", True),
        ("SP_LocationTableExtended_List", True),
        ("SP_ReviewList_Query", True),
        ("SP_SysBomWaitList_PN_List", True),
        # writes must never pass, even though they share a prefix with a read proc
        ("SP_QVL_Update", False),
        ("SP_QVL_Delete", False),
        ("SP_SysBomWaitList_Update", False),
        ("SP_ReviewList_Update", False),
        ("SP_ReviewList_Approve", False),
        ("SP_SysBom_Update", False),
        # replication-generated procs must never pass, regardless of naming
        ("sp_MSins_dboQVL", False),
        ("sp_MSupd_dboQVL", False),
        ("sp_MSdel_dboQVL", False),
        # deliberately excluded even though arguably read-only (narrower than the brief)
        ("SP_PartDescription_Find", False),
        ("SP_SysBom_PN_CPN_Filter", False),
        ("SP_SysBom_PN_PPN_Filter", False),
        # confirmed real procs (2026-07-14), including cross-catalog qualified names —
        # only the segment after the last '.' is checked against the SP_/token rule
        ("SP_SysBom_PN_List", True),
        ("MSFT_SKU.dbo.SP_CRDspec_Query", True),
        ("MSFT_SKU.dbo.SP_CRDspec_Update", False),
        ("MSFT_SKU.dbo.sp_MSins_dboCRDspec", False),
    ],
)
def test_is_read_only_proc(name: str, expected: bool) -> None:
    assert is_read_only_proc(name) is expected


def test_call_read_only_proc_blocks_write_procs_before_execute() -> None:
    class ExplodingCursor:
        def execute(self, *args: object, **kwargs: object) -> None:
            raise AssertionError("execute() must never be called for a blocked proc")

    with pytest.raises(WriteProcedureBlockedError):
        call_read_only_proc(ExplodingCursor(), "SP_QVL_Update", ("C2012_L11", "L11", "M1234567-001"))
