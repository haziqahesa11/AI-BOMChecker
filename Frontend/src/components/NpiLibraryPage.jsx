import { useState, useEffect, useMemo, Fragment } from 'react'
import StateBox from './StateBox'
import ComboInput from './ComboInput'
import SearchableSelect from './SearchableSelect'
import TabBar from './TabBar'
import { uniqSorted } from '../lib/crdTrackerUtils'

const GENS = [8, 9, 10, 11]
const MAX_BREAKDOWN_BARS = 12
const RECENT_DAYS = 14
const RECENT_SIDEBAR_MAX = 8

function formatDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function daysAgo(iso) {
  if (!iso) return Infinity
  return (Date.now() - new Date(iso).getTime()) / 86400000
}

function formatRelative(iso) {
  const d = daysAgo(iso)
  if (!Number.isFinite(d)) return '—'
  if (d < 1) return 'Today'
  if (d < 2) return 'Yesterday'
  return `${Math.floor(d)} days ago`
}

function formatBytes(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

// Same "click a stat-card, a breakdown table appears below the row" idiom as
// CrdTrackerPage's expandedStat / MsftProjectsPage's BreakdownChart, but with
// clickable bars so drilling into a Business Group narrows the table below.
function ClickableBreakdown({ rows, groupKey, groupLabel, selected, onSelect }) {
  const counts = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const v = r[groupKey] || '—'
      m.set(v, (m.get(v) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows, groupKey])

  if (counts.length === 0) return null
  const max = counts[0][1]
  const shown = counts.slice(0, MAX_BREAKDOWN_BARS)

  return (
    <div className="dist-chart">
      <div className="dist-chart-title">
        {groupLabel} breakdown
        {selected && <button type="button" className="filter-btn" style={{ marginLeft: '.75rem' }} onClick={() => onSelect(null)}>Clear ✕</button>}
      </div>
      {shown.map(([label, count]) => (
        <button
          type="button"
          key={label}
          className={`dist-bar-row npi-dist-bar-btn${selected === label ? ' active' : ''}`}
          onClick={() => onSelect(selected === label ? null : label)}
        >
          <div className="dist-bar-label">{label}</div>
          <div className="dist-bar-track">
            <div className="dist-bar-fill" style={{ width: `${(count / max) * 100}%`, background: 'var(--primary)' }} />
          </div>
          <div className="dist-bar-val">{count}</div>
        </button>
      ))}
    </div>
  )
}

function SkuDetail({ sku, crossTables, onOpenInViewer }) {
  const entries = Object.entries(sku.partProperties || {})
  return (
    <div className="npi-detail-panel">
      <div className="dashboard-breakdown-header">
        <span>{sku.itemNumber} · Rev {sku.revision}</span>
        <div className="filter-btns">
          <a className="filter-btn" href={`/api/npi/skus/${encodeURIComponent(sku.itemNumber)}/${encodeURIComponent(sku.revision)}/download`} download>
            Download BOM master
          </a>
          <button type="button" className="filter-btn" onClick={() => onOpenInViewer({ kind: 'sku', itemNumber: sku.itemNumber, revision: sku.revision })}>
            Open in Spreadsheet Viewer
          </button>
        </div>
      </div>

      <p className="filter-hint" style={{ marginBottom: '.5rem' }}>Linked MSF orders</p>
      <div className="table-wrap" style={{ marginBottom: '1rem' }}>
        <table>
          <thead><tr><th>MSF #</th><th>Folder</th><th>Status</th></tr></thead>
          <tbody>
            {sku.orders.map(o => (
              <tr key={o.folderName}>
                <td className="mono">{o.msfNumber || '—'}</td>
                <td>{o.folderName}</td>
                <td>{o.isDw ? <span className="badge-grey">DW of {o.dwOfMsfNumber}</span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {crossTables.length > 0 && (
        <>
          <p className="filter-hint" style={{ marginBottom: '.5rem' }}>Gen {sku.gen} Cross Table (approved alternates / vendor options)</p>
          <div className="filter-btns" style={{ marginBottom: '1rem' }}>
            {crossTables.map(c => (
              <button
                type="button"
                key={c.fileName}
                className="filter-btn"
                onClick={() => onOpenInViewer({ kind: 'xtab', gen: c.gen, fileName: c.fileName })}
              >
                {c.fileName}
              </button>
            ))}
          </div>
        </>
      )}

      <p className="filter-hint" style={{ marginBottom: '.5rem' }}>Part Properties</p>
      <div className="table-wrap">
        <table>
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}><td style={{ fontWeight: 700 }}>{k}</td><td>{v || '—'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// SharePoint-style folder browser: a breadcrumb (NPI Library > Gen N [>
// Business Group]) driven by the dashboard's own stat-cards/breakdown above
// it, and a Name/Modified/Version/File Size table beneath. "Modified By"
// isn't shown — that's SharePoint's own cloud metadata (who touched a file),
// which a plain filesystem read has no access to.
function Breadcrumb({ selectedGen, selectedBusinessGroup, onGen, onBusinessGroup }) {
  return (
    <div className="npi-breadcrumb">
      <button type="button" className="npi-crumb" onClick={() => onGen(null)}>NPI Library</button>
      {selectedGen && (
        <>
          <span className="npi-crumb-sep">›</span>
          <button type="button" className="npi-crumb" onClick={() => onBusinessGroup(null)}>Gen {selectedGen}</button>
        </>
      )}
      {selectedBusinessGroup && (
        <>
          <span className="npi-crumb-sep">›</span>
          <span className="npi-crumb npi-crumb-current">{selectedBusinessGroup}</span>
        </>
      )}
    </div>
  )
}

function BrowserTable({ rows, expandedKey, onRowClick, crossTablesByGen, onOpenInViewer }) {
  if (rows.length === 0) {
    return <div className="state-box" style={{ padding: '1.5rem' }}><p>No items match the current filters.</p></div>
  }
  return (
    <div className="table-wrap">
      <table className="npi-browser-table">
        <thead>
          <tr><th>Name</th><th>Modified</th><th>Version</th><th>File Size</th></tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <Fragment key={row.key}>
              <tr
                className={`npi-browser-row${expandedKey === row.key ? ' active' : ''}`}
                onClick={() => onRowClick(row)}
              >
                <td>
                  {row.kind === 'xtab' ? '📊 ' : '📄 '}{row.name}
                  {row.kind === 'sku' && <span className="badge-grey" style={{ marginLeft: '.5rem' }}>Rev {row.sku.revision}</span>}
                </td>
                <td>{formatDate(row.modifiedAt)}</td>
                <td>{row.kind === 'sku' ? row.sku.revision : '—'}</td>
                <td>{formatBytes(row.sizeBytes)}</td>
              </tr>
              {expandedKey === row.key && row.kind === 'sku' && (
                <tr>
                  <td colSpan={4}>
                    <SkuDetail sku={row.sku} crossTables={crossTablesByGen(row.sku.gen)} onOpenInViewer={onOpenInViewer} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RecentlyUpdatedSidebar({ skus, crossTables, onJump }) {
  const items = useMemo(() => {
    const all = [
      ...skus.map(s => ({ kind: 'sku', gen: s.gen, name: s.itemNumber, modifiedAt: s.modifiedAt, itemNumber: s.itemNumber, revision: s.revision })),
      ...crossTables.map(c => ({ kind: 'xtab', gen: c.gen, name: c.fileName, modifiedAt: c.modifiedAt, fileName: c.fileName })),
    ].filter(x => x.modifiedAt)
    return all.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, RECENT_SIDEBAR_MAX)
  }, [skus, crossTables])

  const recentCount = items.filter(x => daysAgo(x.modifiedAt) <= RECENT_DAYS).length

  return (
    <aside className="anomaly-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Recently Updated</span>
        <span className={`sidebar-badge ${recentCount > 0 ? 'info' : 'all-clear'}`}>{recentCount}</span>
      </div>
      <div className="sidebar-list">
        {items.length === 0 ? (
          <div className="sidebar-all-pass">No file activity yet</div>
        ) : items.map(it => (
          <div key={`${it.kind}:${it.name}`} className="sidebar-item" onClick={() => onJump(it)}>
            <div className="sidebar-item-type" style={{ color: daysAgo(it.modifiedAt) <= RECENT_DAYS ? 'var(--info-fg)' : 'var(--muted)' }}>
              Gen {it.gen}{daysAgo(it.modifiedAt) <= RECENT_DAYS ? ' · NEW' : ''}
            </div>
            <div className="sidebar-item-loc">{it.name}</div>
            <div className="sidebar-item-detail">{formatRelative(it.modifiedAt)}</div>
          </div>
        ))}
      </div>
      <p className="npi-sidebar-note">
        Manual updates by the NPI lead show up here after re-running the indexer.
        Automated change detection (who + what changed) is a later integration.
      </p>
    </aside>
  )
}

// Tab 2 — pick an indexed SKU BOM master or Cross Table file and browse its
// sheets in-browser. Mirrors MsftProjectsPage's SpreadsheetViewer, but the
// option list spans two file families dispatched to different endpoints.
function SpreadsheetViewer({ skus, crossTables, preselect, onConsumePreselect }) {
  const options = useMemo(() => ([
    ...skus.map(s => ({
      value: `sku:${s.itemNumber}:${s.revision}`,
      label: `${s.itemNumber} Rev ${s.revision} · ${s.businessGroup || '—'}/${s.role || '—'} · Gen ${s.gen}`,
    })),
    ...crossTables.map(c => ({
      value: `xtab:${c.gen}:${c.fileName}`,
      label: `Gen ${c.gen} · Cross Table · ${c.fileName}`,
    })),
  ]), [skus, crossTables])

  const [selectedKey, setSelectedKey] = useState(null)
  const [sheetNames, setSheetNames]     = useState([])
  const [selectedSheet, setSelectedSheet] = useState(null)
  const [sheetData, setSheetData]       = useState(null)
  const [sheetsLoading, setSheetsLoading] = useState(false)
  const [rowsLoading, setRowsLoading]   = useState(false)
  const [viewerError, setViewerError]   = useState(null)
  const [rowSearch, setRowSearch]       = useState('')

  useEffect(() => {
    if (preselect) {
      const key = preselect.kind === 'sku'
        ? `sku:${preselect.itemNumber}:${preselect.revision}`
        : `xtab:${preselect.gen}:${preselect.fileName}`
      setSelectedKey(key)
      onConsumePreselect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselect])

  function endpointBase(key) {
    const [kind, ...rest] = key.split(':')
    if (kind === 'sku') {
      const [itemNumber, revision] = rest
      return `/api/npi/skus/${encodeURIComponent(itemNumber)}/${encodeURIComponent(revision)}`
    }
    const [gen, ...fileParts] = rest
    return `/api/npi/cross-tables/${encodeURIComponent(gen)}/${encodeURIComponent(fileParts.join(':'))}`
  }

  useEffect(() => {
    if (!selectedKey) { setSheetNames([]); setSelectedSheet(null); setSheetData(null); return }
    setViewerError(null)
    setSheetData(null)
    setSheetsLoading(true)
    fetch(`${endpointBase(selectedKey)}/sheets`)
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setSheetNames(json.sheetNames)
        setSelectedSheet(json.sheetNames[0] || null)
      })
      .catch(e => setViewerError(e.message))
      .finally(() => setSheetsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  useEffect(() => {
    if (!selectedKey || !selectedSheet) return
    setViewerError(null)
    setRowsLoading(true)
    fetch(`${endpointBase(selectedKey)}/sheet?name=${encodeURIComponent(selectedSheet)}`)
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setSheetData(json)
      })
      .catch(e => setViewerError(e.message))
      .finally(() => setRowsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, selectedSheet])

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
          options={options}
          value={selectedKey}
          onChange={val => { setSelectedKey(val); setRowSearch('') }}
          placeholder="Search & choose a SKU BOM or Cross Table…"
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
        {selectedKey && (
          <a className="filter-btn" href={`${endpointBase(selectedKey)}/download`} download>
            Download original file
          </a>
        )}
      </div>

      {!selectedKey && (
        <div className="state-box" style={{ padding: '1.5rem' }}>
          <p>Pick a SKU BOM master or Cross Table above to view its contents.</p>
        </div>
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

export default function NpiLibraryPage() {
  const [skus, setSkus]                     = useState([])
  const [crossTables, setCrossTables]       = useState([])
  const [dataDirConfigured, setDataDirConfigured] = useState(true)
  const [indexExists, setIndexExists]       = useState(true)
  const [generatedAt, setGeneratedAt]       = useState(null)
  const [loading, setLoading]               = useState(true)
  const [error, setError]                   = useState(null)

  const [activeTab, setActiveTab]           = useState('library')
  const [selectedGen, setSelectedGen]       = useState(null)
  const [selectedBusinessGroup, setSelectedBusinessGroup] = useState(null)
  const [roleFilter, setRoleFilter]         = useState('')
  const [subroleFilter, setSubroleFilter]   = useState('')
  const [expandedKey, setExpandedKey]       = useState(null)
  const [viewerPreselect, setViewerPreselect] = useState(null)

  useEffect(() => {
    fetch('/api/npi/index')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setDataDirConfigured(json.dataDirConfigured)
        setIndexExists(json.indexExists)
        setGeneratedAt(json.generatedAt)
        setSkus(json.items)
        setCrossTables(json.crossTables || [])
      })
      .catch(e => setError('Network error: ' + e.message))
      .finally(() => setLoading(false))
  }, [])

  const genCounts = useMemo(() => {
    const m = new Map(GENS.map(g => [g, 0]))
    for (const s of skus) m.set(s.gen, (m.get(s.gen) || 0) + 1)
    return m
  }, [skus])

  const byGen = useMemo(() => (
    selectedGen ? skus.filter(s => s.gen === selectedGen) : skus
  ), [skus, selectedGen])

  const byBusinessGroup = useMemo(() => (
    selectedBusinessGroup ? byGen.filter(s => (s.businessGroup || '—') === selectedBusinessGroup) : byGen
  ), [byGen, selectedBusinessGroup])

  const roleOptions = useMemo(() => uniqSorted(byBusinessGroup.map(s => s.role)), [byBusinessGroup])
  const subroleOptions = useMemo(() => uniqSorted(byBusinessGroup.map(s => s.subrole)), [byBusinessGroup])

  const filteredSkus = useMemo(() => {
    const rq = roleFilter.trim().toLowerCase()
    const sq = subroleFilter.trim().toLowerCase()
    return byBusinessGroup.filter(s =>
      (!rq || (s.role || '').toLowerCase().includes(rq)) &&
      (!sq || (s.subrole || '').toLowerCase().includes(sq))
    )
  }, [byBusinessGroup, roleFilter, subroleFilter])

  const filtersActive = !!selectedGen || !!selectedBusinessGroup || !!roleFilter.trim() || !!subroleFilter.trim()
  function clearFilters() {
    setSelectedGen(null)
    setSelectedBusinessGroup(null)
    setRoleFilter('')
    setSubroleFilter('')
  }

  function crossTablesByGen(gen) {
    return crossTables.filter(c => c.gen === gen)
  }

  // The folder-browser table: SKUs (deduped) plus, once a Gen is selected,
  // that Gen's Cross Table file(s) — sorted alphabetically like a real file
  // browser, not by recency (that's what the sidebar is for).
  const browserRows = useMemo(() => {
    const skuRows = filteredSkus.map(s => ({
      kind: 'sku',
      key: `${s.itemNumber}::${s.revision}`,
      name: s.itemNumber,
      modifiedAt: s.modifiedAt,
      sizeBytes: s.sizeBytes,
      sku: s,
    }))
    const xtabRows = selectedGen ? crossTablesByGen(selectedGen).map(c => ({
      kind: 'xtab',
      key: `xtab:${c.gen}:${c.fileName}`,
      name: c.fileName,
      modifiedAt: c.modifiedAt,
      sizeBytes: c.sizeBytes,
      xtab: c,
    })) : []
    return [...skuRows, ...xtabRows].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSkus, crossTables, selectedGen])

  function openInViewer(target) {
    setViewerPreselect(target)
    setActiveTab('sheets')
  }

  function handleRowClick(row) {
    if (row.kind === 'sku') {
      setExpandedKey(prev => prev === row.key ? null : row.key)
    } else {
      openInViewer({ kind: 'xtab', gen: row.xtab.gen, fileName: row.xtab.fileName })
    }
  }

  function jumpToRecent(item) {
    setSelectedGen(item.gen)
    setSelectedBusinessGroup(null)
    setRoleFilter('')
    setSubroleFilter('')
    if (item.kind === 'sku') {
      setExpandedKey(`${item.itemNumber}::${item.revision}`)
      setActiveTab('library')
    } else {
      openInViewer({ kind: 'xtab', gen: item.gen, fileName: item.fileName })
    }
  }

  const tabs = [
    { id: 'library', label: 'Library', count: skus.length },
    { id: 'sheets', label: 'Spreadsheet Viewer' },
  ]

  const noDataYet = !loading && !error && (!dataDirConfigured || !indexExists)
  const showSidebar = !loading && !error && !noDataYet && skus.length > 0 && activeTab === 'library'

  return (
    <div className="app-body">
      <main>
        {loading && (
          <StateBox type="loading" title="Loading NPI Library…" message="Reading the NPI index." />
        )}
        {!loading && error && <StateBox type="error" message={error} />}

        {!loading && !error && !dataDirConfigured && (
          <StateBox
            type="empty"
            title="NPI_DATA_DIR isn't configured"
            message="Set NPI_DATA_DIR in config/credentials/npi.env (copy npi.env.example), then reload this page."
          />
        )}
        {!loading && !error && dataDirConfigured && !indexExists && (
          <StateBox
            type="empty"
            title="No index yet"
            message="Run node BackEnd/scripts/build-npi-index.js to build the NPI Library index, then reload this page."
          />
        )}
        {!loading && !error && !noDataYet && skus.length === 0 && (
          <StateBox type="empty" title="No SKUs found" message="The NPI index has no SKU BOM masters yet." />
        )}

        {!loading && !error && !noDataYet && skus.length > 0 && (
          <>
            <TabBar tabs={tabs} activeTab={activeTab} onSwitch={setActiveTab} />

            {activeTab === 'library' && (
              <>
                <section className="dashboard-section">
                  <div className="section-title">Dashboard</div>
                  <p className="filter-hint" style={{ marginBottom: '.5rem' }}>
                    {skus.length} unique SKU(s) · generated {generatedAt ? new Date(generatedAt).toLocaleString() : '—'}
                  </p>

                  <div className="stat-cards dashboard-stat-cards">
                    {GENS.map(g => (
                      <button
                        type="button"
                        key={g}
                        className={`stat-card dashboard-stat-card ${selectedGen === g ? 'active' : ''}`}
                        onClick={() => setSelectedGen(s => s === g ? null : g)}
                      >
                        <div className="val">{genCounts.get(g)}</div>
                        <div className="lbl">Gen {g}</div>
                      </button>
                    ))}
                  </div>

                  <ClickableBreakdown
                    rows={byGen}
                    groupKey="businessGroup"
                    groupLabel="Business Group"
                    selected={selectedBusinessGroup}
                    onSelect={setSelectedBusinessGroup}
                  />
                </section>

                <Breadcrumb
                  selectedGen={selectedGen}
                  selectedBusinessGroup={selectedBusinessGroup}
                  onGen={() => { setSelectedGen(null); setSelectedBusinessGroup(null) }}
                  onBusinessGroup={setSelectedBusinessGroup}
                />

                <div className="comparison-toolbar" style={{ marginBottom: '.75rem' }}>
                  <ComboInput value={roleFilter} onChange={setRoleFilter} options={roleOptions} placeholder="Filter by Role…" />
                  <ComboInput value={subroleFilter} onChange={setSubroleFilter} options={subroleOptions} placeholder="Filter by Subrole…" />
                  {filtersActive && (
                    <button className="filter-btn" onClick={clearFilters}>Clear Filters</button>
                  )}
                </div>

                <BrowserTable
                  rows={browserRows}
                  expandedKey={expandedKey}
                  onRowClick={handleRowClick}
                  crossTablesByGen={crossTablesByGen}
                  onOpenInViewer={openInViewer}
                />
              </>
            )}

            {activeTab === 'sheets' && (
              <SpreadsheetViewer
                skus={skus}
                crossTables={crossTables}
                preselect={viewerPreselect}
                onConsumePreselect={() => setViewerPreselect(null)}
              />
            )}
          </>
        )}
      </main>

      {showSidebar && (
        <RecentlyUpdatedSidebar skus={skus} crossTables={crossTables} onJump={jumpToRecent} />
      )}
    </div>
  )
}
