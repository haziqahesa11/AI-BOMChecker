from __future__ import annotations

import httpx

from agent.config import AgentConfig
from agent.job_client import Job, fetch_next_job, report_result

BACKEND_URL = "http://backend.example:3000"


def make_config() -> AgentConfig:
    return AgentConfig(
        backend_base_url=BACKEND_URL,
        poll_interval_seconds=0.01,
        tpg_exe_path=r"C:\Tools\MonicaTPGenerator\MonicaTPGenerator.exe",
        agent_token="test-token",
    )


def client_with(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_next_job_returns_none_on_204() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == f"{BACKEND_URL}/api/automation/jobs/next"
        assert request.headers["authorization"] == "Bearer test-token"
        return httpx.Response(204)

    with client_with(handler) as client:
        assert fetch_next_job(client, make_config()) is None


def test_fetch_next_job_parses_qvl_autofill_job() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "jobId": "1",
                "jobType": "qvl_autofill",
                "modelRef": "C2195_L10",
                "location": "L10",
                "partNumber": "M1391239-001$162",
                "description": "L10 C2195 MP GEN9.5 HH MSF-119642",
            },
        )

    with client_with(handler) as client:
        job = fetch_next_job(client, make_config())

    assert job == Job(
        job_id="1",
        job_type="qvl_autofill",
        model_ref="C2195_L10",
        location="L10",
        part_number="M1391239-001$162",
        description="L10 C2195 MP GEN9.5 HH MSF-119642",
    )


def test_fetch_next_job_defaults_missing_job_type_to_qvl_autofill() -> None:
    """Backward compatibility: jobs queued before jobType existed on the backend."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "jobId": "1",
                "modelRef": "C2195_L10",
                "location": "L10",
                "partNumber": "M1391239-001$162",
                "description": None,
            },
        )

    with client_with(handler) as client:
        job = fetch_next_job(client, make_config())

    assert job.job_type == "qvl_autofill"


def test_fetch_next_job_parses_test_bom_autofill_job() -> None:
    """Test BOM jobs have no 'location'/'description' — resolved per-location from DB."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "jobId": "2",
                "jobType": "test_bom_autofill",
                "modelRef": "C2012_L11",
                "partNumber": "B81.04E01.0001",
            },
        )

    with client_with(handler) as client:
        job = fetch_next_job(client, make_config())

    assert job == Job(
        job_id="2",
        job_type="test_bom_autofill",
        model_ref="C2012_L11",
        part_number="B81.04E01.0001",
        location=None,
        description=None,
    )


def test_report_result_posts_status_and_detail() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == f"{BACKEND_URL}/api/automation/jobs/1/result"
        assert request.headers["authorization"] == "Bearer test-token"
        body = httpx.Request("POST", request.url, content=request.content).content
        assert b'"status":"filled"' in body or b'"status": "filled"' in body
        return httpx.Response(200, json={"ok": True})

    with client_with(handler) as client:
        report_result(client, make_config(), "1", "filled", "QVL tab populated")
