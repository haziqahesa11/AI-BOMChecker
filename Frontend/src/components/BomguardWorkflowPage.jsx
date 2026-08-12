import { useState } from 'react'
import PipelineRunner from './bomguard/PipelineRunner'
import PipelineReport from './bomguard/PipelineReport'
import { findDemoRecord, buildDemoAnalytics } from '../lib/bomguardDemoData'

// BOM Workflow — one-click, end to end. The user enters a Part Number (SN)
// and MO Number and clicks Run; the whole detection -> selection ->
// preparation -> creation -> detection/comparison -> analytics -> printing ->
// upload pipeline then plays out on its own (PipelineRunner), landing on a
// full report (PipelineReport). Nothing here is persisted — "uploading to
// database" hits a backend route with no database import at all, so even
// that step can't write to a real table.
export default function BomguardWorkflowPage() {
  const [sn, setSn] = useState('')
  const [mo, setMo] = useState('')
  const [phase, setPhase] = useState('form') // form | running | report
  const [record, setRecord] = useState(null)
  const [analytics, setAnalytics] = useState(null)
  const [receipt, setReceipt] = useState(null)
  const [notFound, setNotFound] = useState(false)

  function handleSubmit(e) {
    e.preventDefault()
    const match = findDemoRecord(sn)
    if (!match) {
      setNotFound(true)
      return
    }
    setNotFound(false)
    setRecord(match)
    setAnalytics(buildDemoAnalytics(match))
    setPhase('running')
  }

  function handleReset() {
    setSn('')
    setMo('')
    setRecord(null)
    setAnalytics(null)
    setReceipt(null)
    setNotFound(false)
    setPhase('form')
  }

  return (
    <div className="app-body">
      <main>
        {phase === 'form' && (
          <div className="mo-result">
            <h3>BOM Workflow</h3>
            <p className="filter-hint" style={{ marginBottom: '.9rem' }}>
              Enter a Part Number and MO Number to run the full BOM Guard pipeline in one click.
            </p>
            <form className="search-wrap" onSubmit={handleSubmit}>
              <span className="search-label">SN</span>
              <input
                className="pn-input"
                value={sn}
                onChange={e => setSn(e.target.value)}
                type="text"
                placeholder="e.g. M1412849-001$Y5054"
                autoComplete="off"
                spellCheck="false"
              />
              <span className="search-label">MO</span>
              <input
                className="pn-input"
                value={mo}
                onChange={e => setMo(e.target.value)}
                type="text"
                placeholder="e.g. 10209501"
                autoComplete="off"
                spellCheck="false"
                style={{ maxWidth: 140 }}
              />
              <button type="submit" className="search-btn" disabled={!sn.trim() || !mo.trim()}>
                Run
              </button>
            </form>
            {notFound && (
              <div className="state-box error" style={{ marginTop: '1rem' }}>
                <div className="icon">⚠️</div>
                <h3>No BOM Record Found</h3>
                <p>No record matches this Part Number.</p>
              </div>
            )}
          </div>
        )}

        {phase === 'running' && (
          <div className="mo-result">
            <h3>BOM Workflow</h3>
            <p className="filter-hint" style={{ marginBottom: '.9rem' }}>
              Running the full pipeline for <span className="mono">{record.sn}</span>…
            </p>
            <PipelineRunner
              record={record}
              onDone={result => {
                setReceipt(result)
                setPhase('report')
              }}
            />
          </div>
        )}

        {phase === 'report' && (
          <PipelineReport record={record} analytics={analytics} receipt={receipt} onReset={handleReset} />
        )}
      </main>
    </div>
  )
}
