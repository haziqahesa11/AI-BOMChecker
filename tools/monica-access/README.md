# Monica TPG/TPA access — decision record

## Status: Option 1 (run the client locally) — PARTIALLY WORKING, blocked on domain trust

**Correction (2026-07-15, later same day):** this doc originally said Option
1 was "CONFIRMED WORKING" based on the QVL tab's Model Reference dropdown
populating with real model codes after the IP fix below. That proof was
flawed — the Model Reference list (and the Test BOM tab's Location/Type/
Remark columns) are read from the **local** `MonicaTPGenerator.xml` file
(`CONFIGURATION/MODEL/...`), not a live SQL query, so a populated dropdown
never actually proved SQL authentication worked. See "Second blocker" below
for what actually happened when a real live-data path was checked.

The IP fix itself is still correct and necessary — see "Root cause" and
"The fix" below — it's just not sufficient on its own for anything that
needs live per-part data (Test BOM CPN/Revision, CRD Spec/FRU Spec/Rack SKU,
and very likely the actual DB write when a human clicks ADD/MODIFY/Submit).

## Root cause

TPG (and TPA) are fat WinForms clients — all data comes from SQL Server, the
target for which is read from `MonicaTPGenerator.xml` /
`MonicaTPApprover.xml`, which must sit next to the `.exe`. Both shipped with:

```xml
<SQL IP="MonicaMTE.wiwynn.com" NAME="WYHQ_SQL" LOCATION="WYHQ" IN="SQLEXPRESS" />
```

`MonicaMTE.wiwynn.com` is a dead DNS name from this laptop's network — it
resolves, but to an IP that never answers for that SQL instance. The real
`SQLEXPRESS` instance TPG needs lives at a different, directly-reachable
address.

## Test evidence (run 2026-07-15, from a normal corporate laptop on OA_LAN)

```
.NET Framework: 4.8.09221 (Release 533509) — present, TPG's runtime prereq is met.

Resolve-DnsName MonicaMTE.wiwynn.com
  -> 10.248.36.247

Test-NetConnection MonicaMTE.wiwynn.com -Port 1433
  -> TcpTestSucceeded: False

UDP 1434 (SQL Browser) probe to 10.248.36.247 (i.e. MonicaMTE.wiwynn.com)
  -> timed out, no response

Test-NetConnection 10.251.231.65 -Port 1435
  -> TcpTestSucceeded: True

UDP 1434 (SQL Browser) probe to 10.251.231.65
  -> ServerName;WYMY_DDNS6;InstanceName;SQLEXPRESS;IsClustered;No;Version;11.0.5058.0;tcp;1435;
```

The SQL Browser response is the smoking gun: it reports the exact named
instance TPG's config asks for (`SQLEXPRESS`, at `10.251.231.65`, dynamic
port `1435`) — `MonicaMTE.wiwynn.com` simply no longer points at that
machine. `10.251.231.65` also matches `ServerName=WYMY_DDNS6`, which lines
up with the "DDNS machine" reference already noted in
`monica-automation/CONTEXT.md` and the `10.251.231.65:1435` reachability
already recorded in `monica-automation/PHASE0_FINDINGS.md`.

## The fix

In `@BOM-Based-APP/New MTPG/MonicaTPGenerator.xml`, change the `SQL` line's
`IP` attribute from the dead DNS name to the working address — leave
`NAME`, `LOCATION`, `IN` untouched (same instance, just a corrected network
address):

```xml
<SQL IP="10.251.231.65" NAME="WYHQ_SQL" LOCATION="WYHQ" IN="SQLEXPRESS" />
```

Close any already-running `MonicaTPGenerator.exe` first — the config is only
read at startup — then relaunch it. Verified live 2026-07-15: the QVL tab's
Model Reference dropdown populates with real models
(`C1042_L10`, `C2012_L11`, ...), where it was previously empty.

## Setup for another engineer

1. Pull this repo; TPG/TPA live at `@BOM-Based-APP/New MTPG/`.
2. Confirm the `SQL IP` attribute in `MonicaTPGenerator.xml` already reads
   `10.251.231.65` (should already be fixed on `main`; if you're on an older
   checkout, apply the one-line edit above).
3. Launch `MonicaTPGenerator.exe`. The QVL tab's Model Reference dropdown
   should populate immediately — that's your proof the SQL round-trip works.
4. If it comes up empty, re-run the network tests above from your machine
   first (DNS/firewall rules can differ by network segment) before assuming
   the fix itself is wrong.

## Second blocker found later the same day: SSPI login fails from an untrusted domain

**Symptom** (reported by a user comparing an RDP session into `.65` against
this laptop's local TPG, both on the same PN): via RDP, TPG's Test BOM tab
shows a fully populated grid (real CPN/Revision per location, green cells)
plus three extra sub-tabs — `CRD Spec.`, `FRU Spec.`, `Rack SKU`. Locally,
only the `Data` sub-tab exists at all (confirmed via `pywinauto` — the inner
`tabCtlTestBOM` TabControl has exactly one `TabPage`, `tabTestBOMdata`; the
other three were never constructed, not just hidden), and every CPN cell is
red/unset even for a PN that has a fully-populated BOM in the database.

**Root-caused, not guessed:**

1. Queried `bom.dbo.SysBom` directly (via `BackEnd/DB.js`'s existing,
   already-working SQL-auth connection) for the exact PN shown in both
   screenshots (`M1391240-001$Y3105`): **69 rows**, and `B03`'s
   `ChildPartNumber` is `M1391239-001$105` — an exact match for what the RDP
   session's TPG displays. **The data is on the same server the IP fix
   points at.** This is not a wrong-server or missing-data problem.
2. Tested Windows Integrated Security (SSPI) directly against the same
   server — the same auth mode TPG uses (`Integrated Security=SSPI` per
   `CONTEXT.md`'s documented connection strings), as opposed to the SQL-auth
   username/password `BackEnd/DB.js` uses:
   ```
   DRIVER={SQL Server};SERVER=10.251.231.65\SQLEXPRESS;DATABASE=BOM;Trusted_Connection=yes;
   ->  Login failed. The login is from an untrusted domain and cannot be
       used with Windows authentication. (18452)
   ```
3. This laptop's domain: `WIWYNN.CORP` (`$env:USERDNSDOMAIN`). That domain
   is not trusted for Windows Authentication by whatever domain/context the
   SQL Server validates Windows logins against. An RDP session running
   directly *on* `.65` doesn't hit this — it authenticates within that
   machine's own (trusted) context instead of presenting a cross-network
   Windows token.

**What this means in practice:** TPG's QVL-tab field-*filling* (Model
Reference, Location, PN, Description) still works fine locally, because
those values are either local-XML-sourced or are typed/selected directly by
the automation agent — no live TPG-side SQL read is involved in filling
them. But anything that needs TPG itself to read or write live data —
Test BOM CPN/Revision population, the CRD Spec/FRU Spec/Rack SKU tabs, the
QVL tab's own "QVL Checking" listbox, and very likely the actual database
write the instant a human clicks `ADD / MODIFY` or `Submit` — will not work
locally until this is resolved, since TPG has no SQL-auth (username/
password) UI path exposed anywhere (the `SQL` tab only shows read-only
labels: target server address and site name, no credential fields).

**No UI dropdown in TPG has ever proven live SQL access.** If re-verifying
this in the future, don't trust a populated Model Reference list — check
whether the Test BOM tab's CPN cells for a known-populated PN come back
green, or whether `CRD Spec.` / `FRU Spec.` / `Rack SKU` sub-tabs exist at
all.

**Next steps, not yet taken:**
- File an IT/AD ticket: request a domain trust (or equivalent) so
  `WIWYNN.CORP`-joined laptops can authenticate via Windows Integrated
  Security against whichever domain `10.251.231.65`'s `SQLEXPRESS` instance
  validates against. This is the actual fix, if IT can grant it.
- Ask the DB/infra owner whether SQL (Mixed Mode) authentication could be
  enabled for TPG's own use — moot unless TPG.exe itself has a working
  SQL-auth code path; its own SQL tab currently exposes no credential
  fields, so this may require a build change on Wiwynn's side, not just a
  server-side permission grant.
- Until one of the above lands, real BOM-building work needs Option 2 (RDP
  RemoteApp) or Option 3 (plain RDP) — see below — even though Option 1
  remains useful for developing/testing the *automation mechanics*
  (auto-launch, field-filling) against locally-visible controls.

## Open item — not yet resolved

Whether `10.251.231.65` is the *sanctioned, permanent* address for this SQL
instance, or a coincidentally-still-reachable IP that could move, is
unconfirmed. `PHASE0_FINDINGS.md` already flagged this as open. Worth a
short confirmation from the DB/infra owner (and, separately, an IT ticket to
either fix or retire the dead `MonicaMTE.wiwynn.com` DNS record) before
treating this as permanent. Until then, if TPG stops loading data again,
re-run the SQL Browser probe above before assuming the app itself broke.

`MonicaTPApprover.xml` (TPA, the separate approval tool) ships with the
exact same dead DNS name in its `SQL` block. Not changed as part of this
work — TPA isn't part of the automated flow this repo drives — but it will
hit the identical empty-dropdown symptom until someone applies the same
one-line fix there.

## Options 2 (RDP RemoteApp) and 3 (plain RDP) — not pursued

Option 1 met its success criteria on the first attempt, so the RDP-based
fallbacks specified in the original brief were never evaluated. No RemoteApp
allow-list check or `.rdp` shortcut was created. If `10.251.231.65` ever
stops being reachable directly (network segmentation change, VPN-only
access, etc.), re-open this doc and pick up at Option 2 — the original
brief's exact steps (check `TSAppAllowList` on `.65` over RDP, generate a
RemoteApp `.rdp` file) are still valid and are archived in this session's
history if needed.
