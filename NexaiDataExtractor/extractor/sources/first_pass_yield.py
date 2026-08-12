"""First Pass Yield has two very different shapes upstream (see
BackEnd/services/firstPassYieldService.js):

- `run_summary` — /api/first-pass-yield/summary is a pre-aggregated weekly rollup per
  (model, environment). It is NOT append-only: a week's counts can be revised as
  trailing retests land for a still-open week, so it's treated as a snapshot, diffed
  by (model, environment, weekStart), not deduped by first-seen-key. It's small
  (~1 row per model/environment/week since the epoch) and already fully aggregated
  server-side, so one fetch per (model, environment) combo covers all of history —
  no date-chunking needed here, unlike the event sources.
- `run_blade_raw` — /api/first-pass-yield/blade is raw sfcusninfo.* rows (`s.*` in the
  SQL), whose full column set isn't known ahead of time from reading the service code
  alone. Columns are therefore rendered dynamically (whatever keys each row actually
  has), rather than a hardcoded list that might silently drop real data.
"""
from __future__ import annotations

from datetime import date

from ..event_source import run_event_source
from ..snapshot_source import run_snapshot_source
from ..types import RunContext, SourceResult

# Mirrors Frontend/src/components/FirstPassYieldPage.jsx's MODELS/ENVIRONMENTS —
# BSL stays excluded there ("BSL FPY not available yet"), so it's excluded here too.
_MODELS = ["GEN9", "GEN8"]
_ENVIRONMENTS = ["MFG", "MDAAS"]

_SUMMARY_COLUMNS = ["model", "environment", "weekStart", "weekLabel", "withFail", "withoutFail", "total", "pctWithoutFail"]


def _summary_key(row: dict) -> str:
    return f"{row.get('model')}|{row.get('environment')}|{row.get('weekStart')}"


def _summary_group(row: dict) -> str:
    return f"{row.get('model')} / {row.get('environment')}"


def run_summary(ctx: RunContext) -> SourceResult:
    def fetch_all(client) -> list[dict]:
        rows: list[dict] = []
        for model in _MODELS:
            for environment in _ENVIRONMENTS:
                body, _url = client.get_json(
                    "/api/first-pass-yield/summary",
                    params={
                        "from": ctx.config.history_epoch.isoformat(),
                        "to": ctx.today.isoformat(),
                        "model": model,
                        "environment": environment,
                    },
                )
                for week in body.get("weeks", []):
                    rows.append({"model": model, "environment": environment, **week})
        return rows

    return run_snapshot_source(
        ctx,
        source="fpy_summary",
        title="First Pass Yield — Weekly Summary",
        endpoint="/api/first-pass-yield/summary",
        fetch_all=fetch_all,
        key_fn=_summary_key,
        columns=_SUMMARY_COLUMNS,
        group_fn=_summary_group,
        query={"from": ctx.config.history_epoch.isoformat(), "to": ctx.today.isoformat(), "models": _MODELS, "environments": _ENVIRONMENTS},
    )


def _blade_key(row: dict) -> str:
    return f"{row.get('usn')}|{row.get('infoname')}|{row.get('trndate')}"


def _blade_group(row: dict) -> str:
    return f"USN {row.get('usn')}"


def run_blade_raw(ctx: RunContext) -> SourceResult:
    def fetch_page(client, frm: date, to: date) -> list[dict]:
        body, _url = client.get_json(
            "/api/first-pass-yield/blade", params={"from": frm.isoformat(), "to": to.isoformat()}
        )
        return body.get("rows", [])

    return run_event_source(
        ctx,
        source="fpy_blade_raw",
        title="First Pass Yield — Raw Blade Fail Data",
        endpoint="/api/first-pass-yield/blade",
        fetch_page=fetch_page,
        key_fn=_blade_key,
        group_fn=_blade_group,
        columns=None,  # schema not fully known ahead of time — render whatever keys each row has
    )
