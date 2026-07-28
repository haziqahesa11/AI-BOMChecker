import { useState, useEffect, useMemo } from 'react'
import StateBox from './StateBox'
import ComboInput from './ComboInput'
import SearchableSelect from './SearchableSelect'
import TabBar from './TabBar'
import { uniqSorted } from '../lib/crdTrackerUtils'

// Columns that get a per-column filter, in the order they appear in the
// table (matches CrdTrackerPage's ColumnFilter pattern). `get` pulls the
// filterable/display string for a row.
const FILTER_COLUMNS = [
  { key: 'model',    label: 'Model',    get: r => r.model || '' },
  { key: 'keyword',  label: 'Type',     get: r => r.keyword || '' },
  { key: 'project',  label: 'Project',  get: r => r.project || '' },
  { key: 'state',    label: 'State',    get: r => r.state || '' },
  { key: 'revision', label: 'Revision', get: r => r.revision || '' },
]
const EMPTY_FILTERS = Object.fromEntries(FILTER_COLUMNS.map(c => [c.key, '']))
const MAX_BREAKDOWN_BARS = 12

function formatDay(iso) {
  if (!iso) return '—'
  return String(iso).slice(0, 10)
}

function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString()
}

// Table-header column filter is a ComboInput whose suggestions are the
// column's own registered values — same pattern as CrdTrackerPage.
function ColumnFilter({ value, onChange, options }) {
  return <ComboInput value={value} onChange={onChange} options={options} />
}

function BreakdownChart({ rows, groupKey, groupLabel }) {
  const counts = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const v = r[groupKey] || '—'
      m.set(v, (m.get(v) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, groupKey])

  const max = counts.length ? counts[0][1] : 1
  const shown = counts.slice(0, MAX_BREAKDOWN_BARS)

  return (
    <div className="dist-chart">
      <div className="dist-chart-title">{groupLabel} breakdown</div>
      {shown.map(([label, count]) => (
        <div key={label} className="dist-bar-row">
          <div className="dist-bar-label">{label}</div>
          <div className="dist-bar-track">
            <div className="dist-bar-fill" style={{ width: `${(count / max) * 100}%`, background: 'var(--primary)' }} />
          </div>
          <div className="dist-bar-val">{count}</div>
        </div>
      ))}
      {counts.length > MAX_BREAKDOWN_BARS && (
        <p className="hint">+{counts.length - MAX_BREAKDOWN_BARS} more…</p>
      )}
    </div>
  )
}

// Tab 2 — pick a downloaded .xlsx from the index and browse its sheets
// in-browser, mirroring the Streamlit prototype's "Spreadsheet viewer" tab.
function SpreadsheetViewer({ rows }) {
  const xlsxOptions = useMemo(() => (
    rows.filter(r => r.fileType === 'xlsx').map(r => ({
      value: r.fileName,
      label: `${r.model} · ${r.title} · ${r.attachmentName}`,
    }))
  ), [rows])

  const [selectedFile, setSelectedFile] = useState(null)
  const [sheetNames, setSheetNames]     = useState([])
  const [selectedSheet, setSelectedSheet] = useState(null)
  const [sheetData, setSheetData]       = useState(null)
  const [sheetsLoading, setSheetsLoading] = useState(false)
  const [rowsLoading, setRowsLoading]   = useState(false)
  const [viewerError, setViewerError]   = useState(null)
  const [rowSearch, setRowSearch]       = useState('')

  const selectedRow = rows.find(r => r.fileName === selectedFile)

  useEffect(() => {
    if (!selectedFile) { setSheetNames([]); setSelectedSheet(null); setSheetData(null); return }
    setViewerError(null)
    setSheetData(null)
    setSheetsLoading(true)
    fetch(`/api/wts/files/${encodeURIComponent(selectedFile)}/sheets`)
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setSheetNames(json.sheetNames)
        setSelectedSheet(json.sheetNames[0] || null)
      })
      .catch(e => setViewerError(e.message))
      .finally(() => setSheetsLoading(false))
  }, [selectedFile])

  useEffect(() => {
    if (!selectedFile || !selectedSheet) return
    setViewerError(null)
    setRowsLoading(true)
    fetch(`/api/wts/files/${encodeURIComponent(selectedFile)}/sheet?name=${encodeURIComponent(selectedSheet)}`)
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setSheetData(json)
      })
      .catch(e => setViewerError(e.message))
      .finally(() => setRowsLoading(false))
  }, [selectedFile, selectedSheet])

  const displayedRows = useMemo(() => {
    if (!sheetData) return []
    const q = rowSearch.trim().toLowerCase()
    if (!q) return sheetData.rows
    return sheetData.rows.filter(row =>
      sheetData.columns.some(c => String(row[c] ?? '').toLowerCase().includes(q))
    )
  }, [sheetData, rowSearch])

  return (
    <>
      <div className="comparison-toolbar">
        <SearchableSelect
          options={xlsxOptions}
          value={selectedFile}
          onChange={val => { setSelectedFile(val); setRowSearch('') }}
          placeholder="Search & choose a BOM spreadsheet…"
        />
        {sheetNames.length > 1 && (
          <select className="pn-select" value={selectedSheet || ''} onChange={e => setSelectedSheet(e.target.value)}>
            {sheetNames.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        {sheetData && (
          <input
            className="table-search"
            type="text"
            placeholder="Filter rows containing…"
            value={rowSearch}
            onChange={e => setRowSearch(e.target.value)}
          />
        )}
        {selectedFile && (
          <a className="filter-btn" href={`/api/wts/files/${encodeURIComponent(selectedFile)}/download`} download>
            Download original file
          </a>
        )}
      </div>

      {!selectedFile && (
        <div className="state-box" style={{ padding: '1.5rem' }}>
          <p>Pick a spreadsheet above to view its contents.</p>
        </div>
      )}

      {selectedFile && selectedRow && (
        <p className="filter-hint" style={{ marginBottom: '.75rem' }}>
          Model {selectedRow.model} · Seq {selectedRow.sequence || '—'} · Rev {selectedRow.revision || '—'} · Work item {selectedRow.workItemId}
        </p>
      )}

      {(sheetsLoading || rowsLoading) && <StateBox type="loading" title="Loading spreadsheet…" />}
      {!sheetsLoading && !rowsLoading && viewerError && <StateBox type="error" message={viewerError} />}

      {sheetData && !sheetsLoading && !rowsLoading && !viewerError && (
        <>
          <p className="filter-hint" style={{ marginBottom: '.5rem' }}>
            {displayedRows.length} of {sheetData.rowCount} row(s) × {sheetData.colCount} column(s)
            {sheetData.truncated && ' — showing the first 5,000 rows'}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>{sheetData.columns.map(c => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {displayedRows.map((row, i) => (
                  <tr key={i}>
                    {sheetData.columns.map(c => <td key={c}>{String(row[c] ?? '')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  )
}

export default function MsftProjectsPage() {
  const [rows, setRows]                     = useState([])
  const [dataDirConfigured, setDataDirConfigured] = useState(true)
  const [indexExists, setIndexExists]       = useState(true)
  const [lastFetchedAt, setLastFetchedAt]   = useState(null)
  const [loading, setLoading]               = useState(true)
  const [error, setError]                   = useState(null)

  const [activeTab, setActiveTab]     = useState('index')
  const [colFilters, setColFilters]   = useState(EMPTY_FILTERS)
  const [search, setSearch]           = useState('')
  const [breakdownKey, setBreakdownKey] = useState('model')

  useEffect(() => {
    fetch('/api/wts/index')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setDataDirConfigured(json.dataDirConfigured)
        setIndexExists(json.indexExists)
        setLastFetchedAt(json.lastFetchedAt)
        setRows(json.items)
      })
      .catch(e => setError('Network error: ' + e.message))
      .finally(() => setLoading(false))
  }, [])

  // A row passes if every *active* column filter matches it. `excludeKey`
  // skips one column's own filter — used to build that column's own
  // suggestion list from rows narrowed by every *other* active filter, so
  // picking a value in one column cascades into what's offered in the rest.
  function rowMatchesFilters(r, excludeKey) {
    return FILTER_COLUMNS.every(col => {
      if (col.key === excludeKey) return true
      const q = colFilters[col.key].trim().toLowerCase()
      if (!q) return true
      return col.get(r).toLowerCase().includes(q)
    })
  }

  const columnOptions = useMemo(() => {
    const opts = {}
    for (const col of FILTER_COLUMNS) {
      const candidateRows = rows.filter(r => rowMatchesFilters(r, col.key))
      opts[col.key] = uniqSorted(candidateRows.map(col.get))
    }
    return opts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, colFilters])

  function setColFilter(key, val) {
    setColFilters(prev => ({ ...prev, [key]: val }))
  }
  function clearFilters() {
    setColFilters(EMPTY_FILTERS)
    setSearch('')
  }
  const filtersActive = FILTER_COLUMNS.some(c => colFilters[c.key].trim()) || !!search.trim()

  const filteredRows = useMemo(() => {
    let out = rows.filter(r => rowMatchesFilters(r, null))
    const q = search.trim().toLowerCase()
    if (q) out = out.filter(r => (r.title || '').toLowerCase().includes(q))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, colFilters, search])

  const distinctModels   = useMemo(() => new Set(filteredRows.map(r => r.model)).size, [filteredRows])
  const spreadsheetCount = useMemo(() => filteredRows.filter(r => r.fileType === 'xlsx').length, [filteredRows])

  const tabs = [
    { id: 'index',  label: 'Index', count: rows.length },
    { id: 'sheets', label: 'Spreadsheet Viewer' },
  ]

  const noDataYet = !loading && !error && (!dataDirConfigured || !indexExists)

  return (
    <div className="app-body">
      <main>
        {loading && (
          <StateBox
            type="loading"
            title="Loading MSFT Projects…"
            message="Reading the WTS index."
          />
        )}
        {!loading && error && <StateBox type="error" message={error} />}

        {!loading && !error && !dataDirConfigured && (
          <StateBox
            type="empty"
            title="WTS_DATA_DIR isn't configured"
            message="Set WTS_DATA_DIR in config/credentials/wts.env (copy wts.env.example), then reload this page."
          />
        )}
        {!loading && !error && dataDirConfigured && !indexExists && (
          <StateBox
            type="empty"
            title="No data yet"
            message="Run python wts_fetch.py (in HQ Fetching/wts_dashboard) to pull the latest WTS work items, then reload this page."
          />
        )}
        {!loading && !error && !noDataYet && rows.length === 0 && (
          <StateBox
            type="empty"
            title="No matching work items"
            message="The WTS index has no CRD/SKU/FRU work items yet."
          />
        )}

        {!loading && !error && !noDataYet && rows.length > 0 && (
          <>
            <TabBar tabs={tabs} activeTab={activeTab} onSwitch={setActiveTab} />

            {activeTab === 'index' && (
              <>
                <section className="dashboard-section">
                  <div className="section-title">Dashboard</div>
                  <div className="stat-cards dashboard-stat-cards">
                    <div className="stat-card">
                      <div className="val">{filteredRows.length}</div>
                      <div className="lbl">Work Items</div>
                    </div>
                    <div className="stat-card">
                      <div className="val">{distinctModels}</div>
                      <div className="lbl">Models</div>
                    </div>
                    <div className="stat-card">
                      <div className="val">{spreadsheetCount}</div>
                      <div className="lbl">Spreadsheets</div>
                    </div>
                    <div className="stat-card">
                      <div className="val">{formatDateTime(lastFetchedAt)}</div>
                      <div className="lbl">Last Fetch</div>
                    </div>
                  </div>
                </section>

                <div className="comparison-toolbar">
                  <span className="filter-hint">Type in a column header to filter &amp; see suggestions</span>
                  <input
                    className="table-search"
                    type="text"
                    placeholder="Search title…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                  />
                  <select className="pn-select" value={breakdownKey} onChange={e => setBreakdownKey(e.target.value)}>
                    {FILTER_COLUMNS.map(c => (
                      <option key={c.key} value={c.key}>Break down by {c.label}</option>
                    ))}
                  </select>
                  {filtersActive && (
                    <button className="filter-btn" onClick={clearFilters}>Clear Filters</button>
                  )}
                </div>

                <BreakdownChart
                  rows={filteredRows}
                  groupKey={breakdownKey}
                  groupLabel={FILTER_COLUMNS.find(c => c.key === breakdownKey)?.label}
                />

                {filteredRows.length === 0 ? (
                  <div className="state-box" style={{ padding: '1.5rem' }}>
                    <p>No work items match the current filters.</p>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Model</th><th>Type</th><th>Project</th><th>State</th><th>Revision</th>
                          <th>Sequence</th><th>Work Item</th><th>Title</th><th>Attachment</th>
                          <th>Changed</th><th>File Type</th>
                        </tr>
                        <tr className="col-filter-row">
                          {FILTER_COLUMNS.map(col => (
                            <th key={col.key}>
                              <ColumnFilter
                                value={colFilters[col.key]}
                                onChange={val => setColFilter(col.key, val)}
                                options={columnOptions[col.key]}
                              />
                            </th>
                          ))}
                          <th /><th /><th /><th /><th /><th />
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRows.map(r => (
                          <tr key={`${r.workItemId}-${r.fileName}`}>
                            <td>{r.model || '—'}</td>
                            <td>{r.keyword || '—'}</td>
                            <td>{r.project || '—'}</td>
                            <td>{r.state || '—'}</td>
                            <td>{r.revision || '—'}</td>
                            <td>{r.sequence || '—'}</td>
                            <td className="mono">{r.workItemId}</td>
                            <td>{r.title}</td>
                            <td className="mono">{r.attachmentName}</td>
                            <td>{formatDay(r.changedDate)}</td>
                            <td>{r.fileType}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {activeTab === 'sheets' && <SpreadsheetViewer rows={rows} />}
          </>
        )}
      </main>
    </div>
  )
}
