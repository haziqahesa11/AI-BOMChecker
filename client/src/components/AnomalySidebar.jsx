export default function AnomalySidebar({ comparisons, onSelect }) {
  const anomalies = comparisons.filter(c => c.status !== 'PASS')

  return (
    <div className="anomaly-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Anomalies</span>
        <span className={`sidebar-badge ${anomalies.length > 0 ? 'has-issues' : 'all-clear'}`}>
          {anomalies.length}
        </span>
      </div>

      <div className="sidebar-list">
        {anomalies.length === 0 ? (
          <div className="sidebar-all-pass">All checks passed</div>
        ) : (
          anomalies.map((c, i) => {
            const isMismatch = c.type === 'MATCHED'
            const isBomOnly  = c.type === 'BOM_ONLY'

            const typeColor = isMismatch
              ? 'var(--fail-fg)'
              : isBomOnly
              ? '#60a5fa'
              : '#a78bfa'

            const typeLabel = isMismatch ? 'Mismatch' : isBomOnly ? 'BOM Only' : 'CRD Only'

            const loc    = c.bomLocation || c.crdItem || '—'
            const detail = isMismatch
              ? c.statusDetail
              : isBomOnly
              ? `PN: ${c.bomChildPN || '—'}`
              : `Ver: ${c.crdVersion || '—'}`

            return (
              <div key={i} className="sidebar-item" onClick={() => onSelect(c)}>
                <div className="sidebar-item-type" style={{ color: typeColor }}>
                  {typeLabel}
                </div>
                <div className="sidebar-item-loc">{loc}</div>
                <div className="sidebar-item-detail">{detail}</div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
