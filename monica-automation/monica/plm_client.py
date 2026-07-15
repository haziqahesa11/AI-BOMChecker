from __future__ import annotations

import json
import logging
import re
import socket
import time
from pathlib import Path
from typing import Callable, Final

import httpx
from lxml import html as lxml_html

from .config import PlmConfig, load_plm_config
from .models import PartInfo, PartLookupSource

logger = logging.getLogger("monica.plm_client")


class PartNumberFormatError(ValueError):
    """Raised when a part number matches none of the app's known grammars."""


class PlmAuthError(RuntimeError):
    """Raised when the PLM API rejects the request (missing/invalid/expired JWT)."""


class PlmConfigError(RuntimeError):
    """Raised when no JWT can be resolved for the current site and there is no override."""


class PlmNetworkError(RuntimeError):
    """Raised when a PLM backend could not be reached after retries."""


# Grammars from CONTEXT.md ("Part-number grammars enforced by the app"). Each may carry
# a "$xxxx" sub-PN suffix.
_PN_PATTERNS: Final[list[re.Pattern[str]]] = [
    re.compile(r"^M\d{7}-\d{3}(\$\w+)?$"),
    re.compile(r"^M\d{7}-00\d(\$\w+)?$"),
    re.compile(r"^M\d{7}(\$\w+)?$"),
    re.compile(r"^X\d{6}-\d{3}(\$\w+)?$"),
    re.compile(r"^MSF-\d{6}(\$\w+)?$"),
    re.compile(r"^B\d{2}\.\S+$"),
    re.compile(r"^BCS\.\S+$"),
]

# IP prefix -> JWT env var name, per CONTEXT.md. Multiple sites share the WYHQ_VCS token.
_SITE_JWT_BY_PREFIX: Final[dict[str, str]] = {
    "10.32.": "PLM_JWT_WYMX",
    "10.34.": "PLM_JWT_WZS",
    "10.35.": "PLM_JWT_WYTN",
    "10.37.": "PLM_JWT_WCZ",
    "10.41.": "PLM_JWT_WYHQ_VCS",
    "10.49.": "PLM_JWT_WYHQ_VCS",
    "10.82.": "PLM_JWT_WYHQ_VCS",
    "10.248.": "PLM_JWT_WYHQ_VCS",
    "10.249.": "PLM_JWT_WYHQ_VCS",
    "10.250.": "PLM_JWT_WYHQ_VCS",
}

_NOT_FOUND_MARKER: Final[str] = "No Part Number Description from PLM system!"


def validate_part_number(pn: str) -> str:
    """Reject malformed part numbers before any network call."""
    candidate = pn.strip()
    if candidate and any(p.match(candidate) for p in _PN_PATTERNS):
        return candidate
    raise PartNumberFormatError(f"{pn!r} does not match any known part-number grammar")


def _local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return str(s.getsockname()[0])
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def _resolve_jwt(config: PlmConfig) -> str:
    """Pick the site JWT for the current host, or raise PlmConfigError with a clear reason."""
    site_code = config.site_override
    env_key: str | None
    if site_code:
        env_key = f"PLM_JWT_{site_code}"
    else:
        ip = _local_ip()
        env_key = next((v for prefix, v in _SITE_JWT_BY_PREFIX.items() if ip.startswith(prefix)), None)
        if env_key is None:
            raise PlmConfigError(
                f"host IP {ip} does not match any known site prefix, and PLM_SITE_CODE is not "
                "set in config/credentials/plm.env — set it explicitly when running off-site"
            )

    jwt = config.site_jwts.get(env_key)
    if not jwt:
        raise PlmConfigError(
            f"{env_key} is not set in config/credentials/plm.env — ask the tool owner "
            "(ChingAn@WYHQ #7050) for a valid JWT before calling the primary PLM API"
        )
    return jwt


def _cache_path(cache_dir: Path, pn: str) -> Path:
    safe_name = re.sub(r"[^\w.-]", "_", pn)
    return cache_dir / f"{safe_name}.json"


def _read_cache(cache_dir: Path, pn: str) -> tuple[bool, PartInfo | None]:
    """Returns (cache_hit, value). value is None either for a cache miss or a cached not-found."""
    path = _cache_path(cache_dir, pn)
    if not path.exists():
        return False, None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not data.get("found", False):
        return True, None
    return True, PartInfo(
        part_number=data["partNumber"],
        general_description=data["generalDescription"],
        source=PartLookupSource(data["source"]),
    )


def _write_cache(cache_dir: Path, pn: str, info: PartInfo | None) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = _cache_path(cache_dir, pn)
    if info is None:
        payload = {"found": False, "partNumber": pn}
    else:
        payload = {
            "found": True,
            "partNumber": info.part_number,
            "generalDescription": info.general_description,
            "source": info.source.value,
        }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _with_retry(fn: Callable[[], httpx.Response], *, max_retries: int, backoff_seconds: float = 1.0) -> httpx.Response:
    last_exc: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last_exc = exc
            logger.warning("plm request attempt %d failed: %s", attempt + 1, type(exc).__name__)
            if attempt < max_retries:
                time.sleep(backoff_seconds)
    assert last_exc is not None
    raise last_exc


def _query_primary(pn: str, config: PlmConfig, client: httpx.Client) -> PartInfo | None:
    jwt = _resolve_jwt(config)

    def _do_request() -> httpx.Response:
        return client.post(
            config.primary_url,
            json={"partNumber": pn},
            headers={"Authorization": jwt},
            timeout=config.timeout_seconds,
        )

    try:
        response = _with_retry(_do_request, max_retries=config.max_retries)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise PlmNetworkError(f"primary PLM API unreachable: {exc}") from exc

    if response.status_code in (401, 403):
        raise PlmAuthError(f"primary PLM API rejected the request (HTTP {response.status_code})")
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise PlmNetworkError(f"primary PLM API returned unexpected HTTP {response.status_code}")

    body = response.json()
    description = body.get("generalDescription")
    if not description or _NOT_FOUND_MARKER in str(description):
        return None
    return PartInfo(
        part_number=body.get("partNumber", pn),
        general_description=description,
        source=PartLookupSource.PLM_KEYMAKER,
    )


def _extract_legacy_field(tree: lxml_html.HtmlElement, label: str) -> str | None:
    for row in tree.xpath("//table//tr"):
        cells = [str(c.text_content()).strip() for c in row.xpath("./td")]
        for i, cell in enumerate(cells[:-1]):
            if cell.upper().rstrip(":") == label.upper():
                return cells[i + 1]
    return None


def _query_legacy(pn: str, config: PlmConfig, client: httpx.Client) -> PartInfo | None:
    def _do_request() -> httpx.Response:
        return client.post(
            config.legacy_url,
            data={"T1": pn, "T2": "", "T3": "", "T4": "", "T5": "", "T6": "", "B1": "Query"},
            timeout=config.timeout_seconds,
        )

    try:
        response = _with_retry(_do_request, max_retries=config.max_retries)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        raise PlmNetworkError(f"legacy PLM servlet unreachable: {exc}") from exc

    if response.status_code != 200:
        raise PlmNetworkError(f"legacy PLM servlet returned unexpected HTTP {response.status_code}")

    if _NOT_FOUND_MARKER in response.text:
        return None

    tree = lxml_html.fromstring(response.text)
    description = _extract_legacy_field(tree, "GENERAL DESCRIPTION")
    if not description:
        return None
    found_pn = _extract_legacy_field(tree, "PART NUMBER") or pn
    return PartInfo(
        part_number=found_pn,
        general_description=description,
        source=PartLookupSource.WISTRON_LEGACY,
    )


def get_part(
    pn: str,
    *,
    config: PlmConfig | None = None,
    client: httpx.Client | None = None,
    use_cache: bool = True,
) -> PartInfo | None:
    """Look up a part number's description. Read-only; nothing is ever written to the DB.

    Raises PartNumberFormatError for malformed input (before any network call),
    PlmAuthError if the primary API rejects our credentials, PlmConfigError if no
    JWT is configured for this site, and PlmNetworkError if neither backend is
    reachable. Returns None for a well-formed PN that genuinely isn't found.
    """
    pn = validate_part_number(pn)
    config = config or load_plm_config()

    if use_cache:
        hit, cached = _read_cache(config.cache_dir, pn)
        if hit:
            logger.info("cache hit for %s", pn)
            return cached

    owns_client = client is None
    client = client or httpx.Client()
    try:
        try:
            result = _query_primary(pn, config, client)
            logger.info("primary lookup for %s: %s", pn, "found" if result else "not found")
        except (PlmNetworkError, PlmConfigError) as exc:
            logger.warning("primary PLM path unavailable for %s (%s); falling back to legacy", pn, exc)
            result = _query_legacy(pn, config, client)
            logger.info("legacy lookup for %s: %s", pn, "found" if result else "not found")
    finally:
        if owns_client:
            client.close()

    if use_cache:
        _write_cache(config.cache_dir, pn, result)
    return result
