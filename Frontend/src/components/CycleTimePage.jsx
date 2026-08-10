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

const DEFAULT_TO = new Date()
const DEFAULT_FROM = new Date(DEFAULT_TO.getTime() - 7 * 24 * 60 * 60 * 1000)
const MODEL_PLACEHOLDER = 'e.g. GEN9.0'

// One stage's cycle-time report, with three lookup modes matching
// BackEnd/services/cycleTimeService.js's entry points:
//   - Date Range: which usns to include (any activity in the window,
//     defaults to the last week here) — each included usn's cycle times
//     still come from its complete history, never clipped to the range.
//   - Single USN: exact-match lookup of one serial's full stage history.
//   - Model: every usn whose GEN model token contains the typed text (e.g.
//     "GEN9.0"), each with its full stage history.
// Nothing is fetched until Apply is clicked, so opening the page or
// switching mode never fires a query on its own. A fetch in flight can be
// stopped with Cancel (aborts the request and returns to the pre-fetch
// prompt, rather than showing an error or stale "no data").
function StageCyclePanel({ endpoint, label, usnPlaceholder }) {
  const [mode, setMode]       = useState('range') // 'range' | 'usn' | 'model'
  const [rows, setRows]       = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)
  const [hasFetched, setHasFetched] = useState(false)
  const [from, setFrom]       = useState(toDateInput(DEFAULT_FROM))
  const [to, setTo]           = useState(toDateInput(DEFAULT_TO))
  const [usnQuery, setUsnQuery]     = useState('')
  const [modelQuery, setModelQuery] = useState('')
  const abortRef = useRef(null)

  // Stop whatever's in flight when the panel unmounts (e.g. navigating away
  // mid-fetch) — same cleanup Cancel triggers manually.
  useEffect(() => () => abortRef.current?.abort(), [])

  function runFetch() {
    abortRef.current?.abort() // in case a previous request is somehow still in flight
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    setHasFetched(true)
    const params = mode === 'usn' ? `usn=${encodeURIComponent(usnQuery.trim())}`
      : mode === 'model' ? `model=${encodeURIComponent(modelQuery.trim())}`
      : `from=${from}&to=${to}`
    fetch(`${endpoint}?${params}`, { signal: controller.signal })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setRows(json.rows)
      })
      .catch(e => {
        if (e.name === 'AbortError') {
          setHasFetched(false) // cancelled — back to the pre-fetch prompt, not an error/empty state
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
    range: { empty: 'Select a Date Range', emptyMsg: 'Pick a From / To date above and click Apply to run the query.', noData: 'No units were active in this date range.' },
    usn:   { empty: 'Enter a USN', emptyMsg: 'Type an exact USN above and click Apply to look up its full stage history.', noData: 'No transactions were found for that USN.' },
    model: { empty: 'Enter a Model', emptyMsg: 'Type a model (e.g. GEN9.0) above and click Apply to look up every matching unit.', noData: 'No units were found for that model.' },
  }[mode]

  return (
    <>
      <div className="filter-btns" style={{ marginBottom: '.75rem' }}>
        <button
          type="button"
          className={`filter-btn ${mode === 'range' ? 'active' : ''}`}
          onClick={() => switchMode('range')}
        >
          Date Range
        </button>
        <button
          type="button"
          className={`filter-btn ${mode === 'usn' ? 'active' : ''}`}
          onClick={() => switchMode('usn')}
        >
          Single USN
        </button>
        <button
          type="button"
          className={`filter-btn ${mode === 'model' ? 'active' : ''}`}
          onClick={() => switchMode('model')}
        >
          Model
        </button>
      </div>

      <form className="comparison-toolbar" onSubmit={handleSubmit}>
        {mode === 'range' && (
          <>
            <label className="filter-hint" htmlFor={`${label}-from`}>From</label>
            <input
              id={`${label}-from`}
              type="date"
              className="date-range-input"
              value={from}
              max={to}
              onChange={e => setFrom(e.target.value)}
            />
            <label className="filter-hint" htmlFor={`${label}-to`}>To</label>
            <input
              id={`${label}-to`}
              type="date"
              className="date-range-input"
              value={to}
              min={from}
              onChange={e => setTo(e.target.value)}
            />
          </>
        )}
        {mode === 'usn' && (
          <>
            <label className="filter-hint" htmlFor={`${label}-usn`}>USN</label>
            <input
              id={`${label}-usn`}
              type="text"
              className="pn-input"
              value={usnQuery}
              onChange={e => setUsnQuery(e.target.value)}
              placeholder={usnPlaceholder}
              autoComplete="off"
              spellCheck="false"
            />
          </>
        )}
        {mode === 'model' && (
          <>
            <label className="filter-hint" htmlFor={`${label}-model`}>Model</label>
            <input
              id={`${label}-model`}
              type="text"
              className="pn-input"
              value={modelQuery}
              onChange={e => setModelQuery(e.target.value)}
              placeholder={MODEL_PLACEHOLDER}
              autoComplete="off"
              spellCheck="false"
            />
          </>
        )}
        <button
          type="submit"
          className="filter-btn"
          disabled={(mode === 'usn' && !usnQuery.trim()) || (mode === 'model' && !modelQuery.trim())}
        >
          Apply
        </button>
        {loading && (
          <button type="button" className="filter-btn fail" onClick={handleCancel}>
            Cancel
          </button>
        )}
      </form>

      {!hasFetched && !loading && (
        <StateBox type="empty" title={modeCopy.empty} message={modeCopy.emptyMsg} />
      )}
      {loading && (
        <StateBox
          type="loading"
          title={`Loading ${label} cycle time…`}
          message={
            mode === 'range' ? `Querying SFCS for ${from} to ${to}.`
              : mode === 'usn' ? `Querying SFCS for ${usnQuery.trim()}.`
              : `Querying SFCS for model ${modelQuery.trim()}.`
          }
        />
      )}
      {!loading && error && <StateBox type="error" message={error} />}
      {hasFetched && !loading && !error && rows.length === 0 && (
        <StateBox type="empty" title="No Cycle Time Data" message={modeCopy.noData} />
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

const STAGES = [
  { id: 'l11', label: 'L11', endpoint: '/api/cycle-time/l11', usnPlaceholder: 'e.g. R02886305000306D' },
  { id: 'l10', label: 'L10', endpoint: '/api/cycle-time/l10', usnPlaceholder: 'e.g. P05206285008V06D' },
]

export default function CycleTimePage() {
  const [activeStage, setActiveStage] = useState('l11')
  const tabs = STAGES.map(s => ({ id: s.id, label: s.label }))

  return (
    <div className="app-body">
      <main>
        <TabBar tabs={tabs} activeTab={activeStage} onSwitch={setActiveStage} />
        {STAGES.map(s => (
          <div key={s.id} className={`tab-panel${activeStage === s.id ? ' active' : ''}`}>
            <StageCyclePanel endpoint={s.endpoint} label={s.label} usnPlaceholder={s.usnPlaceholder} />
          </div>
        ))}
      </main>
    </div>
  )
}
