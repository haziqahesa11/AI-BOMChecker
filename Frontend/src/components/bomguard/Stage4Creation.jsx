import { useMemo } from 'react'

// Stage 4 — Creating BOM. Clones the prepared Golden Template's real BOM line
// items (Stage 3's location.rows) into a new working BOM for this bracket —
// the "BOM created from the golden BOM with the same bracket of part number."
// Purely a client-side transform of already-fetched real data; nothing is
// written anywhere.
export default function Stage4Creation({ selection, preparedDetail, onComplete }) {
  const workingBom = useMemo(
    () => preparedDetail.location.rows.map(row => ({ ...row, origin: 'golden' })),
    [preparedDetail]
  )

  return (
    <div className="mo-result">
      <h3>Stage 4 — Creating BOM</h3>
      <p className="filter-hint" style={{ marginBottom: '.9rem' }}>
        New BOM created for <span className="mono">{selection.cpn}</span> from its Golden Template — {workingBom.length} line item(s).
      </p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Location</th><th>Type</th><th>Qty</th><th>Child Part Number</th><th>Rev</th><th>Description</th></tr>
          </thead>
          <tbody>
            {workingBom.map((row, i) => (
              <tr key={i} className="row-bom">
                <td>{row.Location ?? '—'}</td>
                <td>{row.Type ?? '—'}</td>
                <td className="mono">{row.Quantity ?? '—'}</td>
                <td className="mono">{row.ChildPartNumber || '—'}</td>
                <td className="mono">{row.ChildRevision || '—'}</td>
                <td>{row.Description || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        className="search-btn"
        style={{ marginTop: '1rem' }}
        onClick={() => onComplete(workingBom)}
      >
        Continue to Detection
      </button>
    </div>
  )
}
