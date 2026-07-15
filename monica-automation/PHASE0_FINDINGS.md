# Phase 0 Findings — Environment Recon

Date: 2026-07-10
Recon performed from: dev laptop `WYMYOL54000395` (10.251.42.41), **not** the remote RDP
host originally named in the brief (`10.251.231.23`). See "Discrepancy" section — this
turned out not to matter for Phase 1.

No credentials appear anywhere in this document. Real values live only in the gitignored
`config/credentials/*.env` files at the repo root.

---

## 1. OS / Python / pip / PowerShell

Commands run on the dev laptop:

```
Write-Output "Hostname: $env:COMPUTERNAME"
ipconfig | Select-String "IPv4"
python --version
py -0
$PSVersionTable.PSVersion
pip --version
```

Output:

```
Hostname: WYMYOL54000395
IPv4 Address: 10.251.42.41
Python 3.13.0
 -V:3.13 *  Python 3.13 (64-bit)
 -V:3.12    Python 3.12 (64-bit)
PSVersion: 5.1.26100.8655
pip 26.0.1 from ...\Python313\Lib\site-packages\pip (python 3.13)
```

**Result:** Python 3.13 (and 3.12) plus pip are already installed and working on the dev
laptop. PowerShell 5.1 is present. Nothing here blocks Phase 1.

Not yet checked: whether Python is installed on the *original* remote host
(`10.251.231.23`) — moot for Phase 1, see below. Would still matter if Phase 4+ ever needs
to run somewhere that also drives the TPG GUI directly.

## 2. PLM API reachability (`plmkeymaker.wiwynn.com`)

```
Test-NetConnection -ComputerName plmkeymaker.wiwynn.com -Port 443
```

```
RemotePort: 443   TcpTestSucceeded: True
```

**Result:** reachable (TLS handshake only, no auth attempted) directly from the dev laptop.

## 3. SQL Server reachability

The brief names `MonicaMTE.wiwynn.com` on the SQLEXPRESS port (default 1433):

```
Test-NetConnection -ComputerName MonicaMTE.wiwynn.com -Port 1433
```
```
TcpTestSucceeded: False
```

**Not reachable** from the dev laptop at that name/port.

However, this repo already contains a working Node.js app (`BackEnd/DB.js`, part of the
existing unrelated `AI-BOMChecker` project) that connects to the same underlying BOM
database via a different address:

```
Test-NetConnection -ComputerName 10.251.231.65 -Port 1435
```
```
TcpTestSucceeded: True
```

**Result:** the actual SQL Server instance is reachable directly from the dev laptop at
`10.251.231.65:1435` — just not at the DNS name / default port the brief assumed. See
"Discrepancy" below. Only a TCP-level check was performed here (no login attempt).

Also checked, for the tunneling idea raised mid-session (rejected — see project decision
log): RDP (3389) to `10.251.231.65` is reachable; SSH (22) and WinRM (5985/5986) are not.
This confirms there is no scripted remote-execution path to that host from here — RDP
(human-driven) is the only remote access route if one is ever needed again.

## 4. SSPI / Integrated Security

**Not tested.** This requires an actual authenticated connection attempt (not just a TCP
check), which is an execution step, not a recon/planning one. Next action, before writing
any Phase 2 code: attempt `Integrated Security=SSPI` against `10.251.231.65:1435` using the
current domain identity, before ever falling back to a SQL-auth credential.

## 5. `MonicaTPGenerator.xml` fixture

Not fetched from any remote host — it, and the app itself, are already present locally in
this same repo at `@BOM-Based-APP/New MTPG/MonicaTPGenerator.xml`. Confirmed its
`SETTING/SQL` block matches the brief exactly:
`IP="MonicaMTE.wiwynn.com" NAME="WYHQ_SQL" LOCATION="WYHQ" IN="SQLEXPRESS"`.

Copied verbatim to `monica-automation/fixtures/MonicaTPGenerator.xml`.

---

## Discrepancy: the brief's "remote host only" assumption does not hold

The brief states the tool, PLM API, and SQL server are reachable *only* from a remote
Windows host over RDP. Recon shows:

- The PLM API is reachable directly from a normal corporate laptop.
- The SQL Server is also reachable directly from a normal corporate laptop — at
  `10.251.231.65:1435`, not `MonicaMTE.wiwynn.com:1433` as named in the brief. The DNS name
  may only resolve, or the named-instance browser (UDP 1434) may only respond, from within
  a more restricted segment — the raw IP:port bypasses that entirely.

**Open item, to close before Phase 2:** confirm `10.251.231.65:1435` is truly the same
`WYHQ_SQL` / `MSFT_SKU` instance the brief describes (the existing `BackEnd/DB.js` code
targets it with an empty `database` field and queries `bom.dbo.SysBom`, which is
consistent but not proof). Do this via an actual authenticated read-only query (e.g.
`SP_LocationTable_Model_Distinct`) once Phase 2 starts, not by assumption.

**Practical consequence:** Phase 1 (read-only PLM client) can be developed and largely
verified directly on the dev laptop. RDP to the remote host is very likely unnecessary
going forward, pending the SSPI/instance-identity confirmation above.

---

## Gate status: PASSED, with two carried-forward open items

1. SSPI vs. SQL-auth decision — test before Phase 2 write-adjacent (still read-only) code.
2. Confirm `10.251.231.65:1435` is the exact same instance as `MonicaMTE.wiwynn.com\SQLEXPRESS`
   before trusting Phase 2 QVL reads against it.

Proceeding to Phase 1 (`monica/plm_client.py`) per brief approval.
