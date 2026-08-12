import { useState } from 'react'
import StateBox from '../StateBox'
import { diffBomAgainstMo, applyMoDiffToBom } from '../../lib/bomguardWorkflow'

// Stage 5 — Detections. Fetches a real new-release Manufacturing Order (the
// same live SOAP-backed lookup MoLookupPage.jsx uses, POST /api/mo-lookup)
// and diffs its item list against the working BOM built in Stage 4 to detect
// new or changed part numbers. "Apply to Working BOM" folds those detected
// changes into the session's draft only — the server-side Golden Template
// cache is never touched.
export default function Stage5Detection({ detection, selection, workingBom, onComplete }) {
  const [moNumber, setMoNumber] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [moResult, setMoResult] = useState(null)
  const [diff, setDiff] = useState(null)
  const [applied, setApplied] = useState(false)

  function handleLookup(e) {
    e.preventDefault()
    const mo = moNumber.trim()
    if (!mo) return
    setLoading(true)
    setError(null)
    setMoResult(null)
    setDiff(null)
    setApplied(false)
    fetch('/api/mo-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moNumber: mo, moCategory: detection.location }),
    })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setMoResult(json)
        setDiff(diffBomAgainstMo(workingBom, json.moItems.rows))
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  function handleApply() {
    setApplied(true)
    const updated = applyMoDiffToBom(workingBom, diff)
    onComplete({ workingBom: updated, moNumber: moNumber.trim(), diffSummary: diff.summary })
  }

  return (
    <div className="mo-result">
      <h3>Stage 5 — Detections</h3>
      <p className="filter-hint" style={{ marginBottom: '.9rem' }}>
        Compare the working BOM for <span className="mono">{selection.cpn}</span> against a new release MO to detect new or changed part numbers.
      </p>

      <form className="search-wrap" onSubmit={handleLookup}>
        <span className="search-label">MO Number</span>
        <input
          className="pn-input"
          value={moNumber}
          onChange={e => setMoNumber(e.target.value)}
          type="text"
          placeholder="e.g. 10206953"
          autoComplete="off"
          spellCheck="false"
        />
        <span className="search-label">MO Category</span>
        <input className="pn-input mono" value={detection.location} disabled style={{ maxWidth: 90 }} />
        <button type="submit" className="search-btn" disabled={loading || !moNumber.trim()}>
          {loading ? 'Looking up…' : 'Lookup MO'}
        </button>
      </form>

      {loading && <StateBox type="loading" title="Fetching MO Release…" message={`Looking up MO ${moNumber.trim()}.`} />}
      {error && <StateBox type="error" title="MO Lookup Failed" message={error} />}

      {diff && (
        <>
          <div className="stat-cards" style={{ margin: '1rem 0' }}>
            <div className="stat-card pass"><div className="val">{diff.summary.matchedCount}</div><div className="lbl">Matched</div></div>
            <div className="stat-card warn"><div className="val">{diff.summary.changedQtyCount}</div><div className="lbl">Qty Changed</div></div>
            <div className="stat-card info"><div className="val">{diff.summary.newCount}</div><div className="lbl">New Part Numbers</div></div>
            <div className="stat-card fail"><div className="val">{diff.summary.goldenOnlyCount}</div><div className="lbl">Not In Release</div></div>
          </div>

          {diff.newInMo.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th colSpan="3">New Part Numbers Detected — {moResult.moNumber}</th></tr></thead>
                <tbody>
                  {diff.newInMo.map((item, i) => (
                    <tr key={i} className="row-new">
                      <td className="mono">{item.cpn}</td>
                      <td>{item.description}</td>
                      <td className="mono">Qty {item.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {diff.goldenOnly.length > 0 && (
            <div className="table-wrap" style={{ marginTop: '.75rem' }}>
              <table>
                <thead><tr><th colSpan="3">Not Present In This Release</th></tr></thead>
                <tbody>
                  {diff.goldenOnly.map((row, i) => (
                    <tr key={i} className="row-warn">
                      <td className="mono">{row.ChildPartNumber || '—'}</td>
                      <td>{row.Description || '—'}</td>
                      <td className="mono">Qty {row.Quantity ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button type="button" className="search-btn" style={{ marginTop: '1rem' }} disabled={applied} onClick={handleApply}>
            {applied ? 'Applied — Continuing…' : 'Apply Detected Changes & Continue to Analytics'}
          </button>
        </>
      )}
    </div>
  )
}
