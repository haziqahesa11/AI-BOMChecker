import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import StateBox from './StateBox'
import ComboInput from './ComboInput'
import CrdUpdateModal from './CrdUpdateModal'
import { uniqSorted, uniqByLineId } from '../lib/crdTrackerUtils'

function formatGen(gen) {
  if (gen === null || gen === undefined || gen === '') return '—'
  const n = Number(gen)
  return Number.isFinite(n) ? n.toFixed(1) : gen
}

const COLUMN_COUNT = 13 // No, Gen, L11 MSF, L11 SKU, CRD #, L10 MSF, L10 SKU,
                         // WTS Ticket #, WTS Link, Current CRD (TE), Date Update,
                         // Latest CRD, History

// Columns that get a per-column filter, in table order. `get` pulls the
// filterable/display string for a row; used both for filtering and for
// building each column's suggestion list.
const FILTER_COLUMNS = [
  { key: 'no',        label: 'No',           get: r => String(r.no) },
  { key: 'gen',        label: 'Gen',          get: r => formatGen(r.gen) },
  { key: 'l11Msf',     label: 'L11 MSF',      get: r => r.l11Msf || '' },
  { key: 'l11Sku',     label: 'L11 SKU',      get: r => r.l11Sku || '' },
  { key: 'crdNumber',  label: 'CRD #',        get: r => r.crdNumber || '' },
  { key: 'l10Msf',     label: 'L10 MSF',      get: r => r.l10Msf || '' },
  { key: 'l10Sku',     label: 'L10 SKU',      get: r => r.l10Sku || '' },
  { key: 'wtsTicket',  label: 'WTS Ticket #', get: r => r.wtsTicket || '' },
]

function coveragePct(filled, total) {
  return total > 0 ? (filled / total) * 100 : 0
}

// Groups COMPONENT rows (coverage is graded at component granularity, since
// current_crd_te lives on crdbom_component) by keyFn, counting how many have
// current_crd_te filled in. Rows with no component (a line with zero L10 parts)
// are excluded — there's nothing to grade. Breakdown is sorted worst-coverage-first
// so the dashboard surfaces what needs attention without extra sorting.
function computeCoverage(rows, keyFn) {
  const groups = new Map() // key -> { total, filled }
  for (const r of rows) {
    if (r.componentId == null) continue
    const raw = keyFn(r)
    const key = raw === null || raw === undefined || raw === '' ? '(blank)' : raw
    const g = groups.get(key) || { total: 0, filled: 0 }
    g.total += 1
    if (r.currentCrdTe !== null && r.currentCrdTe !== undefined && r.currentCrdTe !== '') g.filled += 1
    groups.set(key, g)
  }

  let totalComponents = 0, totalFilled = 0
  const breakdown = [...groups.entries()].map(([value, g]) => {
    totalComponents += g.total
    totalFilled += g.filled
    return { value, total: g.total, filled: g.filled, pct: coveragePct(g.filled, g.total) }
  })
  breakdown.sort((a, b) => a.pct - b.pct || b.total - a.total || a.value.localeCompare(b.value))

  return {
    distinctCount: groups.size,
    totalComponents,
    totalFilled,
    coveragePct: coveragePct(totalFilled, totalComponents),
    breakdown,
  }
}

function coverageColor(pct) {
  if (pct >= 90) return 'var(--pass-fg)'
  if (pct >= 70) return 'var(--warn-fg)'
  return 'var(--fail-fg)'
}
function coverageModifier(pct) {
  if (pct >= 90) return 'pass'
  if (pct >= 70) return 'warn'
  return 'fail'
}

// Table-header column filter is just a ComboInput whose suggestions are the
// column's own registered values instead of a fixed option list.
function ColumnFilter({ value, onChange, options }) {
  return <ComboInput value={value} onChange={onChange} options={options} />
}

const EMPTY_FILTERS = Object.fromEntries(FILTER_COLUMNS.map(c => [c.key, '']))

export default function CrdTrackerPage() {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [colFilters, setColFilters] = useState(EMPTY_FILTERS)

  const [expandedLineId, setExpandedLineId] = useState(null)
  const [historyCache, setHistoryCache]     = useState({}) // lineId -> {loading, error, history}

  const [currentIsoYear, setCurrentIsoYear]   = useState(null)
  const [currentWorkWeek, setCurrentWorkWeek] = useState(null)
  const [expandedStat, setExpandedStat]       = useState(null) // 'l11Msf'|'l10Msf'|'crdNumber'|'thisWeek'|null

  const tableWrapRef = useRef(null)
  const [scrollToLineNo, setScrollToLineNo] = useState(null)
  const [updateModalOpen, setUpdateModalOpen] = useState(false)

  function refetchLines() {
    return fetch('/api/crd-tracker/lines')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setRows(json.rows)
        setCurrentIsoYear(json.currentIsoYear)
        setCurrentWorkWeek(json.currentWorkWeek)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    refetchLines()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Runs after the colFilters-driven re-render (triggered by jumpToLine below) has
  // committed, so the table is already showing the filtered row before we scroll to it.
  useEffect(() => {
    if (scrollToLineNo == null) return
    tableWrapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setScrollToLineNo(null)
  }, [scrollToLineNo])

  function toggleHistory(lineId) {
    if (expandedLineId === lineId) {
      setExpandedLineId(null)
      return
    }
    setExpandedLineId(lineId)
    if (historyCache[lineId]) return // already cached — no refetch
    setHistoryCache(prev => ({ ...prev, [lineId]: { loading: true, error: null, history: [] } }))
    fetch(`/api/crd-tracker/lines/${lineId}/history`)
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setHistoryCache(prev => ({ ...prev, [lineId]: { loading: false, error: null, history: json.history } }))
      })
      .catch(e => {
        setHistoryCache(prev => ({ ...prev, [lineId]: { loading: false, error: e.message, history: [] } }))
      })
  }

  // A row passes if every *active* column filter matches it. `excludeKey` skips
  // one column's own filter — used to build that column's own suggestion list
  // from rows narrowed by every *other* currently active filter, so picking a
  // value in one column (e.g. Gen) cascades into what's offered in the rest.
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
  }
  const filtersActive = FILTER_COLUMNS.some(c => colFilters[c.key].trim())

  const filteredRows = rows.filter(r => rowMatchesFilters(r, null))

  // Test rows are throwaway data — excluded from health metrics (coverage,
  // freshness) but still shown, badged, in the raw filterable table below
  // and in the Delete flow's picker.
  const realRows = useMemo(() => rows.filter(r => !r.isTest), [rows])
  const lineRows = useMemo(() => uniqByLineId(realRows), [realRows])

  const l11MsfCoverage    = useMemo(() => computeCoverage(realRows, r => r.l11Msf), [realRows])
  const l10MsfCoverage    = useMemo(() => computeCoverage(realRows, r => r.l10Msf), [realRows])
  const crdNumberCoverage = useMemo(() => computeCoverage(realRows, r => r.crdNumber), [realRows])

  const weekFreshness = useMemo(() => {
    if (currentIsoYear == null || currentWorkWeek == null) return null
    const staleLines = []
    let upToDateCount = 0
    for (const l of lineRows) {
      const isCurrent = l.latestIsoYear === currentIsoYear && l.latestWorkWeek === currentWorkWeek
      if (isCurrent) upToDateCount++
      else staleLines.push(l)
    }
    // Most-neglected first: never-updated lines (null) float to the top via -Infinity.
    staleLines.sort((a, b) =>
      (a.latestIsoYear ?? -Infinity) - (b.latestIsoYear ?? -Infinity) ||
      (a.latestWorkWeek ?? -Infinity) - (b.latestWorkWeek ?? -Infinity)
    )
    const totalLines = lineRows.length
    return {
      upToDateCount,
      staleCount: totalLines - upToDateCount,
      totalLines,
      pct: coveragePct(upToDateCount, totalLines),
      staleLines,
    }
  }, [lineRows, currentIsoYear, currentWorkWeek])

  function jumpToLine(line) {
    setColFilters({ ...EMPTY_FILTERS, no: String(line.no) })
    setExpandedStat(null)
    setScrollToLineNo(line.no)
  }

  return (
    <div className="app-body">
      <main>
        {loading && (
          <StateBox
            type="loading"
            title="Loading CRD Tracker…"
            message="Fetching latest CRD revision data from the tracking database."
          />
        )}
        {!loading && error && <StateBox type="error" message={error} />}
        {!loading && !error && rows.length === 0 && (
          <StateBox
            type="empty"
            title="No CRD Tracker Data"
            message="No lines were found in tracking.crdbom_line."
          />
        )}

        {!loading && !error && rows.length > 0 && (
          <>
            <section className="dashboard-section">
              <div className="section-title">Dashboard</div>

              <div className="stat-cards dashboard-stat-cards">
                <button
                  type="button"
                  className={`stat-card ${coverageModifier(l11MsfCoverage.coveragePct)} dashboard-stat-card ${expandedStat === 'l11Msf' ? 'active' : ''}`}
                  onClick={() => setExpandedStat(s => s === 'l11Msf' ? null : 'l11Msf')}
                >
                  <div className="val">{l11MsfCoverage.distinctCount}</div>
                  <div className="lbl">L11 MSF</div>
                  <div className="stat-card-sub" style={{ color: coverageColor(l11MsfCoverage.coveragePct) }}>
                    {l11MsfCoverage.coveragePct.toFixed(0)}% CRD (TE) filled
                  </div>
                </button>

                <button
                  type="button"
                  className={`stat-card ${coverageModifier(l10MsfCoverage.coveragePct)} dashboard-stat-card ${expandedStat === 'l10Msf' ? 'active' : ''}`}
                  onClick={() => setExpandedStat(s => s === 'l10Msf' ? null : 'l10Msf')}
                >
                  <div className="val">{l10MsfCoverage.distinctCount}</div>
                  <div className="lbl">L10 MSF</div>
                  <div className="stat-card-sub" style={{ color: coverageColor(l10MsfCoverage.coveragePct) }}>
                    {l10MsfCoverage.coveragePct.toFixed(0)}% CRD (TE) filled
                  </div>
                </button>

                <button
                  type="button"
                  className={`stat-card ${coverageModifier(crdNumberCoverage.coveragePct)} dashboard-stat-card ${expandedStat === 'crdNumber' ? 'active' : ''}`}
                  onClick={() => setExpandedStat(s => s === 'crdNumber' ? null : 'crdNumber')}
                >
                  <div className="val">{crdNumberCoverage.distinctCount}</div>
                  <div className="lbl">CRD #</div>
                  <div className="stat-card-sub" style={{ color: coverageColor(crdNumberCoverage.coveragePct) }}>
                    {crdNumberCoverage.coveragePct.toFixed(0)}% CRD (TE) filled
                  </div>
                </button>

                {weekFreshness && (
                  <button
                    type="button"
                    className={`stat-card ${coverageModifier(weekFreshness.pct)} dashboard-stat-card ${expandedStat === 'thisWeek' ? 'active' : ''}`}
                    onClick={() => setExpandedStat(s => s === 'thisWeek' ? null : 'thisWeek')}
                  >
                    <div className="val">{weekFreshness.upToDateCount} / {weekFreshness.totalLines}</div>
                    <div className="lbl">Updated This Week</div>
                    <div className="stat-card-sub" style={{ color: coverageColor(weekFreshness.pct) }}>
                      {weekFreshness.pct.toFixed(0)}% · Current: WW{currentWorkWeek} · {currentIsoYear}
                    </div>
                  </button>
                )}
              </div>

              {expandedStat && (
                <div className="dashboard-breakdown-wrap">
                  <div className="dashboard-breakdown-header">
                    <span>
                      {{
                        l11Msf: 'L11 MSF Breakdown',
                        l10Msf: 'L10 MSF Breakdown',
                        crdNumber: 'CRD # Breakdown',
                        thisWeek: 'Not Updated This Week',
                      }[expandedStat]}
                    </span>
                    <button
                      type="button"
                      className="filter-btn dashboard-breakdown-clear"
                      onClick={() => setExpandedStat(null)}
                    >
                      Clear ✕
                    </button>
                  </div>
                  <div className="dashboard-breakdown table-wrap">
                  {expandedStat !== 'thisWeek' ? (
                    <table>
                      <thead>
                        <tr>
                          <th>{{ l11Msf: 'L11 MSF', l10Msf: 'L10 MSF', crdNumber: 'CRD #' }[expandedStat]}</th>
                          <th># Components</th><th>Filled</th><th>Coverage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {{ l11Msf: l11MsfCoverage, l10Msf: l10MsfCoverage, crdNumber: crdNumberCoverage }[expandedStat]
                          .breakdown.map(b => (
                            <tr key={b.value}>
                              <td>{b.value}</td>
                              <td>{b.total}</td>
                              <td>{b.filled}</td>
                              <td style={{ color: coverageColor(b.pct), fontWeight: 700 }}>{b.pct.toFixed(0)}%</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  ) : weekFreshness.staleLines.length === 0 ? (
                    <p style={{ padding: '1rem' }}>All lines are up to date for the current work week.</p>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>No</th><th>L11 MSF</th><th>L11 SKU</th><th>CRD #</th>
                          <th>WTS Ticket #</th><th>Last Updated</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {weekFreshness.staleLines.map(l => (
                          <tr key={l.lineId}>
                            <td>{l.no}</td>
                            <td>{l.l11Msf || '—'}</td>
                            <td className="mono">{l.l11Sku || '—'}</td>
                            <td>{l.crdNumber || '—'}</td>
                            <td>{l.wtsTicket || '—'}</td>
                            <td>
                              {l.latestIsoYear != null
                                ? `Last: WW${l.latestWorkWeek} · ${l.latestIsoYear}`
                                : 'Never updated'}
                            </td>
                            <td>
                              <button className="filter-btn" onClick={() => jumpToLine(l)}>View in table</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  </div>
                </div>
              )}
            </section>

            <div className="comparison-toolbar">
              <span className="filter-hint">Type in a column header to filter &amp; see suggestions</span>
              <button className="search-btn crd-update-btn" onClick={() => { refetchLines(); setUpdateModalOpen(true) }}>+ Update</button>
              {filtersActive && (
                <button className="filter-btn" onClick={clearFilters}>Clear Filters</button>
              )}
            </div>

            {filteredRows.length === 0 ? (
              <div className="state-box" style={{ padding: '1.5rem' }}>
                <p>No lines match the current filters.</p>
              </div>
            ) : (
              <div className="table-wrap" ref={tableWrapRef}>
                <table>
                  <thead>
                    <tr>
                      <th>No</th><th>Gen</th><th>L11 MSF</th><th>L11 SKU</th>
                      <th>CRD #</th><th>L10 MSF</th><th>L10 SKU</th>
                      <th>WTS Ticket #</th><th>WTS Link</th>
                      <th>Current CRD (TE)</th><th>Date Update</th>
                      <th>Latest CRD</th><th>History</th>
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
                      <th /><th /><th /><th /><th />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((r, i) => {
                      const isLastOfLine = i === filteredRows.length - 1 || filteredRows[i + 1].lineId !== r.lineId
                      const expanded = expandedLineId === r.lineId
                      const hist = historyCache[r.lineId]
                      return (
                        <Fragment key={r.componentId}>
                          <tr>
                            <td>
                              {r.no}
                              {r.isTest && <span className="badge-grey" style={{ marginLeft: '.4rem' }}>TEST</span>}
                            </td>
                            <td className="mono">{formatGen(r.gen)}</td>
                            <td>{r.l11Msf || '—'}</td>
                            <td className="mono">{r.l11Sku || '—'}</td>
                            <td>{r.crdNumber || '—'}</td>
                            <td>{r.l10Msf || '—'}</td>
                            <td className="mono">{r.l10Sku || '—'}</td>
                            <td>{r.wtsTicket || '—'}</td>
                            <td>
                              {r.wtsLink
                                ? <a href={r.wtsLink} target="_blank" rel="noopener noreferrer">Open ↗</a>
                                : '—'}
                            </td>
                            <td className="mono">{r.currentCrdTe || '—'}</td>
                            <td>{r.dateUpdate || '—'}</td>
                            <td>
                              <span className="mono">{r.latestCrdCode || '—'}</span>
                              {r.latestWeekLabel && <div className="crd-week-sub">{r.latestWeekLabel}</div>}
                            </td>
                            <td>
                              <button
                                className={`filter-btn ${expanded ? 'active' : ''}`}
                                onClick={() => toggleHistory(r.lineId)}
                              >
                                {expanded ? 'Hide' : 'History'}
                              </button>
                            </td>
                          </tr>
                          {expanded && isLastOfLine && (
                            <tr className="crd-history-row">
                              <td colSpan={COLUMN_COUNT} className="crd-history-cell">
                                {hist?.loading && <p>Loading history…</p>}
                                {hist?.error && <p className="crd-history-error">⚠️ {hist.error}</p>}
                                {hist && !hist.loading && !hist.error && (
                                  hist.history.length === 0 ? (
                                    <p>No weekly history recorded for this line.</p>
                                  ) : (
                                    <div className="table-wrap">
                                      <table>
                                        <thead>
                                          <tr><th>Week</th><th>Week Start</th><th>CRD Code</th></tr>
                                        </thead>
                                        <tbody>
                                          {hist.history.map((h, i) => (
                                            <tr
                                              key={`${h.isoYear}-${h.workWeek}`}
                                              className={i === 0 ? 'crd-week-latest' : undefined}
                                            >
                                              <td>
                                                {h.weekLabel}
                                                {i === 0 && <span className="crd-latest-badge">LATEST</span>}
                                              </td>
                                              <td>{h.weekStartDate || '—'}</td>
                                              <td className="mono">{h.crdCode}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>

      {updateModalOpen && (
        <CrdUpdateModal
          rows={rows}
          currentIsoYear={currentIsoYear}
          currentWorkWeek={currentWorkWeek}
          onClose={() => setUpdateModalOpen(false)}
          onSaved={refetchLines}
        />
      )}
    </div>
  )
}
