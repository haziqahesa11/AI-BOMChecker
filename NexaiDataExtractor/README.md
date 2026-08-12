# NexaiDataExtractor

A weekly Python job that pulls from the AI-BOM app's REST API and builds a Markdown
"library" at `~/AI-BOM/Data_Compilation` on NEXAi — structured so a local Ollama-based
RAG pipeline can cite it and trace an answer back to a specific source, endpoint, and
week. It never touches a database directly and never writes back to the AI-BOM app —
every call it makes is read-only (one exception, explained below).

**First run backfills all history it can reach; every run after that only adds the new
"patch" for that work week.** These are the same code path, not two modes — see
[How it works](#how-it-works).

## What it pulls

| Source (folder under `Data_Compilation/`) | Endpoint | Shape |
|---|---|---|
| `cycle_time_l11`, `cycle_time_l10` | `/api/cycle-time/l11`, `/l10` | event — one row per stage transition |
| `fpy_blade_raw` | `/api/first-pass-yield/blade` | event — raw fail records |
| `fpy_summary` | `/api/first-pass-yield/summary` | snapshot — weekly rollup per model×environment |
| `tpa_history` | `/api/tpa-history` | event — approval audit log |
| `crd_tracker_lines`, `crd_tracker_revision_codes` | `/api/crd-tracker/lines`, `/revision-codes` | snapshot |
| `crd_tracker_line_history` | `/api/crd-tracker/lines/:id/history` | event — per line's weekly CRD revision |
| `golden_template_catalog` | `POST /api/golden-template/catalog/refresh` | snapshot |
| `models` | `/api/models` | snapshot |
| `wts_library` | `/api/wts/index` | snapshot |
| `npi_library_skus`, `npi_library_cross_tables` | `/api/npi/index` | snapshot |

**Out of scope, deliberately:** `/api/mo-lookup`, `/api/qvl-list`, `/api/part-detail`,
`/api/compare` — each needs a specific MO/part number as input; there's no bulk list to
enumerate them from, so they aren't part of a scheduled crawl.

**The one non-GET call:** `golden_template_catalog` calls `POST
/api/golden-template/catalog/refresh` instead of `GET /catalog`. That route
(`BackEnd/services/goldenTemplateService.js`) is `res.json(await refreshCatalog())` —
synchronous — so the POST response body *is* the freshly-recrawled catalog, with no
follow-up GET and no race against whatever the server's cache last held. It doesn't
write to any database; it only makes the app itself recompute an in-memory cache it
already recomputes on demand from its own UI.

## ⚠️ Some sources aren't live yet on this deployment

Checked 2026-08-11 against `http://10.251.231.79:8000` (WYMY-NEXA, PM2
`ai-bom-online`): `models`, `wts_library`, `npi_library_*`, and all three
`crd_tracker_*` sources work today. `cycle_time_l11`/`l10`, `fpy_summary`,
`fpy_blade_raw`, `tpa_history`, and `golden_template_catalog` are **not yet deployed**
on that instance — the routes exist in this repo's `BackEnd/` but that box is running
an older build.

This is handled automatically, not something you need to work around: `extractor/
api_client.py` checks every response's content-type, and a route that doesn't exist
falls through Express's SPA catch-all to `index.html` (HTTP 200, `text/html`) rather
than a 404. The extractor treats that as `status: unavailable` for that source only —
logged clearly, never a crash — and picks it up automatically, with no config change
and no re-run needed, the first time it runs *after* that box is redeployed with a
current `BackEnd/`. Run `--dry-run` any time to see which sources are currently live.

## How it works

One SQLite ledger, `Data_Compilation/_state/state.sqlite3`, makes backfill and
steady-state patching the same code:

- **Event sources** (append-only history — Cycle Time, FPY raw, TPA History, CRD line
  history) resume from a per-source cursor (`HISTORY_EPOCH` on a source's first-ever
  run) and advance in `CHUNK_DAYS`-sized windows, deduping every row by a natural
  composite key (e.g. `usn|stage|trndate`) before deciding it's new. A brand-new source
  just produces one very large first patch — or several, capped by `--max-chunks`
  across separate runs — instead of needing separate "backfill mode" code.
- **Snapshot sources** (current-state data — Models, CRD Tracker lines, the Golden
  Template catalog, WTS/NPI indexes) always pull the full current picture and diff it
  against what was recorded last time, by a natural entity key. Every run produces an
  Added/Changed/Removed patch (skipped entirely if nothing changed) plus an evergreen
  `CURRENT.md` — the doc to point a "what's true right now" question at.

Every markdown file starts with YAML frontmatter (source, run id, work week, generated
timestamp, record count, the upstream endpoint and query) and groups rows under `##`
headings by their natural parent (one heading per USN, per CRD line, per project) so a
RAG chunker splitting on headings never cuts a record in half. `Data_Compilation/
INDEX.md` is regenerated every run: one row per file ever written, newest first — the
map a retrieval pipeline (or a person) uses to find what exists and when it was
captured. `_state/` is bookkeeping, not content — exclude it from whatever reads this
folder.

## Deploying on NEXAi

**1. Get the code onto NEXAi.** From this repo, copy (`scp`/`rsync`, or a `git clone` if
NEXAi can reach your remote) both `NexaiDataExtractor/` and `config/credentials/` —
keep them siblings, same as in this repo, since `extractor/config.py` looks for
`../config/credentials/nexai_extractor.env` relative to its own location:

```
~/AI-BOM/
  NexaiDataExtractor/
  config/
    credentials/
      nexai_extractor.env      # you create this in step 3
```

(If you'd rather not preserve that layout, set the `NEXAI_EXTRACTOR_ENV` environment
variable to wherever you put the env file instead.)

**2. Set up the venv:**

```bash
cd ~/AI-BOM/NexaiDataExtractor
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

**3. Configure it:**

```bash
cp ../config/credentials/nexai_extractor.env.example ../config/credentials/nexai_extractor.env
# edit nexai_extractor.env — at minimum confirm AI_BOM_API_BASE_URL and DATA_COMPILATION_DIR
```

**4. Check reachability before trusting cron with it** — NEXAi should be able to reach
WYMY-NEXA (`10.251.231.79`) as its gateway host directly:

```bash
curl -s http://10.251.231.79:8000/api/version
# expect: {"buildId":"..."}
```

If that hangs or errors, the extractor won't work either — fix connectivity (or point
`AI_BOM_API_BASE_URL` at a reachable alternative, e.g. an SSH local port-forward:
`ssh -L 8000:localhost:8000 engineer@10.251.231.79` kept alive under `autossh`/a
systemd unit, with `AI_BOM_API_BASE_URL=http://localhost:8000`) before step 5.

**5. First run — do this manually, watched, before cron.** History since
`HISTORY_EPOCH` (default 2015-01-01) can mean a genuinely large first pull for Cycle
Time/TPA History. Run it under `tmux`/`nohup` with `--catch-up-fully` so it loops past
the default `--max-chunks` cap until every source is fully caught up in one sitting:

```bash
tmux new -s nexai-extract
.venv/bin/python run_weekly_extract.py --catch-up-fully
# Ctrl+B, D to detach; tmux attach -t nexai-extract to check back in
```

Without `--catch-up-fully`, a first run only advances up to `--max-chunks` (default 12)
windows per source and stops — safe, but means several ordinary cron ticks before
history sources are fully caught up. Either is fine; `--catch-up-fully` just gets you
there in one sitting.

**6. Install the weekly cron job** (Monday 02:00, adjust as you like):

```bash
crontab -e
```
```cron
0 2 * * 1 cd ~/AI-BOM/NexaiDataExtractor && .venv/bin/python run_weekly_extract.py >> ~/AI-BOM/NexaiDataExtractor/cron.log 2>&1
```

A run that finds this ISO work week already completed exits immediately (idempotent —
safe if cron fires twice, or you run it by hand between scheduled ticks).

## Command-line reference

```
python run_weekly_extract.py                  # normal weekly run; no-op if this ISO
                                                # work week already completed
python run_weekly_extract.py --force           # re-run even if this week already ran
python run_weekly_extract.py --dry-run         # fetch + diff, print counts, write
                                                # nothing to disk (safe to run anytime,
                                                # including before deploying, to check
                                                # which sources are currently live)
python run_weekly_extract.py --catch-up-fully  # remove the --max-chunks cap; loop
                                                # until every event source is caught
                                                # up to today (first-run bootstrap)
python run_weekly_extract.py --max-chunks 20   # override the per-invocation chunk cap
```

## Pointing Ollama/RAG at the library

Point your ingestion step at `Data_Compilation/`, excluding `_state/`. Read `INDEX.md`
first — it's the manifest of every file, with source/kind/work-week/record-count
columns, so an ingester (or a person) can decide what's new since last time without
re-scanning the whole tree. For "what's the current state of X" questions, prefer each
source's `CURRENT.md`; for "what changed" or "when did X happen" questions, the dated
`*_patch_*.md` files are the audit trail.

## Development / running the tests

```bash
cd NexaiDataExtractor
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/pytest tests/ -v
```

Tests use `respx` (httpx-native HTTP mocking) and cover: idempotency (an identical
second run produces zero new records), Added/Changed/Removed diff correctness, the
CRD Tracker negative-lineId ("Test" row) filter, event-source chunked catch-up and
resumption, and dry-run's guarantee of zero disk/state writes. No network or live
credentials are needed to run them.
