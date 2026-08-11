import { useState, useRef, useEffect } from 'react'
import StateBox from './StateBox'
import RawTable from './RawTable'
import TabBar from './TabBar'

function toDateInput(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const MODELS = ['GEN9', 'GEN8']
const ENVIRONMENTS = [
  { id: 'MFG', label: 'MFG' },
  { id: 'MDAAS', label: 'MDAAS' },
  { id: 'BSL', label: 'BSL', disabled: true },
]

// ────────────────────────────────────────────────────────────────────────
// Weekly FPY trend — single series (% of the week's population that closed
// WITHOUT a fail in the selected environment), so no legend box per the
// dataviz single-series rule; the chart title already names the series.
// ────────────────────────────────────────────────────────────────────────
function WeeklyTrendChart({ weeks }) {
  const [hoverIdx, setHoverIdx] = useState(null)
  const width = 720
  const height = 260
  const padL = 44, padR = 16, padT = 20, padB = 36
  const plotW = width - padL - padR
  const plotH = height - padT - padB

  if (!weeks.length) return null

  const xStep = weeks.length > 1 ? plotW / (weeks.length - 1) : 0
  const xAt = i => padL + (weeks.length > 1 ? i * xStep : plotW / 2)
  const yAt = pct => padT + plotH * (1 - pct / 100)

  const linePoints = weeks.map((w, i) => `${xAt(i)},${yAt(w.pctWithoutFail)}`).join(' ')
  const areaPoints = `${xAt(0)},${yAt(0)} ${linePoints} ${xAt(weeks.length - 1)},${yAt(0)}`
  const gridPcts = [0, 25, 50, 75, 100]
  const hovered = hoverIdx != null ? weeks[hoverIdx] : null

  // A year-to-date range can carry 30+ weeks — every label would collide
  // into an unreadable smear at this width, so thin them to roughly one
  // per 40px of plot width (always keeping the first and last).
  const maxLabels = Math.max(2, Math.floor(plotW / 40))
  const labelStep = Math.max(1, Math.ceil(weeks.length / maxLabels))

  function handleMove(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * width
    let idx = weeks.length > 1 ? Math.round((relX - padL) / xStep) : 0
    idx = Math.max(0, Math.min(weeks.length - 1, idx))
    setHoverIdx(idx)
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label="Weekly First Pass Yield trend"
      >
        {gridPcts.map(p => (
          <g key={p}>
            <line x1={padL} x2={width - padR} y1={yAt(p)} y2={yAt(p)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 8} y={yAt(p)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="var(--muted)">{p}%</text>
          </g>
        ))}

        <polygon points={areaPoints} fill="var(--pass-fg)" opacity="0.1" />
        <polyline points={linePoints} fill="none" stroke="var(--pass-fg)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {weeks.map((w, i) => (
          (i % labelStep === 0 || i === weeks.length - 1) && (
            <text key={w.weekStart} x={xAt(i)} y={height - padB + 16} textAnchor="middle" fontSize="9.5" fill="var(--muted)">
              {w.weekLabel}
            </text>
          )
        ))}

        {weeks.map((w, i) => (
          <circle key={w.weekStart} cx={xAt(i)} cy={yAt(w.pctWithoutFail)} r={i === hoverIdx ? 5 : weeks.length > 20 ? 2.5 : 4} fill="var(--pass-fg)" stroke="var(--surface)" strokeWidth={weeks.length > 20 ? 1 : 2} />
        ))}

        {/* direct label on the last point only, per "label the endpoint" */}
        <text x={xAt(weeks.length - 1)} y={yAt(weeks[weeks.length - 1].pctWithoutFail) - 12} textAnchor="end" fontSize="11" fontWeight="600" fill="var(--text)">
          {weeks[weeks.length - 1].pctWithoutFail.toFixed(2)}%
        </text>

        {hoverIdx != null && (
          <line x1={xAt(hoverIdx)} x2={xAt(hoverIdx)} y1={padT} y2={height - padB} stroke="var(--border2)" strokeWidth="1" />
        )}
      </svg>

      {hovered && (
        <div className="fpy-tooltip" style={{ left: `${(xAt(hoverIdx) / width) * 100}%` }}>
          <div className="fpy-tooltip-title">{hovered.weekLabel} <span className="filter-hint">({hovered.weekStart})</span></div>
          <div><strong>{hovered.pctWithoutFail.toFixed(2)}%</strong> FPY</div>
          <div className="filter-hint">{hovered.withoutFail} without fail · {hovered.withFail} with fail · {hovered.total} total</div>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Top Failures — a classic Pareto tells its story with two y-scales (count
// vs cumulative %), but a dual-axis chart invents an arbitrary alignment
// between two different scales. Instead both series share one 0-100% axis:
// bars are each station's share of total fails, the line is the running
// cumulative share — same reading (dominant contributors + the point where
// the tail stops mattering), no invented axis alignment.
// ────────────────────────────────────────────────────────────────────────
function TopFailuresChart({ topFailures }) {
  const [hoverIdx, setHoverIdx] = useState(null)
  const TOP_N = 10
  const total = topFailures.reduce((s, f) => s + f.count, 0)
  const shown = topFailures.slice(0, TOP_N)
  let running = 0
  const rows = shown.map(f => {
    const pct = total ? (f.count / total) * 100 : 0
    running += pct
    return { ...f, pct, cumPct: running }
  })

  if (!rows.length) return null

  const width = 720
  const height = 280
  const padL = 40, padR = 16, padT = 20, padB = 76
  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const bandW = plotW / rows.length
  const barW = Math.min(24, bandW * 0.55)
  const xCenter = i => padL + bandW * i + bandW / 2
  const yAt = pct => padT + plotH * (1 - pct / 100)
  const gridPcts = [0, 25, 50, 75, 100]

  const linePoints = rows.map((r, i) => `${xCenter(i)},${yAt(r.cumPct)}`).join(' ')
  const hovered = hoverIdx != null ? rows[hoverIdx] : null

  return (
    <div style={{ position: 'relative' }}>
      <div className="fpy-legend">
        <span><i className="fpy-swatch" style={{ background: 'var(--fail-fg)' }} /> % of fails at station</span>
        <span><i className="fpy-linekey" style={{ background: 'var(--info-fg)' }} /> Cumulative %</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Top failure stations, Pareto view">
        {gridPcts.map(p => (
          <g key={p}>
            <line x1={padL} x2={width - padR} y1={yAt(p)} y2={yAt(p)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 8} y={yAt(p)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="var(--muted)">{p}%</text>
          </g>
        ))}

        {rows.map((r, i) => (
          <g key={r.station}
             onMouseEnter={() => setHoverIdx(i)}
             onMouseLeave={() => setHoverIdx(null)}
             style={{ cursor: 'default' }}>
            <rect
              x={xCenter(i) - barW / 2}
              y={yAt(r.pct)}
              width={barW}
              height={Math.max(0, yAt(0) - yAt(r.pct))}
              rx="4"
              fill="var(--fail-fg)"
              opacity={hoverIdx === i ? 1 : 0.85}
            />
            {/* transparent, generous hit area beyond the painted bar */}
            <rect x={padL + bandW * i} y={padT} width={bandW} height={plotH} fill="transparent" />
            <text
              x={xCenter(i)} y={height - padB + 12}
              textAnchor="end" fontSize="9.5" fill="var(--muted)"
              transform={`rotate(-40 ${xCenter(i)} ${height - padB + 12})`}
            >
              {r.station.length > 16 ? r.station.slice(0, 15) + '…' : r.station}
            </text>
          </g>
        ))}

        <polyline points={linePoints} fill="none" stroke="var(--info-fg)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {rows.map((r, i) => (
          <circle key={r.station} cx={xCenter(i)} cy={yAt(r.cumPct)} r={i === hoverIdx ? 5 : 4} fill="var(--info-fg)" stroke="var(--surface)" strokeWidth="2" />
        ))}
      </svg>

      {hovered && (
        <div className="fpy-tooltip" style={{ left: `${(xCenter(hoverIdx) / width) * 100}%` }}>
          <div className="fpy-tooltip-title">{hovered.station}</div>
          <div><strong>{hovered.count}</strong> usn(s) — {hovered.pct.toFixed(1)}% of fails</div>
          <div className="filter-hint">Cumulative: {hovered.cumPct.toFixed(1)}%</div>
        </div>
      )}

      {topFailures.length > TOP_N && (
        <p className="filter-hint" style={{ marginTop: '.5rem' }}>Showing top {TOP_N} of {topFailures.length} stations.</p>
      )}
    </div>
  )
}

function SummaryTable({ totals }) {
  return (
    <table className="fpy-summary-table">
      <thead>
        <tr><th>Description</th><th>Blade Qty</th><th>Percentage</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>With Fails</td>
          <td className="mono">{totals.withFail}</td>
          <td className="mono" style={{ color: 'var(--fail-fg)' }}>{totals.pctWithFail.toFixed(2)}%</td>
        </tr>
        <tr>
          <td>Without Fails</td>
          <td className="mono">{totals.withoutFail}</td>
          <td className="mono" style={{ color: 'var(--pass-fg)' }}>{totals.pctWithoutFail.toFixed(2)}%</td>
        </tr>
        <tr className="fpy-total-row">
          <td>Total</td>
          <td className="mono">{totals.total}</td>
          <td className="mono">100%</td>
        </tr>
      </tbody>
    </table>
  )
}

function WeeklyDataTable({ weeks }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Week</th><th>Week Of</th><th>With Fail</th><th>Without Fail</th><th>Total</th><th>FPY %</th></tr>
        </thead>
        <tbody>
          {weeks.map(w => (
            <tr key={w.weekStart}>
              <td className="mono">{w.weekLabel}</td>
              <td className="mono">{w.weekStart}</td>
              <td className="mono">{w.withFail}</td>
              <td className="mono">{w.withoutFail}</td>
              <td className="mono">{w.total}</td>
              <td className="mono">{w.pctWithoutFail.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Default range: WK1 of the current year through the last FULLY COMPLETED
// week (the week containing today is still in progress, so its "closed
// this week" count is partial and would misleadingly dip/spike as the one
// point still accumulating data).
function lastCompletedWeekEnd() {
  const today = new Date()
  const sunday = new Date(today)
  sunday.setDate(today.getDate() - today.getDay()) // start of the current week
  const saturday = new Date(sunday)
  saturday.setDate(sunday.getDate() - 1) // last day of the prior (completed) week
  return saturday
}
const DEFAULT_TO = lastCompletedWeekEnd()
const DEFAULT_FROM = new Date(DEFAULT_TO.getFullYear(), 0, 1) // WK1 (Jan 1) of that year

function SummaryPanel() {
  const [model, setModel]             = useState('GEN9')
  const [environment, setEnvironment] = useState('MFG')
  const [from, setFrom]               = useState(toDateInput(DEFAULT_FROM))
  const [to, setTo]                   = useState(toDateInput(DEFAULT_TO))
  const [result, setResult]           = useState(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState(null)
  const [hasFetched, setHasFetched]   = useState(false)
  const abortRef = useRef(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  function runFetch() {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    setHasFetched(true)
    const params = `from=${from}&to=${to}&model=${encodeURIComponent(model)}&environment=${encodeURIComponent(environment)}`
    fetch(`/api/first-pass-yield/summary?${params}`, { signal: controller.signal })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setResult(json)
      })
      .catch(e => {
        if (e.name === 'AbortError') {
          setHasFetched(false)
          return
        }
        setError(e.message)
      })
      .finally(() => setLoading(false))
  }

  function handleSubmit(e) {
    e.preventDefault()
    runFetch()
  }

  function handleCancel() {
    abortRef.current?.abort()
  }

  const hasData = result && result.weeks && result.weeks.length > 0

  return (
    <>
      <div className="filter-btns" style={{ marginBottom: '.5rem' }}>
        {MODELS.map(m => (
          <button key={m} type="button" className={`filter-btn ${model === m ? 'active' : ''}`} onClick={() => setModel(m)}>
            {m}
          </button>
        ))}
      </div>
      <div className="filter-btns" style={{ marginBottom: '.75rem' }}>
        {ENVIRONMENTS.map(env => (
          <button
            key={env.id}
            type="button"
            className={`filter-btn ${environment === env.id ? 'active' : ''}`}
            disabled={env.disabled}
            title={env.disabled ? 'BSL FPY not available yet' : undefined}
            onClick={() => !env.disabled && setEnvironment(env.id)}
          >
            {env.label}{env.disabled ? ' (soon)' : ''}
          </button>
        ))}
      </div>

      <form className="comparison-toolbar" onSubmit={handleSubmit}>
        <label className="filter-hint" htmlFor="fpy-sum-from">From</label>
        <input id="fpy-sum-from" type="date" className="date-range-input" value={from} max={to} onChange={e => setFrom(e.target.value)} />
        <label className="filter-hint" htmlFor="fpy-sum-to">To</label>
        <input id="fpy-sum-to" type="date" className="date-range-input" value={to} min={from} onChange={e => setTo(e.target.value)} />
        <button type="submit" className="filter-btn" disabled={loading}>Apply</button>
        {hasFetched && !loading && (
          <button type="button" className="filter-btn" onClick={runFetch}>Refresh</button>
        )}
        {loading && (
          <button type="button" className="filter-btn fail" onClick={handleCancel}>Cancel</button>
        )}
      </form>

      {!hasFetched && !loading && (
        <StateBox type="empty" title="Set your filters" message="Pick a Model, Environment and date range, then click Apply." />
      )}
      {loading && (
        <StateBox type="loading" title="Calculating First Pass Yield…" message={`Querying SFCS for ${model} | ${environment}, ${from} to ${to}.`} />
      )}
      {!loading && error && <StateBox type="error" message={error} />}
      {hasFetched && !loading && !error && result && !hasData && (
        <StateBox type="empty" title="No Data" message="No closed units were found for this model/environment/date range." />
      )}
      {hasFetched && !loading && !error && hasData && (
        <div className="fpy-report">
          <SummaryTable totals={result.totals} />

          <h3 className="fpy-chart-title">First Pass Yield (FPY) {model} | {environment}</h3>
          <WeeklyTrendChart weeks={result.weeks} />
          <WeeklyDataTable weeks={result.weeks} />

          <h3 className="fpy-chart-title">Top Failures {model} | {environment}</h3>
          {result.topFailures.length > 0
            ? <TopFailuresChart topFailures={result.topFailures} />
            : <StateBox type="empty" title="No Failures" message="No failing usns were found for this selection." />}
        </div>
      )}
    </>
  )
}

const USN_PLACEHOLDER = 'e.g. P05206285008V06D'
const MODEL_QUERY_PLACEHOLDER = 'e.g. GEN9.0'

// Raw fail-data browser (unchanged from before) — kept as a secondary tab
// for drilling into the underlying sfcusninfo rows behind the summary above.
function RawDataPanel() {
  const [mode, setMode]       = useState('range')
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [hasFetched, setHasFetched] = useState(false)
  const [from, setFrom]       = useState(toDateInput(DEFAULT_FROM))
  const [to, setTo]           = useState(toDateInput(DEFAULT_TO))
  const [usnQuery, setUsnQuery]     = useState('')
  const [modelQuery, setModelQuery] = useState('')
  const abortRef = useRef(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  function runFetch() {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    setHasFetched(true)
    const params = mode === 'usn' ? `usn=${encodeURIComponent(usnQuery.trim())}`
      : mode === 'model' ? `model=${encodeURIComponent(modelQuery.trim())}`
      : `from=${from}&to=${to}`
    fetch(`/api/first-pass-yield/blade?${params}`, { signal: controller.signal })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setRows(json.rows)
      })
      .catch(e => {
        if (e.name === 'AbortError') {
          setHasFetched(false)
          return
        }
        setError(e.message)
      })
      .finally(() => setLoading(false))
  }

  function handleCancel() {
    abortRef.current?.abort()
  }

  function handleSubmit(e) {
    e.preventDefault()
    if (mode === 'usn' && !usnQuery.trim()) return
    if (mode === 'model' && !modelQuery.trim()) return
    runFetch()
  }

  function switchMode(next) {
    if (next === mode) return
    abortRef.current?.abort()
    setMode(next)
    setRows([])
    setError(null)
    setHasFetched(false)
  }

  const modeCopy = {
    range: { empty: 'Select a Date Range', emptyMsg: 'Pick a From / To date above and click Apply to run the query.', noData: 'No fail records were found in this date range.' },
    usn:   { empty: 'Enter a USN', emptyMsg: 'Type an exact USN above and click Apply to look up its fail records.', noData: 'No fail records were found for that USN.' },
    model: { empty: 'Enter a Model', emptyMsg: 'Type a model (e.g. GEN9.0) above and click Apply to look up every matching unit.', noData: 'No fail records were found for that model.' },
  }[mode]

  return (
    <>
      <div className="filter-btns" style={{ marginBottom: '.75rem' }}>
        <button type="button" className={`filter-btn ${mode === 'range' ? 'active' : ''}`} onClick={() => switchMode('range')}>Date Range</button>
        <button type="button" className={`filter-btn ${mode === 'usn' ? 'active' : ''}`} onClick={() => switchMode('usn')}>Single USN</button>
        <button type="button" className={`filter-btn ${mode === 'model' ? 'active' : ''}`} onClick={() => switchMode('model')}>Model</button>
      </div>

      <form className="comparison-toolbar" onSubmit={handleSubmit}>
        {mode === 'range' && (
          <>
            <label className="filter-hint" htmlFor="fpy-raw-from">From</label>
            <input id="fpy-raw-from" type="date" className="date-range-input" value={from} max={to} onChange={e => setFrom(e.target.value)} />
            <label className="filter-hint" htmlFor="fpy-raw-to">To</label>
            <input id="fpy-raw-to" type="date" className="date-range-input" value={to} min={from} onChange={e => setTo(e.target.value)} />
          </>
        )}
        {mode === 'usn' && (
          <>
            <label className="filter-hint" htmlFor="fpy-raw-usn">USN</label>
            <input id="fpy-raw-usn" type="text" className="pn-input" value={usnQuery} onChange={e => setUsnQuery(e.target.value)} placeholder={USN_PLACEHOLDER} autoComplete="off" spellCheck="false" />
          </>
        )}
        {mode === 'model' && (
          <>
            <label className="filter-hint" htmlFor="fpy-raw-model">Model</label>
            <input id="fpy-raw-model" type="text" className="pn-input" value={modelQuery} onChange={e => setModelQuery(e.target.value)} placeholder={MODEL_QUERY_PLACEHOLDER} autoComplete="off" spellCheck="false" />
          </>
        )}
        <button type="submit" className="filter-btn" disabled={loading || (mode === 'usn' && !usnQuery.trim()) || (mode === 'model' && !modelQuery.trim())}>Apply</button>
        {hasFetched && !loading && (
          <button type="button" className="filter-btn" onClick={runFetch}>Refresh</button>
        )}
        {loading && (
          <button type="button" className="filter-btn fail" onClick={handleCancel}>Cancel</button>
        )}
      </form>

      {!hasFetched && !loading && (
        <StateBox type="empty" title={modeCopy.empty} message={modeCopy.emptyMsg} />
      )}
      {loading && (
        <StateBox
          type="loading"
          title="Loading First Pass Yield…"
          message={
            mode === 'range' ? `Querying SFCS for ${from} to ${to}.`
              : mode === 'usn' ? `Querying SFCS for ${usnQuery.trim()}.`
              : `Querying SFCS for model ${modelQuery.trim()}.`
          }
        />
      )}
      {!loading && error && <StateBox type="error" message={error} />}
      {hasFetched && !loading && !error && rows.length === 0 && (
        <StateBox type="empty" title="No Fail Data" message={modeCopy.noData} />
      )}
      {hasFetched && !loading && !error && rows.length > 0 && (
        <>
          <p className="filter-hint" style={{ margin: '.5rem 0' }}>{rows.length} row(s)</p>
          <div className="table-wrap">
            <RawTable rows={rows} />
          </div>
        </>
      )}
    </>
  )
}

const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'raw', label: 'Raw Data' },
]

export default function FirstPassYieldPage() {
  const [activeTab, setActiveTab] = useState('summary')

  return (
    <div className="app-body">
      <main>
        <TabBar tabs={TABS} activeTab={activeTab} onSwitch={setActiveTab} />
        <div className={`tab-panel${activeTab === 'summary' ? ' active' : ''}`}>
          <SummaryPanel />
        </div>
        <div className={`tab-panel${activeTab === 'raw' ? ' active' : ''}`}>
          <RawDataPanel />
        </div>
      </main>
    </div>
  )
}
