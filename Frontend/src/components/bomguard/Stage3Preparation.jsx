import { useEffect, useState } from 'react'
import StateBox from '../StateBox'

// Stage 3 — BOM Preparation. Resolves the full reference record for the
// selected CPN bracket via the same Golden Template detail call the Golden
// Template page itself uses (POST /api/golden-template/cpn-detail — real,
// backed by BOM/CRDspec/FRUspec/PartProperties). The checklist below is not
// simulated staging — each row reflects a real field already present in that
// one response.
export default function Stage3Preparation({ selection, onComplete }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    setDetail(null)
    fetch('/api/golden-template/cpn-detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpn: selection.cpn, variants: selection.variants }),
    })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setDetail(json)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.cpn])

  if (loading) {
    return <StateBox type="loading" title="Preparing BOM Information…" message={`Resolving Location, CRD Cfg, FRU Spec, and Rack SKU data for ${selection.cpn}.`} />
  }
  if (error) {
    return <StateBox type="error" title="Preparation Failed" message={error} />
  }
  if (!detail) return null

  const checklist = [
    { label: 'BOM Location Rows', ok: detail.location.rows.length > 0, detail: `${detail.location.rows.length} row(s)` },
    { label: 'CRD Configuration', ok: detail.crd.found, detail: detail.crd.found ? `${detail.crd.rows.length} row(s)` : 'Not found' },
    { label: 'FRU Specification', ok: detail.fru.found, detail: detail.fru.found ? `${detail.fru.rows.length} row(s)` : 'Not found' },
    { label: 'Rack SKU Properties', ok: detail.rackSku.found, detail: detail.rackSku.found ? 'Resolved' : 'Not found' },
  ]

  return (
    <div className="mo-result">
      <h3>Stage 3 — BOM Preparation</h3>
      <p className="filter-hint" style={{ marginBottom: '.9rem' }}>
        Prepared reference information for <span className="mono">{detail.partNumber}</span>
        {detail.resolvedFrom && <> (resolved via variant <span className="mono">{detail.resolvedFrom}</span>)</>}.
      </p>

      <div className="table-wrap">
        <table>
          <thead><tr><th>Data Set</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {checklist.map(row => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td>
                  <span className={row.ok ? 'badge-pass' : 'badge-grey'}>{row.ok ? 'READY' : 'NOT FOUND'}</span>
                </td>
                <td className="filter-hint">{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button
        type="button"
        className="search-btn"
        style={{ marginTop: '1rem' }}
        disabled={detail.location.rows.length === 0}
        onClick={() => onComplete(detail)}
      >
        Continue to BOM Creation
      </button>
    </div>
  )
}
