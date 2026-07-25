# WTS Tracking Dashboard

A Streamlit dashboard over the Wiwynn Tracking System (Azure DevOps). It indexes
work items and their newest attachment — grouped by **model / sequence / revision** —
and lets you open the downloaded spreadsheets in the browser.

## Files
- `wts_fetch.py` — fetch layer (refactor of the original downloader). Downloads
  attachments to `WTS/` and writes `WTS/index.json`. Runs standalone or is called
  by the dashboard's refresh button.
- `dashboard.py` — the Streamlit app (Index tab + Spreadsheet viewer tab).
- `Project_List.cfg` — one project per line (already yours).
- `requirements.txt`, `.streamlit/config.toml`.

## Setup
```bash
pip install -r requirements.txt
```

## Run
```bash
streamlit run dashboard.py
```
Then press **Fetch latest data** in the sidebar (first run has no data yet), or
pre-populate with:
```bash
python wts_fetch.py
```

## Configure
- **Token:** set `AZURE_DEVOPS_PAT` as an environment variable rather than leaving
  it hardcoded in `wts_fetch.py`. Rotate the current token when you can.
- **Date window:** `DAYS_BACK` in `wts_fetch.py` (default 10).
- **Model / sequence / revision parsing:** `parse_model`, `SEQUENCE_PATTERNS`,
  `REVISION_PATTERNS` near the top of `wts_fetch.py`. Anything unparsed shows as
  `—` in the dashboard so gaps are visible. Paste a real title + filename to make
  these exact.
