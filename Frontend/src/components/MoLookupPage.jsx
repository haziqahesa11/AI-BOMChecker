import { useState, useEffect } from 'react'
import MoLookupForm from './MoLookupForm'
import PartDetailTabs from './PartDetailTabs'
import SearchableSelect from './SearchableSelect'
import MoItemsPanel from './MoItemsPanel'

export default function MoLookupPage({ onProceedToCompare }) {
  const [result, setResult]               = useState(null)
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState(null)
  const [sendStatus, setSendStatus]       = useState(null) // null | 'queued' | 'in_progress' | 'filled' | 'error'
  const [testBomStatus, setTestBomStatus] = useState(null) // null | 'queued' | 'in_progress' | 'filled' | 'error'

  // Read-only TPG data preview (Location / CRD Cfg / FRU Spec / Rack SKU) —
  // works around TPG's own SSPI/domain-trust failure on a normal laptop by
  // reading the same tables through this app's already-working SQL login.
  const [selectedPn, setSelectedPn]             = useState('')
  const [partDetail, setPartDetail]             = useState(null)
  const [partDetailLoading, setPartDetailLoading] = useState(false)
  const [partDetailError, setPartDetailError]   = useState(null)

  async function runLookup(moNumber, moCategory, partNumber) {
    setLoading(true)
    setError(null)
    setResult(null)
    setSendStatus(null)
    setTestBomStatus(null)
    setSelectedPn('')
    setPartDetail(null)
    setPartDetailError(null)
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
        if (json.qvl?.partNumber) {
          setSelectedPn(json.qvl.partNumber)
        }
        // BOM already loaded for this exact part number → skip straight to Comparison.
        // Otherwise the part still needs to go through QVL (done) → TPG / Test BOM below
        // before a BOM exists to compare against.
        if (json.qvl?.bomExists) {
          onProceedToCompare(json.qvl.partNumber)
        }
      }
    } catch (e) {
      setError('Network error: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!selectedPn) return
    setPartDetailLoading(true)
    setPartDetailError(null)
    fetch('/api/part-detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partNumber: selectedPn }),
    })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setPartDetail(json)
      })
      .catch(e => setPartDetailError(e.message))
      .finally(() => setPartDetailLoading(false))
  }, [selectedPn])

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

  // Single entry point for the UI: one click drives both the QVL tab and the
  // Test BOM tab in MonicaTPGenerator, rather than requiring two separate
  // button clicks for what the user experiences as one "create BOM" action.
  function createBom() {
    sendToTpg()
    sendTestBomToTpg()
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
                  <h3>{result.qvl.inQVL ? 'Part Number found in QVL' : 'This Part Number is NOT encoded in QVL'}</h3>
                  <p>
                    {result.qvl.modelRef} / {result.qvl.location} — {result.qvl.partNumber}
                  </p>
                  {result.qvl.inQVL && <p>Description: {result.qvl.description}</p>}
                  <p>({result.qvl.qvlRowCount} total QVL rows checked for this model/location)</p>
                  {result.qvl.bomExists ? (
                    <p>✅ BOM already exists for this part number — proceeding to Comparison check…</p>
                  ) : (
                    <p>⚠️ No BOM are generated for this part number. Send to MonicaTPGenerator below, then re-run Lookup to proceed to Comparison.</p>
                  )}
                  <div style={{ marginTop: '0.75rem' }}>
                    {!sendStatus && !testBomStatus && (
                      <button className="search-btn" onClick={createBom}>
                        Send to MonicaTPGenerator
                      </button>
                    )}
                    {(sendStatus || testBomStatus) && (
                      <>
                        <p>
                          QVL tab:{' '}
                          {sendStatus === 'queued' && 'queued…'}
                          {sendStatus === 'filled' && '✅ filled — review and submit in TPG.'}
                          {sendStatus === 'error' && '⚠️ autofill failed — check the agent log.'}
                        </p>
                        <p>
                          Test BOM:{' '}
                          {testBomStatus === 'queued' && 'queued…'}
                          {testBomStatus === 'filled' && '✅ loaded — review and submit in TPG.'}
                          {testBomStatus === 'error' && '⚠️ autofill failed — check the agent log.'}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}
              {result.qvl && (
                <>
                  <h3>TPG Data Preview</h3>
                  <p style={{ marginBottom: '0.75rem' }}>
                    Reads the same tables MonicaTPGenerator.exe shows, directly — for laptops
                    where TPG itself can't reach SQL (see tools/monica-access/README.md).
                  </p>
                  <div style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <label>Part Number:</label>
                    <SearchableSelect
                      options={[
                        ...(selectedPn && !result.qvl.qvlList?.some(r => r.partNumber === selectedPn)
                          ? [{ value: selectedPn, label: `${selectedPn} (not in QVL)` }]
                          : []),
                        ...(result.qvl.qvlList || []).map(r => ({
                          value: r.partNumber,
                          label: r.partNumber + (r.description ? ` — ${r.description}` : ''),
                        })),
                      ]}
                      value={selectedPn}
                      onChange={setSelectedPn}
                      placeholder={`Type to search ${result.qvl.qvlList?.length || 0} part numbers…`}
                    />
                  </div>

                  {partDetailLoading && <p>Loading part detail…</p>}
                  {partDetailError && <p>⚠️ {partDetailError}</p>}
                  {!partDetailLoading && <PartDetailTabs partDetail={partDetail} />}
                </>
              )}
              <MoItemsPanel
                moItems={result.moItems}
                moNumber={result.moNumber}
                moCategory={result.moCategory}
                requestParams={result.requestParams}
                rawResponse={result.rawResponse}
              />
            </div>
          )}
        </main>
      </div>
    </>
  )
}
