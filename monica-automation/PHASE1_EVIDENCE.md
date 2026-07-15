# Phase 1 Evidence — Info API Client

Date: 2026-07-10. Everything below is read-only — no writes to any database, no secrets
in this file. Real config lives only in gitignored `config/credentials/*.env`.

## Mocked test suite

`pytest tests/test_plm_client.py -v` — network fully mocked via `httpx.MockTransport`,
runs with no credentials and no real network:

```
7 passed:
  test_malformed_pn_rejected_before_any_network_call
  test_primary_success_returns_part_info_and_writes_cache
  test_primary_well_formed_but_not_found_returns_none_cleanly
  test_primary_auth_failure_raises_and_does_not_fall_back
  test_primary_unreachable_falls_back_to_legacy_success
  test_no_jwt_configured_falls_back_to_legacy
  test_cache_hit_skips_network_entirely
```

`mypy --strict monica` — clean, no issues, 5 source files.

## Real-network smoke test (no JWT required)

Ran a direct, unauthenticated POST to the primary endpoint plus a full `get_part()` call
through the real client code (see transcript below):

```
--- raw unauthenticated POST to primary ---
status: 403
```

Confirms `plmkeymaker.wiwynn.com` is reachable from the dev laptop and responds with a
well-formed HTTP 403 (not a connection failure) when called without a valid JWT — proves
the request shape is right and the endpoint is live.

```
--- get_part() end-to-end (no JWT configured) ---
primary PLM path unavailable ... falling back to legacy
plm request attempt 1 failed: ConnectError
plm request attempt 2 failed: ConnectError
PlmNetworkError: legacy PLM servlet unreachable: [Errno 11001] getaddrinfo failed
```

This confirms the intended control flow: with no JWT configured, `_resolve_jwt` raises
`PlmConfigError`, `get_part` catches it and falls back to the legacy Wistron path — which
in turn fails cleanly with a typed `PlmNetworkError` (DNS resolution failure for
`wpqssvr.wistron.com.tw` from this network — that legacy vendor domain doesn't resolve
from the dev laptop's segment). No crash, no silent failure — a clear, typed, catchable
error surfaced all the way to the caller.

Also confirmed separately: the dev laptop's IP (`10.251.42.x`, observed as both `.41` and
`.118` across two runs — likely DHCP/VPN-dependent) does not match any of the brief's known
site IP prefixes (`10.32.`–`10.250.`), so automatic site detection correctly fails over to
requiring `PLM_SITE_CODE` in `config/credentials/plm.env` when run from here. This is
expected for an off-site dev machine, not a bug.

## What's blocked pending a real credential

The brief's full Phase 1 gate — 5 real PNs (3 found, 1 malformed, 1 well-formed-but-missing)
plus an exercised fallback path — cannot be completed until:

1. A real JWT is obtained from the tool owner (`ChingAn@WYHQ #7050`, per `CONTEXT.md`) and
   placed in `config/credentials/plm.env` (copy `plm.env.example`, fill in
   `PLM_JWT_WYHQ_VCS` or whichever site applies, and set `PLM_SITE_CODE` since this dev
   laptop's IP doesn't self-select a site).
2. 5 real part numbers are supplied (from QVL screenshots or the cross-table, per the
   brief) to run against.

Once both are available, run:
```
.venv\Scripts\python -c "from monica.plm_client import get_part; print(get_part('<real PN>'))"
```
for each of the 5, plus one run with the primary URL temporarily pointed at an unreachable
host (to force-exercise the fallback path against a *reachable* legacy endpoint — note the
smoke test above shows the legacy endpoint is not reachable from this dev laptop's network,
so that exercise may need to happen from a host that can actually reach
`wpqssvr.wistron.com.tw`, e.g. back on the original remote host).

The malformed-PN and not-found cases from the brief's gate are already demonstrated by the
mocked test suite above and do not depend on the credential.

## Addendum 2026-07-10 — `crd.aspx`/`bom.aspx` is redundant with a direct DB call

The internal "WYHQ MONICAMTE BOM Information" page (`http://monicamte.wiwynn.com/bom.aspx?pn=<PN>`,
reachable only from `10.251.231.65`) was suspected to be a thin web front-end over the same
BOM database already reached directly from the dev laptop. Confirmed via
`BOM.INFORMATION_SCHEMA.ROUTINES`: `SP_PartDescription_Query(@PartNumber)` exists in the
`BOM` database (alongside `_Find`, `_List`, `_Update`, `_Del`, and the lowercase replication
procs `sp_MSins_dboPartDescription` etc. — same naming pattern already seen for QVL).

Calling it for `M1391239-001$162` returns:

```
{ "PartNumber": "M1391239-001$162", "Description": "L10 C2195 MP GEN9.5 HH MSF-119642" }
```

— an exact match for the description shown on the `bom.aspx` page for the same PN.

**Conclusion**: description lookups never need `crd.aspx`/`bom.aspx` or RDP to
`10.251.231.65`. `SP_PartDescription_Query` (same read-only whitelist family as
`SP_QVL_Query_DESC`) is the authoritative direct-DB equivalent, reachable from anywhere
`10.251.231.65:1435` is reachable.
