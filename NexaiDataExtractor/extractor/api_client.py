"""Thin httpx wrapper around the AI-BOM REST API, with retry/backoff (same shape as
monica-automation/monica/plm_client.py's _with_retry) and an explicit check that the
response is actually JSON.

Why the JSON check matters here specifically: BackEnd/server.js registers a SPA
catch-all (`app.get('*', ...)` -> index.html) AFTER all /api/* routes. If a route
this extractor calls doesn't exist on whatever build is currently deployed, Express
falls through to that catch-all and returns HTTP 200 with the app's own index.html —
not a 404. Confirmed live 2026-08 against the ai-bom-online deployment: /api/models
and /api/crd-tracker/* returned real JSON, but /api/cycle-time/*, /api/first-pass-
yield/*, /api/tpa-history, and /api/golden-template/* all came back as HTML (older
build, missing those routes). Silently parsing that HTML as if it were an empty JSON
result would corrupt the dedup ledger, so every response is checked for a JSON
content-type before .json() is even attempted; a non-JSON response raises
EndpointUnavailableError, which callers treat as "this source isn't live yet" rather
than a crash — see extractor/event_source.py and extractor/snapshot_source.py.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx

logger = logging.getLogger("extractor.api_client")


class EndpointUnavailableError(RuntimeError):
    """The endpoint didn't return JSON — most likely not present on the deployed build yet."""


class ApiClient:
    def __init__(
        self,
        base_url: str,
        *,
        timeout: float = 30.0,
        max_retries: int = 3,
        backoff_seconds: float = 2.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(timeout=timeout)
        self.max_retries = max_retries
        self.backoff_seconds = backoff_seconds

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "ApiClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def _send(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        url = f"{self.base_url}{path}"
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                return self._client.request(method, url, **kwargs)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_exc = exc
                logger.warning("%s %s attempt %d failed: %s", method, url, attempt + 1, exc)
                if attempt < self.max_retries:
                    time.sleep(self.backoff_seconds * (2**attempt))
        assert last_exc is not None
        raise last_exc

    def _request_json(self, method: str, path: str, **kwargs: Any) -> tuple[Any, str]:
        resp = self._send(method, path, **kwargs)
        full_url = str(resp.request.url)
        content_type = resp.headers.get("content-type", "")
        if "json" not in content_type:
            raise EndpointUnavailableError(
                f"{method} {full_url} returned content-type={content_type or '(none)'} "
                f"(HTTP {resp.status_code}) instead of JSON — this route is likely not on "
                "the currently-deployed backend build yet."
            )
        try:
            body = resp.json()
        except ValueError as exc:
            raise EndpointUnavailableError(f"{method} {full_url} returned invalid JSON: {exc}") from exc
        if resp.status_code >= 400:
            raise RuntimeError(f"{method} {full_url} -> HTTP {resp.status_code}: {body}")
        return body, full_url

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> tuple[Any, str]:
        return self._request_json("GET", path, params=params)

    def post_json(self, path: str, json_body: dict[str, Any] | None = None) -> tuple[Any, str]:
        return self._request_json("POST", path, json=json_body)
