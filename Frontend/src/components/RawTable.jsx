export default function RawTable({ rows, crdRefRow }) {
  if (!rows || !rows.length) {
    return <p style={{ padding: '1rem', color: 'var(--muted)' }}>No data.</p>
  }
  const cols = Object.keys(rows[0])
  const crdKey = crdRefRow ? JSON.stringify(crdRefRow) : null

  return (
    <table>
      <thead>
        <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const isCrd = crdKey && JSON.stringify(r) === crdKey
          return (
            <tr key={i} className={isCrd ? 'crd-ref-row' : ''}>
              {cols.map(c => <td key={c} className="mono">{String(r[c] ?? '')}</td>)}
              {isCrd && <td><span className="badge-warn">CRD REF</span></td>}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
