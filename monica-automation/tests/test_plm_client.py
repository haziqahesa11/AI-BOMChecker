from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from monica.config import PlmConfig
from monica.models import PartLookupSource
from monica.plm_client import (
    PartNumberFormatError,
    PlmAuthError,
    get_part,
)

PRIMARY_URL = "https://plmkeymaker.example/APIFP/part/get-part-classification"
LEGACY_URL = "http://wpqssvr.example:8080/wpqs_plm/servlet/com.qpart.PartResult"


def make_config(tmp_path: Path, *, site_jwts: dict[str, str] | None = None) -> PlmConfig:
    return PlmConfig(
        primary_url=PRIMARY_URL,
        legacy_url=LEGACY_URL,
        cache_dir=tmp_path / "cache",
        timeout_seconds=1.0,
        max_retries=0,
        site_jwts=site_jwts if site_jwts is not None else {"PLM_JWT_TEST": "fake-jwt"},
        site_override="TEST",
    )


def client_with(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_malformed_pn_rejected_before_any_network_call(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no network call should happen for a malformed part number")

    config = make_config(tmp_path)
    with pytest.raises(PartNumberFormatError):
        get_part("M139124", config=config, client=client_with(handler))


def test_primary_success_returns_part_info_and_writes_cache(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == PRIMARY_URL
        assert request.headers["authorization"] == "fake-jwt"
        return httpx.Response(200, json={"partNumber": "M1391240-001", "generalDescription": "Widget"})

    config = make_config(tmp_path)
    result = get_part("M1391240-001", config=config, client=client_with(handler))

    assert result is not None
    assert result.general_description == "Widget"
    assert result.source == PartLookupSource.PLM_KEYMAKER

    cached = json.loads((tmp_path / "cache" / "M1391240-001.json").read_text())
    assert cached == {
        "found": True,
        "partNumber": "M1391240-001",
        "generalDescription": "Widget",
        "source": "plm_keymaker",
    }


def test_primary_well_formed_but_not_found_returns_none_cleanly(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"partNumber": "M9999999-001", "generalDescription": ""})

    config = make_config(tmp_path)
    result = get_part("M9999999-001", config=config, client=client_with(handler))

    assert result is None
    cached = json.loads((tmp_path / "cache" / "M9999999-001.json").read_text())
    assert cached == {"found": False, "partNumber": "M9999999-001"}


def test_primary_auth_failure_raises_and_does_not_fall_back(tmp_path: Path) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if str(request.url) == PRIMARY_URL:
            return httpx.Response(401, text="unauthorized")
        raise AssertionError("should not fall back to legacy on an auth failure")

    config = make_config(tmp_path)
    with pytest.raises(PlmAuthError):
        get_part("M1391240-001", config=config, client=client_with(handler))
    assert calls == [PRIMARY_URL]


def test_primary_unreachable_falls_back_to_legacy_success(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == PRIMARY_URL:
            raise httpx.ConnectError("connection refused", request=request)
        html = """
        <html><body><table>
          <tr><td>PART NUMBER</td><td>M1391240-001</td></tr>
          <tr><td>GENERAL DESCRIPTION</td><td>Widget (legacy)</td></tr>
        </table></body></html>
        """
        return httpx.Response(200, text=html)

    config = make_config(tmp_path)
    result = get_part("M1391240-001", config=config, client=client_with(handler))

    assert result is not None
    assert result.general_description == "Widget (legacy)"
    assert result.source == PartLookupSource.WISTRON_LEGACY


def test_no_jwt_configured_falls_back_to_legacy(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == LEGACY_URL, "primary should be skipped, not called, with no JWT"
        html = "<html><body><table><tr><td>GENERAL DESCRIPTION</td><td>Widget</td></tr></table></body></html>"
        return httpx.Response(200, text=html)

    config = make_config(tmp_path, site_jwts={})
    result = get_part("M1391240-001", config=config, client=client_with(handler))

    assert result is not None
    assert result.source == PartLookupSource.WISTRON_LEGACY


def test_cache_hit_skips_network_entirely(tmp_path: Path) -> None:
    config = make_config(tmp_path)
    config.cache_dir.mkdir(parents=True)
    (config.cache_dir / "M1391240-001.json").write_text(
        json.dumps(
            {
                "found": True,
                "partNumber": "M1391240-001",
                "generalDescription": "Cached widget",
                "source": "plm_keymaker",
            }
        )
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("cache hit should skip the network entirely")

    result = get_part("M1391240-001", config=config, client=client_with(handler))
    assert result is not None
    assert result.general_description == "Cached widget"
