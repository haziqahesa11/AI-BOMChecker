function exportWorkingBomCSV(workingBom, cpn) {
  const header = ['Location', 'Type', 'Quantity', 'Child Part Number', 'Revision', 'Description', 'Status']
  const rows = workingBom.map(r => [
    r.Location ?? '', r.Type ?? '', r.Quantity ?? '', r.ChildPartNumber ?? '', r.ChildRevision ?? '', r.Description ?? '',
    r.origin === 'mo-new' ? 'New Part Number' : r.origin === 'mo-changed' ? 'Quantity Changed' : r.flag === 'not-in-release' ? 'Not In Release' : 'Unchanged',
  ])
  const csv = [header, ...rows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n')

  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `bom-${cpn || Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function rowClass(row) {
  if (row.origin === 'mo-new') return 'row-new'
  if (row.origin === 'mo-changed') return 'row-warn'
  if (row.flag === 'not-in-release') return 'row-fail'
  return ''
}

function rowStatus(row) {
  if (row.origin === 'mo-new') return <span className="badge-bom">NEW</span>
  if (row.origin === 'mo-changed') return <span className="badge-warn">QTY CHANGED</span>
  if (row.flag === 'not-in-release') return <span className="badge-fail">NOT IN RELEASE</span>
  return <span className="badge-grey">UNCHANGED</span>
}

// Stage 7 — Printing the BOM. Renders the finalized working BOM (Golden
// Template rows plus whatever Stage 5 detected against the release MO) as a
// print-ready datasheet, with new/changed/missing part numbers highlighted.
// Print uses the browser's own print dialog against a dedicated @media print
// stylesheet (index.css) — no PDF library needed.
export default function Stage7Print({ detection, selection, moNumber, workingBom, onComplete }) {
  const newCount = workingBom.filter(r => r.origin === 'mo-new').length
  const changedCount = workingBom.filter(r => r.origin === 'mo-changed').length
  const flaggedCount = workingBom.filter(r => r.flag === 'not-in-release').length

  return (
    <div className="mo-result">
      <div className="no-print">
        <h3>Stage 7 — Printing the BOM</h3>
        <p className="filter-hint" style={{ marginBottom: '.9rem' }}>
          Review the prepared datasheet below, then print or export it.
        </p>
      </div>

      <div className="print-sheet">
        <div className="meta-row">
          <div className="item"><span className="k">CPN</span><span className="v mono">{selection.cpn}</span></div>
          <div className="item"><span className="k">Model Reference</span><span className="v mono">{detection.modelRef}</span></div>
          <div className="item"><span className="k">Location</span><span className="v mono">{detection.location}</span></div>
          <div className="item"><span className="k">Designated Owner</span><span className="v">{selection.ownerTeam}</span></div>
          {moNumber && <div className="item"><span className="k">Release MO</span><span className="v mono">{moNumber}</span></div>}
          <div className="item"><span className="k">Prepared</span><span className="v">{new Date().toLocaleString()}</span></div>
        </div>

        <div className="stat-cards no-print" style={{ margin: '1rem 0' }}>
          <div className="stat-card"><div className="val">{workingBom.length}</div><div className="lbl">Total Lines</div></div>
          <div className="stat-card info"><div className="val">{newCount}</div><div className="lbl">New Part Numbers</div></div>
          <div className="stat-card warn"><div className="val">{changedCount}</div><div className="lbl">Quantity Changed</div></div>
          <div className="stat-card fail"><div className="val">{flaggedCount}</div><div className="lbl">Not In Release</div></div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Location</th><th>Type</th><th>Qty</th><th>Child Part Number</th><th>Rev</th><th>Description</th><th>Status</th></tr>
            </thead>
            <tbody>
              {workingBom.map((row, i) => (
                <tr key={i} className={rowClass(row)}>
                  <td>{row.Location ?? '—'}</td>
                  <td>{row.Type ?? '—'}</td>
                  <td className="mono">{row.Quantity ?? '—'}</td>
                  <td className="mono">{row.ChildPartNumber || '—'}</td>
                  <td className="mono">{row.ChildRevision || '—'}</td>
                  <td>{row.Description || '—'}</td>
                  <td>{rowStatus(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="no-print" style={{ display: 'flex', gap: '.5rem', marginTop: '1rem' }}>
        <button type="button" className="export-btn" onClick={() => window.print()}>Print</button>
        <button type="button" className="export-btn" onClick={() => exportWorkingBomCSV(workingBom, selection.cpn)}>Export CSV</button>
        <button type="button" className="search-btn" onClick={() => onComplete()}>Continue to Upload</button>
      </div>
    </div>
  )
}
