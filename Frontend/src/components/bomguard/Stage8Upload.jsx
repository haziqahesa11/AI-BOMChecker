import { useState } from 'react'
import StateBox from '../StateBox'

// Stage 8 — Uploading to Database. A real network round trip to a dedicated
// backend route (POST /api/bomguard-workflow/submit) that deliberately has no
// database import anywhere in its handler — it validates the payload and
// returns a reference ID, but cannot persist anything even by accident. Only
// this and Stage 5's diff logic aren't reads of an existing production table;
// everything else on this page is real, live data.
export default function Stage8Upload({ detection, selection, moNumber, workingBom, onComplete }) {
  const [status, setStatus] = useState('idle') // idle | submitting | success | error
  const [error, setError] = useState(null)
  const [receipt, setReceipt] = useState(null)

  function handleSubmit() {
    setStatus('submitting')
    setError(null)
    fetch('/api/bomguard-workflow/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cpn: selection.cpn,
        modelRef: detection.modelRef,
        moNumber: moNumber || null,
        lineCount: workingBom.length,
      }),
    })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setReceipt(json)
        setStatus('success')
        onComplete(json)
      })
      .catch(e => {
        setError(e.message)
        setStatus('error')
      })
  }

  return (
    <div className="mo-result">
      <h3>Stage 8 — Uploading to Database</h3>
      <p className="filter-hint" style={{ marginBottom: '.9rem' }}>
        Final BOM for <span className="mono">{selection.cpn}</span> — {workingBom.length} line item(s), ready to submit.
      </p>

      {status === 'idle' && (
        <button type="button" className="search-btn" onClick={handleSubmit}>Upload to Database</button>
      )}
      {status === 'submitting' && (
        <StateBox type="loading" title="Uploading…" message="Submitting the finalized BOM." />
      )}
      {status === 'error' && (
        <>
          <StateBox type="error" title="Upload Failed" message={error} />
          <button type="button" className="search-btn" style={{ marginTop: '.75rem' }} onClick={handleSubmit}>Retry Upload</button>
        </>
      )}
      {status === 'success' && receipt && (
        <div className="stat-card pass" style={{ maxWidth: 360 }}>
          <div className="val" style={{ fontSize: '1.1rem' }}>Upload Complete</div>
          <div className="lbl">Reference ID</div>
          <div className="stat-card-sub mono">{receipt.referenceId}</div>
          <div className="lbl" style={{ marginTop: '.5rem' }}>Submitted</div>
          <div className="stat-card-sub">{new Date(receipt.submittedAt).toLocaleString()}</div>
        </div>
      )}
    </div>
  )
}
