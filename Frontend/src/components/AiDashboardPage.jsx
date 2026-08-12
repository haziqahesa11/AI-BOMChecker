import { useState } from 'react'
import StateBox from './StateBox'
import PartDetailTabs from './PartDetailTabs'
import {
  MODELS,
  PROJECTION_STEPS,
  CycleTimeStatsTable,
  FpyStatsTable,
  CycleTimeTrendChart,
  CycleTimeHistogramChart,
  FpyTrendChart,
  FailuresParetoChart,
  PredictionPanel,
} from './charts/CycleTimeFpyCharts'

const PN_PLACEHOLDER = 'e.g. M1246491-001'

export default function AiDashboardPage() {
  const [model, setModel] = useState('GEN9')
  const [partNumber, setPartNumber] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [hasFetched, setHasFetched] = useState(false)

  // Editing the model or part number after already having a result must not leave
  // that stale result on screen under the new input — that reads as "these are the
  // numbers for what I just typed" when they're actually from the previous submit.
  function clearStaleResult() {
    if (result || error) {
      setResult(null)
      setError(null)
      setHasFetched(false)
    }
  }

  function handleModelChange(m) {
    setModel(m)
    clearStaleResult()
  }

  function handlePartNumberChange(value) {
    setPartNumber(value)
    clearStaleResult()
  }

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
            <button key={m} type="button" className={`filter-btn ${model === m ? 'active' : ''}`} onClick={() => handleModelChange(m)}>
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
            onChange={e => handlePartNumberChange(e.target.value)}
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
            message="Choose GEN9 or GEN8, type a Part Number, and click Analyze to pull Cycle Time (PT), First Pass Yield (MFG/MDAAS), part info, trend charts, and an AI-generated prediction."
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
            <p className="filter-hint" style={{ margin: '.75rem 0 .25rem' }}>Daily trend (median), last 30 days, with a {PROJECTION_STEPS}-day linear projection</p>
            <CycleTimeTrendChart dailyTrend={result.cycleTimePt.dailyTrend} />
            <p className="filter-hint" style={{ margin: '1.25rem 0 .25rem' }}>Duration distribution</p>
            <CycleTimeHistogramChart histogram={result.cycleTimePt.histogram} />

            <h3 className="fpy-chart-title" style={{ marginTop: '1.5rem' }}>First Pass Yield ({result.model})</h3>
            <FpyStatsTable fpy={result.fpy} />
            <p className="filter-hint" style={{ margin: '.75rem 0 .25rem' }}>Weekly trend, with a {PROJECTION_STEPS}-week linear projection</p>
            <FpyTrendChart fpy={result.fpy} />

            <h3 className="fpy-chart-title" style={{ marginTop: '1.5rem' }}>Top Failures — MFG</h3>
            <FailuresParetoChart topFailures={result.fpy.MFG.topFailures} envLabel="MFG" />

            <h3 className="fpy-chart-title" style={{ marginTop: '1.5rem' }}>Top Failures — MDAAS</h3>
            <FailuresParetoChart topFailures={result.fpy.MDAAS.topFailures} envLabel="MDAAS" />

            <PredictionPanel prediction={result.prediction} />

            <h3 className="fpy-chart-title" style={{ marginTop: '1.5rem' }}>Part Information — {result.partNumber}</h3>
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
