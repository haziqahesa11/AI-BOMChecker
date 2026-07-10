import { useState } from 'react'
import MoLookupForm from './MoLookupForm'

export default function MoLookupPage() {
  const [result, setResult]   = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  async function runLookup(moNumber, pnNumber) {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/mo-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moNumber, pnNumber }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || `HTTP ${res.status}`)
      } else {
        setResult(json)
      }
    } catch (e) {
      setError('Network error: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <MoLookupForm onLookup={runLookup} loading={loading} />
      <div className="app-body">
        <main>
          {loading && (
            <div className="state-box">
              <div className="spinner" />
              <h3>Looking up MO Item…</h3>
              <p>Querying GetDynamicData for the entered MO Number</p>
            </div>
          )}
          {!loading && error && (
            <div className="state-box error">
              <div className="icon">⚠️</div>
              <h3>Error</h3>
              <p>{error}</p>
            </div>
          )}
          {!loading && !error && !result && (
            <div className="state-box">
              <div className="icon">🔍</div>
              <h3>Enter an MO Number to Begin</h3>
              <p>Type an MO Number above and press Enter or click Lookup.</p>
            </div>
          )}
          {!loading && !error && result && (
            <div className="mo-result">
              <h3>Request sent to MO API</h3>
              <pre className="mo-result-pre">{JSON.stringify(result.requestParams, null, 2)}</pre>
              <h3>Raw response</h3>
              <pre className="mo-result-pre">{result.rawResponse}</pre>
            </div>
          )}
        </main>
      </div>
    </>
  )
}
