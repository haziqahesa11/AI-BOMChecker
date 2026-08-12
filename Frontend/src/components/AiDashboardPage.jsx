import { useState } from 'react'
import StateBox from './StateBox'
import PartDetailTabs from './PartDetailTabs'

// GEN token vocabulary, matching FirstPassYieldPage.jsx's MODELS — Cycle Time and
// First Pass Yield are both scoped by this token, not the QVL Model Reference
// /api/models returns (see BackEnd/services/aiPredictionService.js's top comment).
// BSL/other stages are deferred by design; only PT (Power On Test, L11/rack test)
// and the MFG/MDAAS environments are covered for now.
const MODELS = ['GEN9', 'GEN8']
const ENVIRONMENTS = ['MFG', 'MDAAS']
const PN_PLACEHOLDER = 'e.g. M1246491-001'

function CycleTimeStatsTable({ stats }) {
  return (
    <table className="fpy-summary-table">
      <thead>
        <tr><th>Samples</th><th>Average</th><th>Median</th><th>Min</th><th>Max</th></tr>
      </thead>
      <tbody>
        <tr>
          <td className="mono">{stats.sampleCount}</td>
          <td className="mono">{stats.avgFormatted ?? '—'}</td>
          <td className="mono">{stats.medianFormatted ?? '—'}</td>
          <td className="mono">{stats.minFormatted ?? '—'}</td>
          <td className="mono">{stats.maxFormatted ?? '—'}</td>
        </tr>
      </tbody>
    </table>
  )
}

function FpyStatsTable({ fpy }) {
  return (
    <table className="fpy-summary-table">
      <thead>
        <tr><th>Environment</th><th>Total</th><th>Without Fail</th><th>With Fail</th><th>FPY %</th></tr>
      </thead>
      <tbody>
        {ENVIRONMENTS.map(env => {
          const t = fpy[env].totals
          return (
            <tr key={env}>
              <td>{env}</td>
              <td className="mono">{t.total}</td>
              <td className="mono" style={{ color: 'var(--pass-fg)' }}>{t.withoutFail}</td>
              <td className="mono" style={{ color: 'var(--fail-fg)' }}>{t.withFail}</td>
              <td className="mono">{t.pctWithoutFail.toFixed(2)}%</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function PredictionPanel({ prediction }) {
  if (prediction.available) {
    return (
      <div className="mo-result">
        <h3>AI Prediction</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>{prediction.narrative}</p>
      </div>
    )
  }
  return (
    <StateBox
      type="error"
      title="AI Narrative Unavailable"
      message={`${prediction.reason} — the stats above are still real and current; only the generated narrative is missing.`}
    />
  )
}

export default function AiDashboardPage() {
  const [model, setModel] = useState('GEN9')
  const [partNumber, setPartNumber] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [hasFetched, setHasFetched] = useState(false)

  function handleSubmit(e) {
    e.preventDefault()
    const pn = partNumber.trim()
    if (!pn) return
    setLoading(true)
    setError(null)
    setHasFetched(true)
    fetch('/api/ai-dashboard/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, partNumber: pn }),
    })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setResult(json)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  return (
    <div className="app-body">
      <main>
        <div className="filter-btns" style={{ marginBottom: '.75rem' }}>
          {MODELS.map(m => (
            <button key={m} type="button" className={`filter-btn ${model === m ? 'active' : ''}`} onClick={() => setModel(m)}>
              {m}
            </button>
          ))}
        </div>

        <form className="comparison-toolbar" onSubmit={handleSubmit}>
          <label className="filter-hint" htmlFor="ai-dash-pn">Part Number</label>
          <input
            id="ai-dash-pn"
            type="text"
            className="pn-input"
            value={partNumber}
            onChange={e => setPartNumber(e.target.value)}
            placeholder={PN_PLACEHOLDER}
            autoComplete="off"
            spellCheck="false"
          />
          <button type="submit" className="filter-btn" disabled={loading || !partNumber.trim()}>
            {loading ? 'Analyzing…' : 'Analyze'}
          </button>
        </form>

        {!hasFetched && !loading && (
          <StateBox
            type="empty"
            title="Pick a Model and Part Number"
            message="Choose GEN9 or GEN8, type a Part Number, and click Analyze to pull Cycle Time (PT), First Pass Yield (MFG/MDAAS), part info, and an AI-generated prediction."
          />
        )}
        {loading && (
          <StateBox
            type="loading"
            title="Analyzing…"
            message={`Pulling Cycle Time, First Pass Yield, and part info for ${partNumber.trim()} (${model}), then generating an AI prediction — this can take a few seconds.`}
          />
        )}
        {!loading && error && <StateBox type="error" message={error} />}

        {hasFetched && !loading && !error && result && (
          <div className="fpy-report">
            <h3 className="fpy-chart-title">Cycle Time — PT Stage ({result.model})</h3>
            <CycleTimeStatsTable stats={result.cycleTimePt} />

            <h3 className="fpy-chart-title">First Pass Yield ({result.model})</h3>
            <FpyStatsTable fpy={result.fpy} />

            <PredictionPanel prediction={result.prediction} />

            <h3 className="fpy-chart-title">Part Information — {result.partNumber}</h3>
            {result.partDetail ? (
              <PartDetailTabs partDetail={result.partDetail} />
            ) : (
              <StateBox
                type="error"
                title="Part Information Unavailable"
                message={`${result.partDetailError || 'Lookup failed.'} — Cycle Time and First Pass Yield stats above are unaffected.`}
              />
            )}
          </div>
        )}
      </main>
    </div>
  )
}
