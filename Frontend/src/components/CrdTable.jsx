const MONO_COLS = new Set(['Version', 'MPN'])

export default function CrdTable({ rows }) {
  if (!rows || !rows.length) {
    return <p style={{ padding: '1rem', color: 'var(--muted)' }}>No data.</p>
  }
  const cols = Object.keys(rows[0])
  return (
    <table>
      <thead>
        <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {cols.map(c => (
              <td key={c} className={MONO_COLS.has(c) ? 'mono' : ''}>{String(r[c] ?? '')}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
