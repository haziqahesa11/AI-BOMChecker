from __future__ import annotations

import httpx
import respx

from extractor.api_client import ApiClient, EndpointUnavailableError


@respx.mock
def test_get_json_success():
    respx.get("http://test.local/api/models").mock(return_value=httpx.Response(200, json={"models": []}))
    client = ApiClient("http://test.local")
    body, url = client.get_json("/api/models")
    assert body == {"models": []}
    assert url == "http://test.local/api/models"
    client.close()


@respx.mock
def test_html_fallback_raises_endpoint_unavailable():
    respx.get("http://test.local/api/cycle-time/l11").mock(
        return_value=httpx.Response(200, headers={"content-type": "text/html; charset=UTF-8"}, text="<html></html>")
    )
    client = ApiClient("http://test.local")
    try:
        client.get_json("/api/cycle-time/l11")
        assert False, "expected EndpointUnavailableError"
    except EndpointUnavailableError as exc:
        assert "text/html" in str(exc)
    client.close()


@respx.mock
def test_retries_then_succeeds():
    route = respx.get("http://test.local/api/models")
    route.side_effect = [httpx.TimeoutException("boom"), httpx.Response(200, json={"ok": True})]
    client = ApiClient("http://test.local", backoff_seconds=0.01)
    body, _url = client.get_json("/api/models")
    assert body == {"ok": True}
    assert route.call_count == 2
    client.close()


@respx.mock
def test_server_error_raises_runtime_error():
    respx.get("http://test.local/api/models").mock(
        return_value=httpx.Response(500, json={"error": "boom"})
    )
    client = ApiClient("http://test.local")
    try:
        client.get_json("/api/models")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "500" in str(exc)
    client.close()
