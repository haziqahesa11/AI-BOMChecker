"""Shared HTTP client for polling/reporting automation jobs against
BackEnd/server.js's /api/automation/jobs* queue. Used by both the QVL and
Test BOM autofill paths — see qvl_autofill_agent.py's module docstring for
the write-gate discipline both must follow (fill only, never submit)."""
from __future__ import annotations

from dataclasses import dataclass

import httpx

from .config import AgentConfig


@dataclass(frozen=True)
class Job:
    job_id: str
    job_type: str  # 'qvl_autofill' | 'test_bom_autofill'
    model_ref: str
    part_number: str
    location: str | None = None
    description: str | None = None


def fetch_next_job(client: httpx.Client, config: AgentConfig) -> Job | None:
    resp = client.get(
        f"{config.backend_base_url}/api/automation/jobs/next",
        headers={"Authorization": f"Bearer {config.agent_token}"},
        timeout=10,
    )
    if resp.status_code == 204:
        return None
    resp.raise_for_status()
    body = resp.json()
    return Job(
        job_id=body["jobId"],
        # default keeps compatibility with any already-queued job created
        # before jobType existed on the backend.
        job_type=body.get("jobType", "qvl_autofill"),
        model_ref=body["modelRef"],
        part_number=body["partNumber"],
        location=body.get("location"),
        description=body.get("description"),
    )


def report_result(client: httpx.Client, config: AgentConfig, job_id: str, status: str, detail: str) -> None:
    client.post(
        f"{config.backend_base_url}/api/automation/jobs/{job_id}/result",
        json={"status": status, "detail": detail},
        headers={"Authorization": f"Bearer {config.agent_token}"},
        timeout=10,
    )
