import { useState } from 'react'

function scoreColor(score) {
  if (score >= 90) return 'var(--pass-fg)'
  if (score >= 70) return 'var(--warn-fg)'
  return 'var(--fail-fg)'
}

function exportCSV(comparisons, partNumber) {
  const header = ['Type', 'BOM Location', 'CRD Item', 'Child PN', 'Child Rev', 'BOM Version', 'CRD Version', 'Version Score', 'Status', 'Detail']
  const rows = comparisons.map(c => [
    c.type,
    c.bomLocation  || '',
    c.crdItem      || '',
    c.bomChildPN   || '',
    c.bomChildRev  || '',
    c.bomVersion   || '',
    c.crdVersion   || '',
    c.versionScore != null ? c.versionScore : '',
    c.status,
    c.statusDetail || '',
  ])

  const csv = [header, ...rows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `bom-comparison-${partNumber || Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function ComparisonPanel({ data: d, onSelectItem }) {
  const [filter, setFilter] = useState('ALL')
  const [search, setSearch] = useState('')

  const matched = d.comparisons.filter(c => c.type === 'MATCHED')
  const bomOnly = d.comparisons.filter(c => c.type === 'BOM_ONLY')
  const crdOnly = d.comparisons.filter(c => c.type === 'CRD_ONLY')

  const q = search.trim().toLowerCase()

  function matchesSearch(c) {
    if (!q) return true
    return (
      (c.bomLocation  || '').toLowerCase().includes(q) ||
      (c.crdItem      || '').toLowerCase().includes(q) ||
      (c.bomChildPN   || '').toLowerCase().includes(q) ||
      (c.crdVersion   || '').toLowerCase().includes(q) ||
      (c.bomVersion   || '').toLowerCase().includes(q)
    )
  }

  const showMatched = filter === 'ALL' || filter === 'PASS' || filter === 'FAIL'
  const showBom     = filter === 'ALL' || filter === 'BOM'
  const showCrd     = filter === 'ALL' || filter === 'CRD'

  const filteredMatched = matched.filter(c => {
    if (filter === 'PASS' && c.status !== 'PASS') return false
    if (filter === 'FAIL' && c.status !== 'FAIL') return false
    return matchesSearch(c)
  })

  const filteredBom = bomOnly.filter(matchesSearch)
  const filteredCrd = crdOnly.filter(matchesSearch)

  const filters = [
    { id: 'ALL',  label: 'All',      cls: '' },
    { id: 'PASS', label: 'Pass',     cls: 'pass' },
    { id: 'FAIL', label: 'Fail',     cls: 'fail' },
    { id: 'BOM',  label: 'BOM Only', cls: 'bom' },
    { id: 'CRD',  label: 'CRD Only', cls: 'crd' },
  ]

  return (
    <>
      <div className="comparison-toolbar">
        <div className="filter-btns">
          {filters.map(f => (
            <button
              key={f.id}
              className={`filter-btn ${f.cls} ${filter === f.id ? 'active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <input
          className="table-search"
          type="text"
          placeholder="Search location, PN, version…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        <button className="export-btn" onClick={() => exportCSV(d.comparisons, d.partNumber)}>
          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Export CSV
        </button>
      </div>

      {showMatched && filteredMatched.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>BOM Location</th>
                <th>CRD Item</th>
                <th>BOM Version (ChildPN · ChildRev)</th>
                <th>CRD Version</th>
                <th>Match %</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredMatched.map((c, i) => (
                <tr
                  key={i}
                  className={c.status === 'PASS' ? 'row-pass' : 'row-fail'}
                  onClick={() => onSelectItem && onSelectItem(c)}
                  title="Click for details"
                >
                  <td style={{ color: 'var(--muted)', fontSize: '.75rem' }}>{i + 1}</td>
                  <td className="mono">{c.bomLocation || '—'}</td>
                  <td>
                    {c.crdItem || '—'}
                    {c.crdGroup && (
                      <div style={{ fontSize: '.7rem', color: 'var(--muted)' }}>{c.crdGroup}</div>
                    )}
                  </td>
                  <td>
                    <div className="ver-compare">
                      <div className="ver-row">
                        <span className="ver-tag bom-tag">PN</span>
                        <span className="ver-val">{c.bomChildPN || '—'}</span>
                      </div>
                      <div className="ver-row">
                        <span className="ver-tag bom-tag">REV</span>
                        <span className="ver-val">{c.bomChildRev || '—'}</span>
                      </div>
                    </div>
                  </td>
                  <td className="mono">
                    {c.crdVersion || '—'}
                    {c.crdVersionSource && (
                      <div style={{ fontSize: '.68rem', color: 'var(--muted)', marginTop: '2px' }}>
                        from {c.crdVersionSource}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="score-bar">
                      <div className="score-track">
                        <div
                          className="score-fill"
                          style={{ width: `${c.versionScore}%`, background: scoreColor(c.versionScore) }}
                        />
                      </div>
                      <span className="score-num" style={{ color: scoreColor(c.versionScore) }}>
                        {c.versionScore}%
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className={c.status === 'PASS' ? 'badge-pass' : 'badge-fail'}>
                      {c.status}
                    </span>
                    {c.statusDetail && (
                      <div style={{ fontSize: '.7rem', color: 'var(--muted)', marginTop: '2px' }}>
                        {c.statusDetail}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showMatched && filteredMatched.length === 0 && (filter === 'PASS' || filter === 'FAIL') && (
        <div className="state-box" style={{ padding: '1.5rem' }}>
          <p>No {filter.toLowerCase()} items found.</p>
        </div>
      )}

      {showBom && filteredBom.length > 0 && (
        <>
          <div className="section-title">BOM Items with No CRD Match ({filteredBom.length})</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>BOM Location</th>
                  <th>Child PN</th>
                  <th>Child Revision</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {filteredBom.map((c, i) => (
                  <tr
                    key={i}
                    className="row-bom"
                    onClick={() => onSelectItem && onSelectItem(c)}
                    title="Click for details"
                  >
                    <td className="mono">{c.bomLocation || '—'}</td>
                    <td className="mono">{c.bomChildPN  || '—'}</td>
                    <td className="mono">{c.bomChildRev || '—'}</td>
                    <td><span className="badge-bom">BOM ONLY</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {showCrd && filteredCrd.length > 0 && (
        <>
          <div className="section-title">CRD Specs with No BOM Match ({filteredCrd.length})</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>CRD Item</th>
                  <th>Group</th>
                  <th>Version</th>
                  <th>Notes</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {filteredCrd.map((c, i) => (
                  <tr
                    key={i}
                    className="row-crd"
                    onClick={() => onSelectItem && onSelectItem(c)}
                    title="Click for details"
                  >
                    <td>{c.crdItem   || '—'}</td>
                    <td style={{ color: 'var(--muted)' }}>{c.crdGroup || ''}</td>
                    <td className="mono">{c.crdVersion || '—'}</td>
                    <td style={{ fontSize: '.78rem', color: 'var(--muted)' }}>{c.crdNotes || ''}</td>
                    <td><span className="badge-crd">CRD ONLY</span></td>
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
