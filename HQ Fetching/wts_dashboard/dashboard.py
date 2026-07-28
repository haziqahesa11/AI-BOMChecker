"""
dashboard.py
------------
Streamlit dashboard for Wiwynn Tracking System data.

Two things in one place:
  • Index  — every matched work item + attachment, filterable and groupable by
             model / sequence / revision (also project, keyword, state, date).
  • Sheets — open any downloaded .xlsx right inside the dashboard.

Run:
    streamlit run dashboard.py

Refresh data from Azure DevOps with the button in the sidebar (that calls
wts_fetch.run_fetch), or run  python wts_fetch.py  separately.
"""

import os
import json
from datetime import datetime

import pandas as pd
import streamlit as st

import wts_fetch  # reuse the fetch layer

INDEX_PATH = wts_fetch.INDEX_PATH  # stay in sync with wts_fetch's WTS_DATA_DIR resolution
DASH = "—"  # shown when a value could not be parsed

st.set_page_config(page_title="WTS Tracking Dashboard", page_icon="📦", layout="wide")

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def _index_mtime():
    return os.path.getmtime(INDEX_PATH) if os.path.exists(INDEX_PATH) else 0.0

@st.cache_data(show_spinner=False)
def load_index(_mtime: float) -> pd.DataFrame:
    """Load WTS/index.json into a tidy DataFrame. _mtime busts the cache on refresh."""
    if not os.path.exists(INDEX_PATH):
        return pd.DataFrame()
    with open(INDEX_PATH, encoding="utf-8") as f:
        rows = json.load(f)
    df = pd.DataFrame(rows)
    if df.empty:
        return df

    # Normalise types / fill blanks so filters and grouping behave.
    for col in ["model", "sequence", "revision", "keyword", "project",
                "project_code", "state", "title", "attachment_name",
                "file_path", "file_type"]:
        if col not in df.columns:
            df[col] = None
        df[col] = df[col].fillna(DASH).replace("", DASH).astype(str)

    df["changed_date"] = pd.to_datetime(df.get("changed_date"), errors="coerce", utc=True)
    df["changed_day"] = df["changed_date"].dt.date
    # Sort sequence numerically when possible, else lexically.
    df["_seq_num"] = pd.to_numeric(df["sequence"], errors="coerce")
    return df

@st.cache_data(show_spinner=False)
def load_sheet_names(path: str, _mtime: float):
    return pd.ExcelFile(path, engine="openpyxl").sheet_names

@st.cache_data(show_spinner=False)
def load_sheet(path: str, sheet: str, _mtime: float) -> pd.DataFrame:
    return pd.read_excel(path, sheet_name=sheet, engine="openpyxl")

# ---------------------------------------------------------------------------
# Sidebar: refresh + filters
# ---------------------------------------------------------------------------
st.sidebar.title("📦 WTS Tracking")
st.sidebar.caption("Azure DevOps · WiwynnTrackingSystem")

if st.sidebar.button("Fetch latest data", type="primary", use_container_width=True):
    with st.spinner("Fetching work items and downloading attachments…"):
        try:
            records = wts_fetch.run_fetch()
            st.cache_data.clear()
            st.sidebar.success(f"Fetched {len(records)} items.")
        except Exception as e:
            st.sidebar.error(f"Fetch failed: {e}")

df = load_index(_index_mtime())

# Empty state — an invitation to act, not an error.
if df.empty:
    st.title("WTS Tracking Dashboard")
    st.info(
        "No data yet. Press **Fetch latest data** in the sidebar to pull work "
        "items from Azure DevOps, or run `python wts_fetch.py` first."
    )
    st.stop()

st.sidebar.divider()
st.sidebar.subheader("Filters")

def multi(label, col):
    opts = sorted(df[col].unique().tolist())
    return st.sidebar.multiselect(label, opts, default=opts)

sel_model   = multi("Model", "model")
sel_keyword = multi("Type (CRD / SKU / FRU)", "keyword")
sel_project = multi("Project", "project")
sel_state   = multi("State", "state")
sel_rev     = multi("Revision", "revision")
search = st.sidebar.text_input("Search title", placeholder="e.g. CRD_…")

f = df[
    df["model"].isin(sel_model)
    & df["keyword"].isin(sel_keyword)
    & df["project"].isin(sel_project)
    & df["state"].isin(sel_state)
    & df["revision"].isin(sel_rev)
]
if search:
    f = f[f["title"].str.contains(search, case=False, na=False)]

# ---------------------------------------------------------------------------
# Header + metrics
# ---------------------------------------------------------------------------
st.title("WTS Tracking Dashboard")
last_dl = pd.to_datetime(df.get("downloaded_at"), errors="coerce").max()
c1, c2, c3, c4 = st.columns(4)
c1.metric("Work items", len(f))
c2.metric("Models", f["model"].nunique())
c3.metric("Spreadsheets", int((f["file_type"] == "xlsx").sum()))
c4.metric("Last fetch", last_dl.strftime("%Y-%m-%d %H:%M") if pd.notna(last_dl) else DASH)

tab_index, tab_sheets = st.tabs(["📋 Index", "📊 Spreadsheet viewer"])

# ---------------------------------------------------------------------------
# Tab 1 — Index (grouped by model / sequence / revision)
# ---------------------------------------------------------------------------
DISPLAY_COLS = ["model", "sequence", "revision", "keyword", "project",
                "work_item_id", "state", "title", "attachment_name",
                "changed_day", "file_type"]

with tab_index:
    if f.empty:
        st.warning("No rows match the current filters. Widen them in the sidebar.")
    else:
        left, right = st.columns([2, 1])
        with left:
            group_by = st.selectbox(
                "Break down by",
                ["Model", "Revision", "Type (CRD / SKU / FRU)", "Project", "State"],
                index=0,
            )
        with right:
            view = st.radio("View", ["Flat table", "Grouped by model"], horizontal=True)

        col_map = {"Model": "model", "Revision": "revision",
                   "Type (CRD / SKU / FRU)": "keyword", "Project": "project", "State": "state"}
        counts = f[col_map[group_by]].value_counts().sort_index()
        st.bar_chart(counts, height=240)

        st.divider()

        if view == "Flat table":
            table = f.sort_values(["model", "_seq_num", "sequence", "revision"])
            st.dataframe(table[DISPLAY_COLS], use_container_width=True, hide_index=True)
        else:
            for model in sorted(f["model"].unique()):
                sub = f[f["model"] == model].sort_values(["_seq_num", "sequence", "revision"])
                with st.expander(f"**{model}** · {len(sub)} item(s)", expanded=False):
                    st.dataframe(
                        sub[[c for c in DISPLAY_COLS if c != "model"]],
                        use_container_width=True, hide_index=True,
                    )

        st.download_button(
            "Download this view as CSV",
            f[DISPLAY_COLS].to_csv(index=False).encode("utf-8"),
            file_name=f"wts_index_{datetime.now():%Y%m%d}.csv",
            mime="text/csv",
        )

# ---------------------------------------------------------------------------
# Tab 2 — Spreadsheet viewer
# ---------------------------------------------------------------------------
with tab_sheets:
    xlsx = f[f["file_type"] == "xlsx"].copy()
    if xlsx.empty:
        st.info("No .xlsx files in the current selection. Adjust filters or fetch data.")
    else:
        xlsx["label"] = (xlsx["model"] + "  ·  " + xlsx["title"]
                         + "  ·  " + xlsx["attachment_name"])
        choice = st.selectbox("Choose a file", xlsx["label"].tolist())
        row = xlsx[xlsx["label"] == choice].iloc[0]
        path = row["file_path"]

        st.caption(f"Model {row['model']} · Seq {row['sequence']} · "
                   f"Rev {row['revision']} · work item {row['work_item_id']}")

        if not os.path.exists(path):
            st.error(f"File not found on disk: `{path}`. Fetch data to download it.")
        else:
            try:
                sheets = load_sheet_names(path, os.path.getmtime(path))
                sheet = st.selectbox("Sheet", sheets) if len(sheets) > 1 else sheets[0]
                data = load_sheet(path, sheet, os.path.getmtime(path))

                q = st.text_input("Filter rows containing", placeholder="type to filter any column")
                if q:
                    mask = data.astype(str).apply(
                        lambda r: r.str.contains(q, case=False, na=False)).any(axis=1)
                    data = data[mask]

                st.caption(f"{len(data)} row(s) × {data.shape[1]} column(s)")
                st.dataframe(data, use_container_width=True, hide_index=True)

                with open(path, "rb") as fh:
                    st.download_button(
                        "Download original file",
                        fh.read(),
                        file_name=row["attachment_name"],
                        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    )
            except Exception as e:
                st.error(f"Could not read this spreadsheet: {e}")
