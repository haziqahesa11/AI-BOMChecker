import { useState } from 'react'
import StateBox from '../StateBox'
import PartDetailTabs from '../PartDetailTabs'
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
} from '../charts/CycleTimeFpyCharts'

// Stage 6 — Analytics & AI Integration. Reuses the exact same real, grounded
// endpoint the AI Dashboard uses (POST /api/ai-dashboard/predict), which
// already bundles Cycle Time (PT stage), First Pass Yield (MFG/MDAAS), part
// info, and an AI narrative in one call. The GEN9/GEN8 axis is independent of
// the QVL Model Reference chosen in Stage 1 — there is no real join between
// them (see aiPredictionService.js) — so it stays a simple selector here too,
// defaulting to GEN9.
export default function Stage6Analytics({ selection, onComplete }) {
  const [model, setModel] = useState('GEN9')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [hasFetched, setHasFetched] = useState(false)

  function runAnalysis(m) {
    setModel(m)
    setLoading(true)
    setError(null)
    setHasFetched(true)
    fetch('/api/ai-dashboard/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, partNumber: selection.cpn }),
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
    <div className="mo-result">
      <h3>Stage 6 — Analytics &amp; AI Integration</h3>
      <p className="filter-hint" style={{ marginBottom: '.9rem' }}>
        Cycle time, first pass yield, and an AI-generated read on <span className="mono">{selection.cpn}</span>.
      </p>

      <div className="filter-btns" style={{ marginBottom: '.75rem' }}>
        {MODELS.map(m => (
          <button key={m} type="button" className={`filter-btn ${model === m ? 'active' : ''}`} onClick={() => runAnalysis(m)}>
            {m}
          </button>
        ))}
      </div>

      {!hasFetched && !loading && (
        <StateBox type="empty" title="Pick a Model" message="Choose GEN9 or GEN8 to pull Cycle Time, First Pass Yield, and an AI-generated prediction." />
      )}
      {loading && (
        <StateBox type="loading" title="Analyzing…" message={`Pulling Cycle Time, First Pass Yield, and part info for ${selection.cpn} (${model}), then generating an AI prediction.`} />
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

          {result.partDetail && (
            <>
              <h3 className="fpy-chart-title" style={{ marginTop: '1.5rem' }}>Part Information — {result.partNumber}</h3>
              <PartDetailTabs partDetail={result.partDetail} />
            </>
          )}

          <button type="button" className="search-btn" style={{ marginTop: '1.5rem' }} onClick={() => onComplete(result)}>
            Continue to Printing
          </button>
        </div>
      )}
    </div>
  )
}
