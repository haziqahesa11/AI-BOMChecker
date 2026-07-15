from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import pyodbc

from .config import _parse_env_file

logger = logging.getLogger("monica.db")

_PROJECT_DIR: Final[Path] = Path(__file__).resolve().parent.parent
_REPO_ROOT: Final[Path] = _PROJECT_DIR.parent

# Confirmed 2026-07-10 via sys.procedures/sys.parameters introspection against the real
# server: QVL/SysBom/ReviewList procedures live in the "BOM" database, not "MSFT_SKU" as
# CONTEXT.md assumes. See monica-automation/config/settings.toml for the full note.
_CONFIRMED_DATABASE: Final[str] = "BOM"

_READ_ONLY_TOKENS: Final[frozenset[str]] = frozenset({"query", "list", "distinct"})


class WriteProcedureBlockedError(RuntimeError):
    """Raised when code attempts to call a stored procedure not on the read-only whitelist."""


def is_read_only_proc(name: str) -> bool:
    """True only for 'SP_...' procs with a Query/List/Distinct segment in their name.

    Deliberately excludes the lowercase 'sp_MSins_'/'sp_MSupd_'/'sp_MSdel_' replication
    procs (case-sensitive prefix check) and anything without one of the three read tokens,
    even if it looks read-adjacent (e.g. 'SP_PartDescription_Find', 'SP_SysBom_PN_CPN_Filter'
    are intentionally NOT whitelisted here — narrower than the brief's own rule, on purpose).

    Accepts fully-qualified cross-catalog names too (e.g.
    'MSFT_SKU.dbo.SP_CRDspec_Query' — confirmed 2026-07-14 that CRDspec procs live in
    MSFT_SKU, not BOM, and that this connection's default database (BOM) can still call
    them cross-catalog via EXEC). Only the segment after the last '.' is checked against
    the SP_/token rule; the qualified string itself is still what gets executed.
    """
    bare_name = name.rsplit(".", 1)[-1]
    if not bare_name.startswith("SP_"):
        return False
    tokens = {t.lower() for t in bare_name.split("_")}
    return bool(tokens & _READ_ONLY_TOKENS)


@dataclass(frozen=True)
class SqlConfig:
    host: str
    port: int
    database: str
    user: str
    password: str


def load_sql_config() -> SqlConfig:
    credentials_path = _REPO_ROOT / "config" / "credentials" / "sql.env"
    env = _parse_env_file(credentials_path)
    return SqlConfig(
        host=env["SQL_HOST"],
        port=int(env["SQL_PORT"]),
        database=_CONFIRMED_DATABASE,
        user=env["SQL_USER"],
        password=env["SQL_PASSWORD"],
    )


def connect(config: SqlConfig | None = None) -> pyodbc.Connection:
    config = config or load_sql_config()
    conn_str = (
        "Driver={SQL Server};"
        f"Server={config.host},{config.port};"
        f"Database={config.database};"
        f"UID={config.user};"
        f"PWD={config.password};"
    )
    return pyodbc.connect(conn_str, timeout=10)


def call_read_only_proc(
    cursor: pyodbc.Cursor, proc_name: str, params: tuple[Any, ...] = ()
) -> list[pyodbc.Row]:
    """Execute a whitelisted read-only stored procedure. Parameters are always bound, never
    string-concatenated. proc_name is not user/PN-supplied — it's a fixed identifier chosen
    by our own code and checked against the whitelist before ever reaching cursor.execute.
    """
    if not is_read_only_proc(proc_name):
        raise WriteProcedureBlockedError(
            f"{proc_name!r} is not on the read-only whitelist (must start with 'SP_' and "
            "contain a Query/List/Distinct segment) — refusing to call it in this phase"
        )
    placeholders = ", ".join("?" for _ in params)
    sql = f"EXEC {proc_name} {placeholders}" if params else f"EXEC {proc_name}"
    logger.info("calling read-only proc %s with %d param(s)", proc_name, len(params))
    cursor.execute(sql, params)
    return cursor.fetchall()  # type: ignore[no-any-return]  # pyodbc ships no type stubs


def get_qvl(model_ref: str, location: str, *, config: SqlConfig | None = None) -> list[dict[str, Any]]:
    """Read-only: current QVL entries (with description) for a model reference + location."""
    cn = connect(config)
    try:
        cur = cn.cursor()
        rows = call_read_only_proc(cur, "SP_QVL_Query_DESC", (model_ref, location))
        columns: list[str] = [d[0] for d in cur.description]
        return [dict(zip(columns, row)) for row in rows]
    finally:
        cn.close()


def get_sysbom_rows(parent_part_number: str, *, config: SqlConfig | None = None) -> list[dict[str, Any]]:
    """Read-only: current SysBom rows (Location/Type/Level/ChildPartNumber/ChildRevision/
    Remark) for an assembly part number. Confirmed 2026-07-14 against the real BOM
    database — SP_SysBom_PN_List(@ParentPartNumber) is the real proc (CONTEXT.md's assumed
    'SP_SysBom_PN_Query' does not exist)."""
    cn = connect(config)
    try:
        cur = cn.cursor()
        rows = call_read_only_proc(cur, "SP_SysBom_PN_List", (parent_part_number,))
        columns: list[str] = [d[0] for d in cur.description]
        return [dict(zip(columns, row)) for row in rows]
    finally:
        cn.close()


# SP_CRDspec_Query lives in MSFT_SKU, not BOM (confirmed 2026-07-14) — this connection's
# default database is BOM (_CONFIRMED_DATABASE), so the call must stay fully qualified.
_CRDSPEC_QUERY_PROC: Final[str] = "MSFT_SKU.dbo.SP_CRDspec_Query"


def get_crdspec_rows(spec_number: str, *, config: SqlConfig | None = None) -> list[dict[str, Any]]:
    """Read-only: CRD spec rows (Line/Group/Item/Model/MPN/Version/Notes) for a CRD spec
    number, e.g. the value in a SysBom row's ChildPartNumber for the CRD reference row."""
    cn = connect(config)
    try:
        cur = cn.cursor()
        rows = call_read_only_proc(cur, _CRDSPEC_QUERY_PROC, (spec_number,))
        columns: list[str] = [d[0] for d in cur.description]
        return [dict(zip(columns, row)) for row in rows]
    finally:
        cn.close()
