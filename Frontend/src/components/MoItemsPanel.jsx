import { useState } from 'react'

function exportMoItemsCSV(rows, moNumber) {
  const header = ['Child Part Number', 'Description', 'Quantity', 'Records']
  const csvRows = rows.map(r => [r.cpn, r.description, r.quantity, r.occurrences])

  const csv = [header, ...csvRows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `mo-item-${moNumber || Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// Renders the GETMOITEM response (result.moItems, parsed server-side from the
// diffgram in result.rawResponse) as a searchable component table instead of
// a raw JSON/XML dump. The raw request/response stay available underneath in
// a collapsed <details> for troubleshooting.
export default function MoItemsPanel({ moItems, moNumber, moCategory, requestParams, rawResponse }) {
  const [search, setSearch] = useState('')

  if (!moItems) return null

  const q = search.trim().toLowerCase()
  const filteredRows = moItems.rows.filter(r =>
    !q || r.cpn.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
  )

  const dupCount = moItems.rawRowCount - moItems.rows.length

  return (
    <>
      <h3>MO Item List</h3>
      <div className="meta-row">
        <div className="item"><span className="k">MO Number</span><span className="v">{moNumber || '—'}</span></div>
        <div className="item"><span className="k">MO Category</span><span className="v">{moCategory || '—'}</span></div>
        <div className="item"><span className="k">Top Assembly (UPN)</span><span className="v">{moItems.upn || '—'}</span></div>
        <div className="item"><span className="k">Components</span><span className="v">{moItems.rows.length}</span></div>
        {dupCount > 0 && (
          <div className="item"><span className="k">Duplicate Records Collapsed</span><span className="v">{dupCount}</span></div>
        )}
      </div>

      {moItems.rows.length > 0 && (
        <div className="comparison-toolbar">
          <input
            className="table-search"
            type="text"
            placeholder="Search part number or description…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button className="export-btn" onClick={() => exportMoItemsCSV(moItems.rows, moNumber)}>
            <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Export CSV
          </button>
        </div>
      )}

      {moItems.rows.length === 0 ? (
        <div className="state-box" style={{ padding: '1.5rem' }}>
          <p>No component rows were returned by the MO API for this MO Number.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Child Part Number</th>
                <th>Description</th>
                <th>Quantity</th>
                {dupCount > 0 && <th>Records</th>}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r, i) => (
                <tr key={r.cpn + i}>
                  <td style={{ color: 'var(--muted)', fontSize: '.75rem' }}>{i + 1}</td>
                  <td className="mono">{r.cpn}</td>
                  <td>{r.description || '—'}</td>
                  <td className="mono">{r.quantity.toLocaleString()}</td>
                  {dupCount > 0 && (
                    <td>{r.occurrences > 1 ? <span className="badge-grey">×{r.occurrences}</span> : ''}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRows.length === 0 && (
            <p style={{ padding: '1rem', color: 'var(--muted)' }}>No components match "{search}".</p>
          )}
        </div>
      )}

      <details style={{ marginTop: '1.25rem' }}>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: '.68rem',
            fontWeight: 700,
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: '.06em',
          }}
        >
          Raw API payload (request + response)
        </summary>
        <h3 style={{ marginTop: '.85rem' }}>Request sent to MO API</h3>
        <pre className="mo-result-pre">{JSON.stringify(requestParams, null, 2)}</pre>
        <h3>Raw response</h3>
        <pre className="mo-result-pre">{rawResponse}</pre>
      </details>
    </>
  )
}
