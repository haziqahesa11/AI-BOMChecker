export default function StateBox({ type, pn, message }) {
  if (type === 'empty') {
    return (
      <div className="state-box">
        <div className="icon">🔍</div>
        <h3>Enter a Part Number to Begin</h3>
        <p>Type a BOM Parent Part Number above and click Search &amp; Compare.</p>
      </div>
    )
  }
  if (type === 'loading') {
    return (
      <div className="state-box">
        <div className="spinner" />
        <h3>Searching BOM &amp; CRD…</h3>
        <p>Querying databases for <code>{pn}</code></p>
      </div>
    )
  }
  if (type === 'error') {
    return (
      <div className="state-box error">
        <div className="icon">⚠️</div>
        <h3>Error</h3>
        <p>{message}</p>
      </div>
    )
  }
  return null
}
