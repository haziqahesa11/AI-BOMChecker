"""
wts_fetch.py
------------
Fetch layer for the WTS dashboard.

This is a refactor of the original download_data_from_wts.py. It keeps the same
behaviour (query Azure DevOps, filter work items by keyword, download the newest
.xlsx / ECI_*.zip attachment per item) and adds two things the dashboard needs:

  1. It writes a metadata index to WTS/index.json describing every matched item
     (project, model, sequence, revision, title, state, attachment, file path...).
  2. It exposes run_fetch() so the Streamlit dashboard can trigger a refresh,
     and it still runs standalone with:  python wts_fetch.py

Nothing about the download itself changed, so files still land in WTS/ exactly
as before; index.json is written on top.
"""

import os
import re
import json
import base64
import requests
from datetime import datetime
from dateutil import parser

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
ORGANIZATION = "WiwynnTrackingSystem"
KEYWORDS = ["CRD_", "SKU_", "CRD ", "SKU ", "FRU_", "FRU "]
PROJECT_LIST_FILE = "Project_List.cfg"
DAYS_BACK = 10  # work items changed within this many days (was @Today - 10)

# --- Personal Access Token --------------------------------------------------
# SECURITY: the PAT below is your credential. Because it now lives in a file you
# may share, prefer supplying it via an environment variable instead:
#     export AZURE_DEVOPS_PAT="your-token"        (macOS/Linux)
#     setx  AZURE_DEVOPS_PAT "your-token"         (Windows)
# The hardcoded fallback still works, but consider rotating this token and
# moving it out of source control.
PAT = os.environ.get("AZURE_DEVOPS_PAT", "").strip()
if not PAT:
    PAT = "28RfTWXl8wlWeDsot9ig2CXpNwRR0URo4rYrZtPW3erm3hJ4EqUcJQQJ99CGACAAAAAsNR9sAAASAZDOseY9"  # Expires 2027/7/23 — move to env var

# ---------------------------------------------------------------------------
# Parsing: model / sequence / revision
# ---------------------------------------------------------------------------
# These are best-effort patterns. Once you paste one real work-item TITLE and one
# real attachment FILENAME, tighten the regexes below and the grouping becomes
# exact. Everything unmatched shows up as "—" in the dashboard so gaps are visible.

# Model: by default taken from the project-name suffix after the last "_":
#   "BPD01U010001_Gen7" -> model "Gen7", code "BPD01U010001"
def parse_model(project: str):
    if "_" in project:
        code, model = project.rsplit("_", 1)
    else:
        code, model = project, project
    return model, code

# NOTE: underscore is a regex "word" character, so \b does NOT sit between "3"
# and "_". Because WTS names are underscore-separated (CRD_C2195_Seq03_RevB),
# these patterns anchor on explicit separators (start / space / _ / -) instead.
REVISION_PATTERNS = [
    r"(?:^|[\s_\-])Rev[\s_\-]([A-Za-z0-9]{1,4})(?=$|[\s_\-\.])",   # Rev_B / Rev B / Rev-01
    r"(?:^|[\s_\-])Rev([A-Za-z0-9]{1,3})(?=$|[\s_\-\.])",           # RevB / Rev01 (glued)
    r"(?:^|[\s_\-])V([0-9]+(?:\.[0-9]+)?)(?=$|[\s_\-\.])",          # _V2 / -V1.1
    r"(?:^|[\s_\-])R([0-9]{1,3})(?=$|[\s_\-\.])",                    # _R5
    r"[_\-]([A-Za-z])(?=\.[A-Za-z0-9]+$)",                          # trailing _A before extension
]

SEQUENCE_PATTERNS = [
    r"(?:^|[\s_\-])Seq[\s_\-]?([0-9]+)(?=$|[\s_\-\.])",            # Seq03 / Seq_3 / Seq 3
    r"#\s?([0-9]+)",                                                 # #12
]

def _first_match(patterns, *texts):
    for text in texts:
        if not text:
            continue
        for pat in patterns:
            m = re.search(pat, text, re.IGNORECASE)
            if m:
                return m.group(1)
    return None

def parse_revision(title: str, filename: str):
    rev = _first_match(REVISION_PATTERNS, title, filename)
    return rev.upper() if rev else None

def parse_sequence(title: str, filename: str):
    return _first_match(SEQUENCE_PATTERNS, title, filename)

def detect_keyword(title: str):
    """Return which keyword family matched: CRD / SKU / FRU (or None)."""
    for k in KEYWORDS:
        if k in title:
            return k.strip("_ ").upper()
    return None

# ---------------------------------------------------------------------------
# Folders + logging
# ---------------------------------------------------------------------------
TIMESTAMP = datetime.now().strftime("%Y-%m-%d")
LOG_DIR = "Log"
WTS_DIR = "WTS"
INDEX_PATH = os.path.join(WTS_DIR, "index.json")
os.makedirs(LOG_DIR, exist_ok=True)
os.makedirs(WTS_DIR, exist_ok=True)
LOG_FILE_PATH = os.path.join(LOG_DIR, f"{TIMESTAMP}.log")

def log(msg: str):
    print(msg)
    with open(LOG_FILE_PATH, "a", encoding="utf-8") as f:
        f.write(msg + "\n")

# ---------------------------------------------------------------------------
# Azure DevOps calls
# ---------------------------------------------------------------------------
HEADERS = {
    "Content-Type": "application/json",
    "Authorization": "Basic " + base64.b64encode(f":{PAT}".encode()).decode(),
}

def get_recent_workitems(project: str):
    wiql = {
        "query": f"""
        SELECT [System.Id], [System.Title], [System.State]
        FROM WorkItems
        WHERE [System.TeamProject] = '{project}'
        AND [System.ChangedDate] >= @Today - {DAYS_BACK}
        ORDER BY [System.ChangedDate] DESC
        """
    }
    url = f"https://dev.azure.com/{ORGANIZATION}/_apis/wit/wiql?api-version=7.1-preview.2"
    resp = requests.post(url, headers=HEADERS, json=wiql)
    resp.raise_for_status()
    return [item["id"] for item in resp.json()["workItems"]]

def get_workitem_detail(project: str, item_id: int):
    url = (f"https://dev.azure.com/{ORGANIZATION}/{project}/_apis/wit/workitems/"
           f"{item_id}?$expand=all&api-version=7.1-preview.3")
    resp = requests.get(url, headers=HEADERS)
    resp.raise_for_status()
    return resp.json()

# ---------------------------------------------------------------------------
# Per-project processing -> list of index records
# ---------------------------------------------------------------------------
def process_project(project: str):
    records = []
    log(f"============== Processing Project: {project} ==============")
    model, project_code = parse_model(project)

    try:
        item_ids = get_recent_workitems(project)
        log(f"Found {len(item_ids)} recent work items.")
    except Exception as e:
        log(f"Failed to fetch work items for {project}: {e}")
        return records

    for item_id in item_ids:
        try:
            detail = get_workitem_detail(project, item_id)
            fields = detail["fields"]
            title = fields.get("System.Title", "")

            keyword = detect_keyword(title)
            if keyword is None:
                continue

            # newest attached file
            latest_file = None
            for rel in detail.get("relations", []):
                if rel.get("rel") != "AttachedFile":
                    continue
                attr = rel["attributes"]
                mod_time = parser.parse(attr["resourceModifiedDate"])
                if not latest_file or mod_time > latest_file["mod_time"]:
                    latest_file = {"url": rel["url"], "name": attr["name"], "mod_time": mod_time}

            if not latest_file:
                log(f"No valid attachment found for item {item_id}")
                continue

            filename = latest_file["name"]
            is_xlsx = filename.endswith(".xlsx")
            is_eci_zip = filename.startswith("ECI_") and filename.endswith(".zip")
            if not (is_xlsx or is_eci_zip):
                log(f"Skipped file: {filename}")
                continue

            # Save path — same as the original script (flat in WTS/, original name).
            # If you ever hit filename collisions between items, prefix the id:
            #   save_path = os.path.join(WTS_DIR, f"{item_id}_{filename}")
            save_path = os.path.join(WTS_DIR, filename)

            att_id = latest_file["url"].split("/")[-1]
            download_url = (f"https://dev.azure.com/{ORGANIZATION}/{project}/_apis/wit/attachments/"
                            f"{att_id}?fileName={att_id}&download=true&api-version=7.1-preview.3")
            resp = requests.get(download_url, headers=HEADERS)
            with open(save_path, "wb") as f:
                f.write(resp.content)
            log(f"Downloaded: {save_path}")

            records.append({
                "project": project,
                "project_code": project_code,
                "model": model,
                "work_item_id": item_id,
                "title": title,
                "state": fields.get("System.State", ""),
                "keyword": keyword,
                "sequence": parse_sequence(title, filename),
                "revision": parse_revision(title, filename),
                "changed_date": fields.get("System.ChangedDate", ""),
                "attachment_name": filename,
                "attachment_modified": latest_file["mod_time"].isoformat(),
                "file_path": save_path,
                "file_type": "xlsx" if is_xlsx else "zip",
                "downloaded_at": datetime.now().isoformat(timespec="seconds"),
            })

        except Exception as ex:
            log(f"Error processing item {item_id}: {ex}")

    return records

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def load_projects():
    if not os.path.exists(PROJECT_LIST_FILE):
        return []
    with open(PROJECT_LIST_FILE, encoding="utf-8") as f:
        return [line.strip() for line in f if line.strip()]

def run_fetch():
    """Fetch everything, write WTS/index.json, and return the list of records."""
    all_records = []
    for proj in load_projects():
        all_records.extend(process_project(proj))

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(all_records, f, ensure_ascii=False, indent=2)
    log(f"Wrote {len(all_records)} records to {INDEX_PATH}")
    return all_records

if __name__ == "__main__":
    run_fetch()
