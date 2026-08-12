import { useEffect, useState } from 'react'
import StateBox from '../StateBox'
import { deriveOwnerTeam } from '../../lib/bomguardWorkflow'

// Stage 2 — Selection of BOM. Filters the cached Golden Template catalog
// (GET /api/golden-template/catalog — a real crawl of every Model Reference's
// QVL list, grouped by bare CPN) down to the CPN brackets that belong to the
// Model Reference detected in Stage 1, and shows each bracket's designated
// owner/engineering team (a deterministic role label — see deriveOwnerTeam;
// no owner/engineer data exists anywhere in this system to pull from).
export default function Stage2Selection({ detection, value, onComplete }) {
  const [catalog, setCatalog] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedCpn, setSelectedCpn] = useState(value?.cpn || '')

  useEffect(() => {
    fetch('/api/golden-template/catalog')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setCatalog(json)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <StateBox type="loading" title="Preparing BOM Selection…" message="Grouping detected part numbers into CPN brackets." />
  }
  if (error) {
    return <StateBox type="error" title="Selection Unavailable" message={error} />
  }

  const entries = (catalog?.entries || []).filter(e => e.modelRefs.includes(detection.modelRef))

  return (
    <div className="mo-result">
      <h3>Stage 2 — Selection of BOM</h3>
      <p className="filter-hint" style={{ marginBottom: '.9rem' }}>
        BOM brackets detected under <span className="mono">{detection.modelRef}</span>, each with its designated owner.
      </p>

      {entries.length === 0 ? (
        <StateBox type="empty" title="No BOM Brackets Found" message="No Golden Template entries were found for this Model Reference." />
      ) : (
        <div className="stat-cards dashboard-stat-cards">
          {entries.map(e => {
            const owner = deriveOwnerTeam(e.cpn, detection.location)
            return (
              <button
                key={e.cpn}
                type="button"
                className={`stat-card dashboard-stat-card ${selectedCpn === e.cpn ? 'active' : ''}`}
                onClick={() => setSelectedCpn(e.cpn)}
              >
                <div className="val mono" style={{ fontSize: '1rem' }}>{e.cpn}</div>
                <div className="lbl">{e.variantCount} variant(s)</div>
                <div className="stat-card-sub" style={{ color: 'var(--primary)' }}>{owner}</div>
              </button>
            )
          })}
        </div>
      )}

      <button
        type="button"
        className="search-btn"
        style={{ marginTop: '1rem' }}
        disabled={!selectedCpn}
        onClick={() => {
          const entry = entries.find(e => e.cpn === selectedCpn)
          onComplete({
            cpn: entry.cpn,
            variants: entry.variants,
            ownerTeam: deriveOwnerTeam(entry.cpn, detection.location),
          })
        }}
      >
        Continue to BOM Preparation
      </button>
    </div>
  )
}
