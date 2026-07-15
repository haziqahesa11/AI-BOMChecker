import { useState } from 'react'
import MoLookupForm from './MoLookupForm'

export default function MoLookupPage({ onProceedToCompare }) {
  const [result, setResult]               = useState(null)
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState(null)
  const [comparePrompt, setComparePrompt] = useState(false)
  const [sendStatus, setSendStatus]       = useState(null) // null | 'queued' | 'in_progress' | 'filled' | 'error'
  const [testBomStatus, setTestBomStatus] = useState(null) // null | 'queued' | 'in_progress' | 'filled' | 'error'

  async function runLookup(moNumber, moCategory, partNumber) {
    setLoading(true)
    setError(null)
    setResult(null)
    setComparePrompt(false)
    setSendStatus(null)
    setTestBomStatus(null)
    try {
      const res = await fetch('/api/mo-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moNumber, moCategory, partNumber }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || `HTTP ${res.status}`)
      } else {
        setResult(json)
        setComparePrompt(Boolean(json.qvl?.inQVL))
      }
    } catch (e) {
      setError('Network error: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  function pollJob(jobId) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/automation/jobs/${jobId}`)
        const job = await res.json()
        if (job.status === 'filled' || job.status === 'error') {
          clearInterval(interval)
          setSendStatus(job.status)
        }
      } catch {
        clearInterval(interval)
        setSendStatus('error')
      }
    }, 2000)
  }

  async function sendToTpg() {
    setSendStatus('queued')
    try {
      const res = await fetch('/api/automation/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobType: 'qvl_autofill',
          moCategory: result.moCategory,
          partNumber: result.qvl.partNumber,
          description: result.qvl.description,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setSendStatus('error')
        return
      }
      pollJob(json.jobId)
    } catch {
      setSendStatus('error')
    }
  }

  function pollTestBomJob(jobId) {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/automation/jobs/${jobId}`)
        const job = await res.json()
        if (job.status === 'filled' || job.status === 'error') {
          clearInterval(interval)
          setTestBomStatus(job.status)
        }
      } catch {
        clearInterval(interval)
        setTestBomStatus('error')
      }
    }, 2000)
  }

  async function sendTestBomToTpg() {
    setTestBomStatus('queued')
    try {
      const res = await fetch('/api/automation/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobType: 'test_bom_autofill',
          moCategory: result.moCategory,
          partNumber: result.qvl.partNumber,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setTestBomStatus('error')
        return
      }
      pollTestBomJob(json.jobId)
    } catch {
      setTestBomStatus('error')
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
              {result.qvl && (
                <div className={`state-box ${result.qvl.inQVL ? '' : 'error'}`} style={{ marginBottom: '1rem' }}>
                  <div className="icon">{result.qvl.inQVL ? '✅' : '❌'}</div>
                  <h3>{result.qvl.inQVL ? 'Part Number found in QVL' : 'Part Number NOT in QVL'}</h3>
                  <p>
                    {result.qvl.modelRef} / {result.qvl.location} — {result.qvl.partNumber}
                  </p>
                  {result.qvl.inQVL && <p>Description: {result.qvl.description}</p>}
                  <p>({result.qvl.qvlRowCount} total QVL rows checked for this model/location)</p>
                  <div style={{ marginTop: '0.75rem' }}>
                    {!sendStatus && (
                      <button className="search-btn" onClick={sendToTpg}>
                        Send to MonicaTPGenerator
                      </button>
                    )}
                    {sendStatus === 'queued' && <p>Queued for MonicaTPGenerator…</p>}
                    {sendStatus === 'filled' && <p>✅ Fields filled — review and submit in TPG.</p>}
                    {sendStatus === 'error' && <p>⚠️ Autofill failed — check the agent log.</p>}
                  </div>
                  <div style={{ marginTop: '0.5rem' }}>
                    {!testBomStatus && (
                      <button className="search-btn" onClick={sendTestBomToTpg}>
                        Send Test BOM to MonicaTPGenerator
                      </button>
                    )}
                    {testBomStatus === 'queued' && <p>Test BOM queued for MonicaTPGenerator…</p>}
                    {testBomStatus === 'filled' && <p>✅ Test BOM loaded — review and submit in TPG.</p>}
                    {testBomStatus === 'error' && <p>⚠️ Test BOM autofill failed — check the agent log.</p>}
                  </div>
                </div>
              )}
              {comparePrompt && result.qvl && (
                <div className="state-box" style={{ marginBottom: '1rem' }}>
                  <div className="icon">❓</div>
                  <h3>This MO {result.qvl.location} is already in the database</h3>
                  <p>Do you want to proceed for Comparison checking?</p>
                  <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '0.75rem' }}>
                    <button
                      className="search-btn"
                      onClick={() => {
                        setComparePrompt(false)
                        onProceedToCompare(result.qvl.partNumber)
                      }}
                    >
                      Yes
                    </button>
                    <button className="search-btn" onClick={() => setComparePrompt(false)}>
                      No
                    </button>
                  </div>
                </div>
              )}
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
