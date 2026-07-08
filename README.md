# AURA-T — Automated Universal Register Analysis Tool

A dark industrial Node.js web application for AI-powered BOM (Bill of Materials) comparison and anomaly detection.

---

## Features

- **BOM File Upload** — supports `.xlsx`, `.xls`, `.csv`, `.json`
- **AI Anomaly Detection** — automatically flags:
  - Missing/empty critical fields (CPN, Revision, Level, Type)
  - Invalid Part Number formats
  - Suspicious revision strings
  - Description vs Remark mismatches
  - Duplicate CPN entries
  - Non-standard Level values
- **Confidence Scoring** — per-row confidence % with visual indicator
- **Live Charts** — firmware matching confidence sparkline + anomaly type distribution bar chart
- **Interactive Table** — sortable, searchable, filterable by status
- **Anomaly Sidebar** — quick-access list of all detected issues
- **Row Detail Modal** — full field breakdown with issue list per entry
- **CSV Export** — download filtered results

---

## Setup

```bash
npm install --prefix BackEnd
npm install --prefix Frontend
npm start
```

Open http://localhost:3000 in your browser.

For development (backend with live API + Vite dev server with hot reload):
```bash
npm run dev
```

To build the frontend for production (served by the backend from `Frontend/dist`):
```bash
npm run build
```

---

## File Formats

### CSV
```
Location,Type,Level,CPN,Revision,Remark,Description
BIOS #0,FW,L10,C2195.BIOS,3A03.GN.1,FIRMWARE,C2195.BIOS FIRMWARE
```

### JSON
```json
[
  { "Location": "BIOS #0", "Type": "FW", "Level": "L10", "CPN": "C2195.BIOS", "Revision": "3A03.GN.1" }
]
```

### Excel (.xlsx)
Standard spreadsheet with column headers in row 1.

---

## Anomaly Types

| Code | Severity | Description |
|------|----------|-------------|
| MISSING_FIELD | HIGH | Critical field is empty |
| INVALID_PN_FORMAT | HIGH | CPN contains invalid characters |
| UNUSUAL_PN_LENGTH | MEDIUM | CPN too short or too long |
| INVALID_REVISION_FORMAT | MEDIUM | Revision doesn't match expected pattern |
| DUPLICATE_CPN | MEDIUM | Same CPN appears on multiple rows |
| DESC_REMARK_MISMATCH | LOW | Description and Remark don't align |
| UNUSUAL_LEVEL | LOW | Level value not in standard set |

---

## Project Structure

```
AI-BOMChecker/
├── package.json        # Root orchestrator (start/dev/build delegate to BackEnd & Frontend)
├── BackEnd/
│   ├── server.js       # Express server + BOM vs CRD comparison engine
│   ├── DB.js           # MSSQL connection pool
│   └── package.json
└── Frontend/
    ├── index.html
    ├── vite.config.js
    ├── src/            # React UI (components, panels, styles)
    └── package.json
```
