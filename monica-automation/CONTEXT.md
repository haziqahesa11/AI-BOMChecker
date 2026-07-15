# Claude Code Brief — MONICA BOM Encoding Automation

Paste this into Claude Code as the opening brief. It is written to be read once and
kept as `CONTEXT.md` in the repo root.

---

## Role

You are a senior data engineer working on a production manufacturing system at Wiwynn.
This system writes to a live BOM database used for server test programs. Mistakes here
mean wrong test configurations shipped to the factory floor. Behave accordingly:
read-only until proven, dry-run before write, verify every phase before advancing.

---

## The system you are automating

`MonicaTPGenerator.exe` (v3.9.7.0, .NET WinForms, Wiwynn, 2018) is an internal desktop
tool. Test Engineers use it to encode BOM data for MONICA BOM-based test programs.
`MonicaTPApprover.exe` (v2.4.2.0) is the companion approval tool.

### Data flow today (manual)

1. TE opens TPG on the DDNS / OA machine, sets Target SQL Server to `WYHQ`.
2. **QVL tab** — for a given Model Reference (e.g. `C2012_L11`) and Location (e.g. `L11`),
   the TE checks whether each Part Number from the cross-table exists in the QVL.
   If a PN is missing, they key it in, look up its description on the PLM system,
   paste it into Description, and click `ADD / MODIFY`.
3. **Test BOM tab** — pick Model Reference + Part Number. A grid loads with one row per
   physical location (`B01`..`B48`, `MGMT_SW`, `MINIPDU1..4`, `MPX1`, `RM`, `SKU`, `UPS1`,
   `.LOC` offsets, etc.). Each row needs a **CPN** picked from a dropdown and a
   **Revision**. Red cell = unset, green = set. This is the manual bottleneck: dozens of
   near-identical dropdown selections per PN.
4. **Submit** — writes to the review queue. Does **not** write live BOM.
5. A different human opens **TPA**, compares against CRD/cross-table/SKU, and clicks
   Approve or Reject. Approval promotes the data to the live BOM.

### Hard boundary

**You automate steps 1–4 only. You never automate step 5.**
Submit writes to `SysBomWaitList` / `ReviewList`. Approve promotes to live `SysBom`.
The human approval gate is the only control on this database. It stays.

---

## Environment constraints (read carefully — this drives the architecture)

- The tool, the PLM API, and the SQL server are reachable **only from a remote Windows
  host**, accessed by RDP at `10.251.231.23`.
- App path on that host: `C:\@BOM-Based-APP\New MTPG\MonicaTPGenerator`
- Therefore **all code must run on that remote host**, not on the developer laptop.
- **Phase 0 exists to establish what can actually run there.** Do not assume Python is
  installed, or that you can install it.

> **2026-07-10 update (see `PHASE0_FINDINGS.md`):** this assumption did not hold. The PLM
> API and the actual SQL Server (`10.251.231.65:1435`) are both directly reachable from the
> ordinary developer laptop. The remote-host requirement above is superseded — see the
> findings doc for what was actually verified and what remains open.

---

## Known technical facts (extracted from the binaries and the SOP deck — treat as leads, verify each)

### SQL

- Server: `MonicaMTE.wiwynn.com\SQLEXPRESS`, site name `WYHQ_SQL`, location `WYHQ`
- Initial Catalog: `MSFT_SKU`
- Connection strings the app uses:
  - `Data Source={0};Initial Catalog={1};Integrated Security=SSPI;`
  - `Data Source={0};User ID={1};Password={2};Initial Catalog={3};`
- The app calls **stored procedures only** — no ad-hoc SQL. Relevant ones:

| Purpose | Stored procedure |
|---|---|
| Query QVL for model/location | `SP_QVL_Query`, `SP_QVL_Query_DESC` |
| Insert/update QVL entry | `SP_QVL_Update` |
| Delete QVL entry | `SP_QVL_Delete` |
| Part description CRUD | `SP_PartDescription_Query` / `_Update` / `_List` / `_Del` / `_Find` |
| Location table | `SP_LocationTable_Query`, `SP_LocationTable_Model_Distinct`, `SP_LocationTableExtended_List` |
| BOM read | `SP_SysBom_PN_Query`, `SP_SysBom_PN_Distinct`, `SP_SysBom_Lv_Distinct` |
| Submit to review queue | `SP_SysBomWaitList_Update_`, `SP_ReviewList_Update_` |
| **Approve (DO NOT CALL)** | `SP_ReviewList_Approve` |
| CRD spec | `SP_CRDspec_Query`, `SP_CRDspecTracking_Query` |
| FRU spec | `SP_FRUspec_Query`, `SP_FRUspecTracking_Query` |
| SKU properties | `SP_PartProperties_Query` |

Common result columns seen: `ModelRef`, `PartNumber`, `ParentPartNumber`, `ChildPartNumber`,
`ChildRevision`, `Level`, `Location`, `Type`, `Remark`, `Description`, `Revision`, `Value`,
`Issuer`, `IssueDate`, `IssuerHost`, `IssuerReason`, `Approver`, `ApproveDate`,
`ApproverHost`, `ApproverReason`, `SpecNumber`, `Line`, `SkuNumber`, `ItemNumber`,
`ServerCount`, `TargetWorkloadPercent`.

### The Info API (Phase 1 target)

Two backends. The modern one:

- `POST https://plmkeymaker.wiwynn.com/APIFP/part/get-part-classification`
- `Content-Type: application/json`
- Body: `{"partNumber":"<PN>"}`
- Header: `Authorization: <site JWT>`
- The binary carries a **different JWT per site** (`WYMX`, `WZS`, `WYTN`, `WCZ`, `WYHQ_VCS`),
  selected by matching the host's IP prefix (`10.32.`, `10.34.`, `10.35.`, `10.37.`,
  `10.41.`, `10.49.`, `10.82.`, `10.248.`, `10.249.`, `10.250.`).
- Fields of interest in the response: `partNumber`, `generalDescription`.

The legacy one (Wistron PLM, HTML scrape — fallback):

- `POST http://wpqssvr.wistron.com.tw:8080/wpqs_plm/servlet/com.qpart.PartResult`
- `Content-Type: application/x-www-form-urlencoded`
- Body: `T1={0}&T2={1}&T3={2}&T4={3}&T5={4}&T6={5}&B1=Query`
- Response is an HTML table; the app walks `//table` → `//tr` → `//td` and reads labelled
  cells: `PART NUMBER`, `PART NAME`, `GENERAL DESCRIPTION`, `CREATOR`, `MANUFACTURER`,
  `MANUFACTURER PART NUMBER`, `GREEN FACTOR`.

> **Secrets policy.** The JWTs and a SQL password are compiled into the .exe. Do **not**
> copy them into source, commits, logs, or chat. Read them at runtime from
> `config/secrets.env` (gitignored) or Windows env vars. Ask the tool owner
> (`ChingAn@WYHQ #7050`) or your TE supervisor before minting or reusing any token.

### Part-number grammars enforced by the app

```
M\d{7}-\d{3}          primary PN            e.g. M1391240-001
M\d{7}-00\d{1}        MSF-required variant
M\d{7}                bare PN
X\d{6}-\d{3}
MSF-\d{6}             MSF number
B\d{2}\.              QVL rack PN prefix    e.g. B81.04E01.0001
BCS\.
```
Sub-PNs append `$xxxx` — e.g. `M1391240-001$Y5166`, `M1272707-001$N3222`.

### Model references

`C1042_L10`, `C1042_L11`, `C2012_L6`, `C2012_L10`, `C2012_L11`, `C202A_L10`,
`C2032_L10`, `C206A_L10`, `C207A_L10` (and `C2082_L10` per the SOP).

The full location list per model is in `MonicaTPGenerator.xml` (`CONFIGURATION/MODEL/<model>/LOCATION`
with `NAME`, `TYPE`, `REMARK`). **Parse this file — do not hardcode location lists.**
`MonicaTPApprover.xml` holds only the SQL setting block.

### The escape hatch you should exploit

TPG's Test BOM tab has **Save** and **Load** buttons:
- `Class File (*.tbm)|*.tbm|CSV File (*.csv)|*.csv`
- Row format: 5 comma-separated fields per location.
- On Load it validates `Current PN` vs `Saved PN` (rejects with `INCORRECT PART NUMBER!`).
- On Load it fills **only cells not already selected** ("Data will be updated for value not
  been selected in current BOM").

This means a generated CSV can drive the grid through the app's own validation, without UI
scripting and without touching SQL directly. Prefer this over pywinauto wherever possible.

---

## Target pipeline (for orientation — build only what each phase says)

```
1 INTAKE          MO trigger  |  manual P/N entry
2 DATA CAPTURE    Info API    ->  Generate QVL
3 COMPARE/FILTER  Comparison check + logic -> Filter -> Info
4 TEST PLAN GEN   Auto Fill -> TPG -> TPA
5 2ND VALIDATION  Comparison checker (2nd level)
6 SUBMIT          (PY) Submit -> DB        <-- pipeline ends here
   [AI analysis / WPO prediction: OUT OF SCOPE, later]
```

---

## Phases

Each phase ends at a **verification gate**. Do not start phase N+1 until the gate for
phase N is demonstrated to me with real output. If a gate fails, stop and report — do
not work around it.

### Phase 0 — Environment recon (no code that changes anything)

**Goal.** Establish what can run on the remote host and what is reachable.

**Do.**
1. Report OS version, whether Python is installed (`python --version`, `py -0`), whether
   pip works, whether PowerShell 5.1 or 7 is present, and whether you can install packages.
   If Python is unavailable and cannot be installed, say so — the whole design changes
   (PowerShell + `Invoke-SqlCmd`, or a self-contained .NET tool).
2. Confirm you can reach `plmkeymaker.wiwynn.com` (TLS handshake only, no auth).
3. Confirm you can reach `MonicaMTE.wiwynn.com` on the SQLEXPRESS port.
4. Confirm whether the logged-in RDP account has SQL access via `Integrated Security=SSPI`.
   If yes, **use SSPI and never handle the password.**
5. Copy `MonicaTPGenerator.xml` into the repo as a read-only reference fixture.

**Gate.** A written `PHASE0_FINDINGS.md` answering all five, with the exact commands run
and their output. No credentials in it.

**Deliverable.** `PHASE0_FINDINGS.md`, `fixtures/MonicaTPGenerator.xml`

---

### Phase 1 — Info API client (READ ONLY) — *current focus*

**Goal.** Given a part number, return `{partNumber, generalDescription, source}` reliably.
Nothing is written anywhere.

**Do.**
1. `config/settings.toml` — SQL host, catalog, API base URLs, site code. No secrets.
   `config/secrets.env` — JWT, gitignored, loaded at runtime. Fail loudly if absent.
2. `monica/plm_client.py`:
   - `get_part(pn: str) -> PartInfo | None`
   - Validate `pn` against the grammars above **before** any network call. Reject early.
   - Primary: POST to `plmkeymaker` with JSON body + Authorization header.
   - Fallback: legacy Wistron servlet, parse the HTML table by label (not by index —
     column order will change on you).
   - Timeout, one retry with backoff, no infinite loops.
   - Cache responses to `cache/plm/<pn>.json` (PLM data is near-static; do not hammer the API).
   - Distinguish clearly: *not found* vs *auth failure* vs *network failure*. The app's own
     message `No Part Number Description from PLM system!` maps to not-found.
3. `monica/models.py` — a `PartInfo` dataclass. Typed. No dicts floating around.
4. Structured logging to file. Never log the Authorization header.

**Gate.** Run against **at least 5 real PNs** taken from the QVL screenshots or from the
cross-table:
- 3 that exist (expect populated `generalDescription`)
- 1 malformed (e.g. `M139124`) — rejected before any HTTP call
- 1 well-formed but nonexistent — clean not-found, not a crash

Show me the console transcript and the cache files. I want to see the fallback path
exercised at least once (temporarily point the primary URL at an unreachable host).

**Deliverable.** `monica/plm_client.py`, `monica/models.py`, `tests/test_plm_client.py`
(with the network mocked), `PHASE1_EVIDENCE.md`

---

### Phase 2 — QVL read + diff (READ ONLY)

**Goal.** For a model reference + location, produce the current QVL from the database and
diff it against an input cross-table, producing a **proposed** add/modify list. Nothing is
written.

**Do.**
- `monica/db.py` — thin wrapper. Stored-procedure calls only, parameterised. Never string-
  concatenate SQL. Read-only whitelist enforced in code: only `SP_*_Query*`, `SP_*_List*`,
  `SP_*_Distinct` may be called in this phase.
- `SP_QVL_Query` / `SP_QVL_Query_DESC` for the existing QVL.
- Cross-table ingestion (CSV or xlsx — ask me for a sample before guessing the schema).
- Emit `qvl_diff.csv`: `action(ADD|MODIFY|NOOP), model, location, pn, current_desc, proposed_desc, source`.
- Descriptions come from Phase 1's `plm_client`.

**Gate.** Run for `C2012_L11` / `L11`. The `NOOP` rows must exactly reconcile against what
the TPG QVL grid shows on screen for the same model+location. Screenshot the app, show me
the CSV, and account for every discrepancy. A single unexplained row = gate failed.

---

### Phase 3 — QVL write (FIRST WRITE — gated)

**Goal.** Apply the Phase 2 diff via `SP_QVL_Update`.

**Rules.**
- `--dry-run` is the default. `--apply` must be passed explicitly.
- Before first real apply: confirm with the tool owner / TE supervisor that scripted
  `SP_QVL_Update` is acceptable. Get it in writing. Record it in the repo.
- Every applied row appends to an append-only `audit/qvl_writes.jsonl` (who, when, what,
  before-value, after-value).
- Implement `--rollback <run_id>` using `SP_QVL_Delete` / restore-prior-description before
  the first apply, not after.

**Gate.** Apply exactly **one** ADD row. Verify it appears in the TPG QVL grid. Roll it
back. Verify it disappears. Then and only then, batch.

---

### Phase 4 — Test BOM autofill via CSV

**Goal.** Generate the Test BOM CSV that TPG's `Load` button consumes.

**Do.**
1. **First, empirically derive the schema.** Open TPG, hand-fill one small BOM, click
   `Save` as CSV, and read the file. Do not guess the five columns. Record the schema in
   `docs/tbm_csv_schema.md`.
2. Build `monica/bom_builder.py`: locations from `MonicaTPGenerator.xml`, CPN + Revision
   resolved from cross-table + CRD (`SP_CRDspec_Query`), `NO_DEVICE` for empty slots,
   `*` revision where the CRD says wildcard.
3. Emit the CSV. Load it in TPG. The grid should go all-green.

**Gate.** Load a generated CSV for one real PN. Zero red cells. Manually spot-check 10
rows against the CRD and cross-table. Do not click Submit.

---

### Phase 5 — Comparison checker (2nd level)

**Goal.** An independent validator that re-derives expected CPN/Revision from CRD + SKU +
cross-table and compares against the generated BOM. It must not share code with the
generator — that is the whole point of a second level.

**Gate.** Deliberately corrupt one CPN in a generated CSV. The checker catches it and
names the exact row. Then confirm it passes a clean file.

---

### Phase 6 — Submit

**Goal.** Write to the **review queue only**, via `SP_SysBomWaitList_Update_` and
`SP_ReviewList_Update_`, carrying a real issuer ID and reason.

**Rules.**
- The issuer must be a real employee ID / name, provided at runtime. Never a service account
  pretending to be a person.
- The reason string must state that the row was machine-generated and by which run_id.
  The approver deserves to know.
- Phase 5's checker must pass before submit is even offered.
- **`SP_ReviewList_Approve` is never called. There is no `--auto-approve` flag. Do not add one.**

**Gate.** Submit one PN. Open TPA. Confirm it appears in the review list with the correct
issuer, reason, and diff. Then reject it from TPA to clean up.

**Pipeline ends here.** AI analysis / WPO prediction is a separate project.

---

## Engineering standards

- Python 3.11+ if available. `pyodbc` or `pymssql` for SQL. `httpx` for HTTP. `lxml` for the
  legacy scrape. `pydantic` or dataclasses for models.
- Type hints everywhere. `mypy --strict` clean.
- Parameterised stored-proc calls only. No f-strings anywhere near SQL.
- Secrets from env. `.gitignore` must cover `secrets.env`, `cache/`, `audit/`, `*.log`.
- Every destructive operation: dry-run default, explicit `--apply`, audit log, rollback path.
- Tests mock the network and the database. There is no test SQL instance; assume you cannot
  create one, and design so the logic is testable without it.
- Commit per phase, tagged `phase-0` … `phase-6`.

## When to stop and ask me

- Phase 0 shows Python cannot run on the remote host.
- Any stored procedure's parameter list differs from what this brief implies.
- The Test BOM CSV schema does not have five columns.
- You are about to call any `SP_*_Update`, `SP_*_Del*`, or `SP_*_Approve` for the first time.
- Anything requires a credential not already in `secrets.env`.

Start with **Phase 0**. Report findings. Do not write Phase 1 code until I approve the gate.
