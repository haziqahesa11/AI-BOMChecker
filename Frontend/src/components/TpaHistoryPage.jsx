import { useState, useEffect, useMemo } from 'react'
import StateBox from './StateBox'
import ComboInput from './ComboInput'

function uniqSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  )
}

function formatDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

// ApproverReason is tagged by MonicaTPApprover.exe itself, e.g.
// "[APPROVED] Approve new part number" / "[REJECTED] ..." — surface that
// tag as a badge instead of making it part of the free-text reason.
function decisionBadge(approverReason) {
  const m = /^\[(APPROVED|REJECTED|REMOVED)\]/.exec(approverReason || '')
  if (!m) return null
  const tag = m[1]
  const cls = tag === 'APPROVED' ? 'badge-pass' : tag === 'REJECTED' ? 'badge-fail' : 'badge-grey'
  return <span className={cls}>{tag}</span>
}

const FILTER_COLUMNS = [
  { key: 'ModelRef',    label: 'Model Ref' },
  { key: 'PartNumber',  label: 'Part Number' },
  { key: 'Issuer',      label: 'Issuer' },
  { key: 'Approver',    label: 'Approver' },
]

const EMPTY_FILTERS = Object.fromEntries(FILTER_COLUMNS.map(c => [c.key, '']))

// Read-only mirror of MonicaTPApprover.exe's own "Approve History" tab —
// every row of bom.dbo.ReviewList (who requested a BOM change, who
// approved/rejected it, and when). See BackEnd/services/tpaHistoryService.js.
export default function TpaHistoryPage() {
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [filters, setFilters] = useState(EMPTY_FILTERS)

  function refetch() {
    setLoading(true)
    setError(null)
    fetch('/api/tpa-history')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setRows(json.rows)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refetch() }, [])

  function rowMatchesFilters(r, excludeKey) {
    return FILTER_COLUMNS.every(col => {
      if (col.key === excludeKey) return true
      const q = filters[col.key].trim().toLowerCase()
      if (!q) return true
      return (r[col.key] || '').toLowerCase().includes(q)
    })
  }

  const columnOptions = useMemo(() => {
    const opts = {}
    for (const col of FILTER_COLUMNS) {
      opts[col.key] = uniqSorted(rows.filter(r => rowMatchesFilters(r, col.key)).map(r => r[col.key]))
    }
    return opts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters])

  function setFilter(key, val) {
    setFilters(prev => ({ ...prev, [key]: val }))
  }
  function clearFilters() {
    setFilters(EMPTY_FILTERS)
  }
  const filtersActive = FILTER_COLUMNS.some(c => filters[c.key].trim())

  const filteredRows = rows.filter(r => rowMatchesFilters(r, null))

  return (
    <div className="app-body">
      <main>
        {loading && (
          <StateBox
            type="loading"
            title="Loading TPA History…"
            message="Fetching the approval audit log from bom.dbo.ReviewList."
          />
        )}
        {!loading && error && <StateBox type="error" message={error} />}
        {!loading && !error && rows.length === 0 && (
          <StateBox type="empty" title="No TPA History" message="No rows were found in bom.dbo.ReviewList." />
        )}

        {!loading && !error && rows.length > 0 && (
          <>
            <div className="comparison-toolbar">
              <span className="filter-hint">Type in a column header to filter &amp; see suggestions</span>
              <span className="filter-hint">{filteredRows.length} / {rows.length} rows</span>
              <button className="filter-btn" onClick={refetch}>Reflash</button>
              {filtersActive && (
                <button className="filter-btn" onClick={clearFilters}>Clear Filters</button>
              )}
            </div>

            {filteredRows.length === 0 ? (
              <div className="state-box" style={{ padding: '1.5rem' }}>
                <p>No rows match the current filters.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Model Ref</th><th>Part Number</th>
                      <th>Issuer</th><th>Issue Date</th><th>Issuer Host</th><th>Issuer Reason</th>
                      <th>Approver</th><th>Approve Date</th><th>Approver Host</th><th>Approver Reason</th>
                    </tr>
                    <tr className="col-filter-row">
                      {FILTER_COLUMNS.map(col => (
                        <th key={col.key}>
                          <ComboInput
                            value={filters[col.key]}
                            onChange={val => setFilter(col.key, val)}
                            options={columnOptions[col.key]}
                          />
                        </th>
                      ))}
                      <th /><th /><th /><th /><th /><th />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.ModelRef}</td>
                        <td className="mono">{r.PartNumber}</td>
                        <td>{r.Issuer}</td>
                        <td>{formatDate(r.IssueDate)}</td>
                        <td className="mono">{r.IssuerHost}</td>
                        <td>{r.IssuerReason}</td>
                        <td>{r.Approver}</td>
                        <td>{formatDate(r.ApproveDate)}</td>
                        <td className="mono">{r.ApproverHost}</td>
                        <td>{decisionBadge(r.ApproverReason)} {r.ApproverReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
