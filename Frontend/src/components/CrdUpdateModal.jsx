import { useState, useEffect, useMemo } from 'react'
import ComboInput from './ComboInput'
import SearchableSelect from './SearchableSelect'
import { uniqSorted, uniqByLineId } from '../lib/crdTrackerUtils'

const TODAY = new Date().toISOString().slice(0, 10)

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

async function del(url) {
  const res = await fetch(url, { method: 'DELETE' })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
  return json
}

function StatusBlock({ status, error, successText, onDone }) {
  if (status === 'submitting') {
    return (
      <div className="state-box">
        <div className="spinner" />
        <h3>Saving…</h3>
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="state-box error">
        <div className="icon">⚠️</div>
        <h3>Error</h3>
        <p>{error}</p>
      </div>
    )
  }
  if (status === 'success') {
    return (
      <div className="state-box">
        <div className="icon">✅</div>
        <h3>Saved</h3>
        <p>{successText}</p>
        <button className="search-btn" onClick={onDone} style={{ marginTop: '.75rem' }}>Close</button>
      </div>
    )
  }
  return null
}

// ── Step 1a: top-level chooser ──────────────────────────────────────────────
function ChooseStep({ onPick }) {
  return (
    <div className="stat-cards">
      <button type="button" className="stat-card info" onClick={() => onPick('newsku-mode')}>
        <div className="lbl">New SKU</div>
        <div className="stat-card-sub">Track a new line + L10 component</div>
      </button>
      <button type="button" className="stat-card info" onClick={() => onPick('wwrev-form')}>
        <div className="lbl">WW Rev Update</div>
        <div className="stat-card-sub">Record this week's CRD revision</div>
      </button>
      <button type="button" className="stat-card fail" onClick={() => onPick('delete-pick')}>
        <div className="lbl">Delete</div>
        <div className="stat-card-sub">Remove a line, component, or test row</div>
      </button>
    </div>
  )
}

// ── Step 1b: New SKU — Test vs Real ─────────────────────────────────────────
function NewSkuModeStep({ onPick }) {
  return (
    <div className="stat-cards">
      <button type="button" className="stat-card warn" onClick={() => onPick('test')}>
        <div className="lbl">Test</div>
        <div className="stat-card-sub">Local only — never touches the database</div>
      </button>
      <button type="button" className="stat-card pass" onClick={() => onPick('real')}>
        <div className="lbl">Real</div>
        <div className="stat-card-sub">Writes to the live CRD tracker database</div>
      </button>
    </div>
  )
}

// ── New SKU form (Test or Real) ─────────────────────────────────────────────
function NewSkuForm({ mode, rows, revisionCodes, onSaved, onClose }) {
  const [fields, setFields] = useState(() => ({
    gen: '',
    l11Msf: '',
    l11Sku: '',
    crdNumber: '',
    l10Msf: '',
    l10Sku: '',
    wtsTicket: '',
    wtsLink: '',
    latestCrd: '',
  }))
  const [status, setStatus] = useState('idle') // idle | submitting | success | error
  const [error, setError] = useState(null)
  // "No" is assigned by the backend from Gen — filled in once the save responds.
  const [assignedNo, setAssignedNo] = useState(null)

  const opts = useMemo(() => ({
    l11Msf: uniqSorted(rows.map(r => r.l11Msf)),
    l11Sku: uniqSorted(rows.map(r => r.l11Sku)),
    crdNumber: uniqSorted(rows.map(r => r.crdNumber)),
    l10Msf: uniqSorted(rows.map(r => r.l10Msf)),
    l10Sku: uniqSorted(rows.map(r => r.l10Sku)),
    wtsTicket: uniqSorted(rows.map(r => r.wtsTicket)),
  }), [rows])

  const latestCrdOptions = useMemo(() => [
    { value: '', label: '— none —' },
    ...revisionCodes.map(c => ({ value: c.code, label: c.code })),
  ], [revisionCodes])

  function setField(key, val) {
    setFields(prev => ({ ...prev, [key]: val }))
  }

  function validate() {
    if (!fields.l11Msf.trim() || !fields.l11Sku.trim() || !fields.l10Msf.trim() || !fields.l10Sku.trim())
      return 'L11 MSF, L11 SKU, L10 MSF, and L10 SKU are required.'
    return null
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const validationError = validate()
    if (validationError) {
      setStatus('error')
      setError(validationError)
      return
    }
    setStatus('submitting')
    setError(null)
    const body = {
      gen: fields.gen.trim() ? Number(fields.gen) : null,
      l11Msf: fields.l11Msf.trim(),
      l11Sku: fields.l11Sku.trim(),
      crdNumber: fields.crdNumber.trim(),
      l10Msf: fields.l10Msf.trim(),
      l10Sku: fields.l10Sku.trim(),
      wtsTicket: fields.wtsTicket.trim(),
      wtsLink: fields.wtsLink.trim(),
      latestCrd: fields.latestCrd,
    }
    try {
      const url = mode === 'test' ? '/api/crd-tracker/test-lines' : '/api/crd-tracker/lines'
      const result = await postJson(url, body)
      setAssignedNo(result.no)
      setStatus('success')
    } catch (err) {
      setStatus('error')
      setError(err.message)
    }
  }

  if (status === 'submitting' || status === 'success') {
    return (
      <StatusBlock
        status={status}
        error={error}
        successText={mode === 'test'
          ? `No ${assignedNo} saved locally as a test row.`
          : `No ${assignedNo} saved to the CRD tracker database.`}
        onDone={() => { onSaved(); onClose() }}
      />
    )
  }

  return (
    <form onSubmit={handleSubmit}>
      {status === 'error' && (
        <div className="state-box error" style={{ marginBottom: '1rem' }}>
          <p>⚠️ {error}</p>
        </div>
      )}
      <p className="hint" style={{ marginBottom: '.75rem' }}>
        No is assigned automatically, slotted in next to other lines with the same Gen.
      </p>
      <div className="modal-fields">
        <div className="modal-form-field">
          <label>Gen</label>
          <input className="pn-input" type="number" step="0.1" value={fields.gen}
            onChange={e => setField('gen', e.target.value)} />
        </div>
        <div className="modal-form-field">
          <label>L11 MSF *</label>
          <ComboInput value={fields.l11Msf} onChange={v => setField('l11Msf', v)} options={opts.l11Msf} required />
        </div>
        <div className="modal-form-field">
          <label>L11 SKU *</label>
          <ComboInput value={fields.l11Sku} onChange={v => setField('l11Sku', v)} options={opts.l11Sku} required />
        </div>
        <div className="modal-form-field">
          <label>CRD #</label>
          <ComboInput value={fields.crdNumber} onChange={v => setField('crdNumber', v)} options={opts.crdNumber} />
        </div>
        <div className="modal-form-field">
          <label>L10 MSF *</label>
          <ComboInput value={fields.l10Msf} onChange={v => setField('l10Msf', v)} options={opts.l10Msf} required />
        </div>
        <div className="modal-form-field">
          <label>L10 SKU *</label>
          <ComboInput value={fields.l10Sku} onChange={v => setField('l10Sku', v)} options={opts.l10Sku} required />
        </div>
        <div className="modal-form-field">
          <label>WTS Ticket #</label>
          <ComboInput value={fields.wtsTicket} onChange={v => setField('wtsTicket', v)} options={opts.wtsTicket} />
        </div>
        <div className="modal-form-field">
          <label>WTS Link</label>
          <input className="pn-input" type="url" value={fields.wtsLink}
            onChange={e => setField('wtsLink', e.target.value)} placeholder="https://…" />
        </div>
        <div className="modal-form-field">
          <label>Date Update</label>
          <input className="pn-input" type="text" value={TODAY} disabled />
        </div>
        <div className="modal-form-field">
          <label>Latest CRD</label>
          <SearchableSelect options={latestCrdOptions} value={fields.latestCrd}
            onChange={v => setField('latestCrd', v)} placeholder="Select revision…" />
        </div>
      </div>
      <button type="submit" className="search-btn" style={{ marginTop: '1.25rem' }}>
        {mode === 'test' ? 'Save Test SKU' : 'Save New SKU'}
      </button>
    </form>
  )
}

// ── WW Rev Update form ──────────────────────────────────────────────────────
function WwRevForm({ rows, revisionCodes, currentIsoYear, currentWorkWeek, onSaved, onClose }) {
  // Includes Test rows (negative synthetic lineId) alongside real lines —
  // the backend routes a WW Rev Update for a Test line into its own local
  // history instead of Postgres, so this flow can be fully exercised without
  // touching the database.
  const pickableLines = useMemo(() => uniqByLineId(rows), [rows])

  const [l11Msf, setL11Msf] = useState('')
  const [l11Sku, setL11Sku] = useState('')
  const [crdNumber, setCrdNumber] = useState('')
  const [crdCode, setCrdCode] = useState('')
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)

  // Four cascading dropdowns: each one's options are narrowed by whatever's
  // already picked before it, so by the time all three identifying fields
  // are chosen they resolve to exactly one line rather than an
  // arbitrary/mismatched MSF+SKU+CRD combination.
  const l11MsfOptions = useMemo(() =>
    uniqSorted(pickableLines.map(l => l.l11Msf)).map(v => ({ value: v, label: v }))
  , [pickableLines])

  const l11SkuCandidates = useMemo(() =>
    pickableLines.filter(l => !l11Msf || l.l11Msf === l11Msf)
  , [pickableLines, l11Msf])
  const l11SkuOptions = useMemo(() =>
    uniqSorted(l11SkuCandidates.map(l => l.l11Sku)).map(v => ({ value: v, label: v }))
  , [l11SkuCandidates])

  const crdCandidates = useMemo(() =>
    l11SkuCandidates.filter(l => !l11Sku || l.l11Sku === l11Sku)
  , [l11SkuCandidates, l11Sku])
  const crdOptions = useMemo(() =>
    uniqSorted(crdCandidates.map(l => l.crdNumber)).map(v => ({ value: v, label: v }))
  , [crdCandidates])

  const resolvedCandidates = useMemo(() =>
    crdCandidates.filter(l => !crdNumber || l.crdNumber === crdNumber)
  , [crdCandidates, crdNumber])
  const resolvedLine = (l11Msf && l11Sku && crdNumber && resolvedCandidates.length === 1)
    ? resolvedCandidates[0] : null

  const revisionOptions = useMemo(() => revisionCodes.map(c => ({ value: c.code, label: c.code })), [revisionCodes])

  function handleL11MsfChange(v) {
    setL11Msf(v)
    setL11Sku('')
    setCrdNumber('')
  }
  function handleL11SkuChange(v) {
    setL11Sku(v)
    setCrdNumber('')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!resolvedLine) {
      setStatus('error')
      setError(resolvedCandidates.length > 1
        ? 'That combination matches more than one line — pick a more specific CRD #.'
        : 'Select L11 MSF, L11 SKU, and CRD # to identify an existing line.')
      return
    }
    if (!crdCode) { setStatus('error'); setError('Select a revision code.'); return }
    setStatus('submitting')
    setError(null)
    try {
      await postJson('/api/crd-tracker/ww-rev-update', { lineId: resolvedLine.lineId, crdCode })
      setStatus('success')
    } catch (err) {
      setStatus('error')
      setError(err.message)
    }
  }

  if (status === 'submitting' || status === 'success') {
    return (
      <StatusBlock
        status={status}
        error={error}
        successText={`Recorded ${crdCode} for WW${currentWorkWeek} · ${currentIsoYear} on Line No ${resolvedLine?.no}${resolvedLine?.isTest ? ' (test row — saved locally only)' : ''}.`}
        onDone={() => { onSaved(); onClose() }}
      />
    )
  }

  return (
    <form onSubmit={handleSubmit}>
      {status === 'error' && (
        <div className="state-box error" style={{ marginBottom: '1rem' }}>
          <p>⚠️ {error}</p>
        </div>
      )}
      {currentIsoYear != null && (
        <p className="hint" style={{ marginBottom: '.75rem' }}>
          Recording for the current work week: WW{currentWorkWeek} · {currentIsoYear}
        </p>
      )}
      <div className="modal-fields">
        <div className="modal-form-field">
          <label>L11 MSF *</label>
          <SearchableSelect options={l11MsfOptions} value={l11Msf} onChange={handleL11MsfChange} placeholder="Select L11 MSF…" />
        </div>
        <div className="modal-form-field">
          <label>L11 SKU *</label>
          <SearchableSelect options={l11SkuOptions} value={l11Sku} onChange={handleL11SkuChange} placeholder="Select L11 SKU…" disabled={!l11Msf} />
        </div>
        <div className="modal-form-field">
          <label>CRD # *</label>
          <SearchableSelect options={crdOptions} value={crdNumber} onChange={setCrdNumber} placeholder="Select CRD #…" disabled={!l11Sku} />
        </div>
        <div className="modal-form-field">
          <label>Revision *</label>
          <SearchableSelect options={revisionOptions} value={crdCode} onChange={setCrdCode} placeholder="Select revision…" />
        </div>
      </div>
      {resolvedLine && (
        <p className="hint" style={{ marginTop: '.75rem' }}>
          Resolves to Line No {resolvedLine.no}
          {resolvedLine.isTest && <span className="badge-grey" style={{ marginLeft: '.4rem' }}>TEST</span>}
        </p>
      )}
      <button type="submit" className="search-btn" style={{ marginTop: '1.25rem' }}>Update</button>
    </form>
  )
}

// ── Delete flow ──────────────────────────────────────────────────────────────
function DeleteFlow({ rows, onSaved, onClose }) {
  const [targetValue, setTargetValue] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState(null)

  const targets = useMemo(() => {
    const lineTargets = uniqByLineId(rows).map(l => ({
      value: l.isTest ? `test:${l.testId}` : `line:${l.lineId}`,
      label: `Line No ${l.no} — ${l.l11Msf || '—'} / ${l.l11Sku || '—'}${l.isTest ? '  [TEST]' : ''}  (whole line)`,
      row: l,
      kind: l.isTest ? 'test' : 'line',
    }))
    const componentTargets = rows
      .filter(r => r.componentId != null && !r.isTest)
      .map(r => ({
        value: `component:${r.componentId}`,
        label: `Component — ${r.l10Msf || '—'} / ${r.l10Sku || '—'}  (Line No ${r.no})`,
        row: r,
        kind: 'component',
      }))
    return [...lineTargets, ...componentTargets]
  }, [rows])

  const options = targets.map(t => ({ value: t.value, label: t.label }))
  const selected = targets.find(t => t.value === targetValue)

  async function handleDelete() {
    if (!selected) return
    setStatus('submitting')
    setError(null)
    try {
      const [kind, id] = selected.value.split(':')
      if (kind === 'line') await del(`/api/crd-tracker/lines/${id}?confirm=true`)
      else if (kind === 'component') await del(`/api/crd-tracker/components/${id}?confirm=true`)
      else await del(`/api/crd-tracker/test-lines/${id}`)
      setStatus('success')
    } catch (err) {
      setStatus('error')
      setError(err.message)
    }
  }

  if (status === 'submitting' || status === 'success') {
    return (
      <StatusBlock
        status={status}
        error={error}
        successText="The selected row has been deleted."
        onDone={() => { onSaved(); onClose() }}
      />
    )
  }

  if (!confirming) {
    return (
      <div>
        {status === 'error' && (
          <div className="state-box error" style={{ marginBottom: '1rem' }}>
            <p>⚠️ {error}</p>
          </div>
        )}
        <div className="modal-form-field">
          <label>Row to delete</label>
          <SearchableSelect options={options} value={targetValue} onChange={setTargetValue} placeholder="Search lines / components…" />
        </div>
        <button
          type="button"
          className="danger-btn"
          style={{ marginTop: '1.25rem' }}
          disabled={!selected}
          onClick={() => setConfirming(true)}
        >
          Review Deletion
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="modal-section">
        <div className="modal-section-title">Review Deletion</div>
        <div className="modal-fields">
          <div className="modal-field">
            <div className="k">Target</div>
            <div className="v">{selected.label}</div>
          </div>
        </div>
        <div className="modal-note">
          {selected.kind === 'line' && 'This deletes the whole line, including all L10 components and its full weekly CRD history. This cannot be undone.'}
          {selected.kind === 'component' && 'This deletes only this L10 component row. The parent line and its other components/history are unaffected.'}
          {selected.kind === 'test' && 'This test row never left your browser/server memory — deleting it does not touch the database.'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '.75rem', marginTop: '1.25rem' }}>
        <button type="button" className="filter-btn" onClick={() => setConfirming(false)}>Back</button>
        <button type="button" className="danger-btn" onClick={handleDelete}>Delete</button>
      </div>
    </div>
  )
}

// ── Modal shell ──────────────────────────────────────────────────────────────
const STEP_TITLES = {
  choose: 'Update CRD Tracker',
  'newsku-mode': 'New SKU',
  'newsku-form': 'New SKU',
  'wwrev-form': 'WW Rev Update',
  'delete-pick': 'Delete',
}

export default function CrdUpdateModal({ rows, currentIsoYear, currentWorkWeek, onClose, onSaved }) {
  const [step, setStep] = useState('choose')
  const [newSkuMode, setNewSkuMode] = useState('real')
  const [revisionCodes, setRevisionCodes] = useState([])

  useEffect(() => {
    fetch('/api/crd-tracker/revision-codes')
      .then(async res => {
        const json = await res.json()
        if (res.ok) setRevisionCodes(json.codes || [])
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  function handleSaved() {
    onSaved()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">{STEP_TITLES[step]}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          {step !== 'choose' && (
            <button type="button" className="filter-btn" style={{ marginBottom: '1rem' }} onClick={() => setStep('choose')}>
              ‹ Back
            </button>
          )}

          {step === 'choose' && <ChooseStep onPick={setStep} />}
          {step === 'newsku-mode' && (
            <NewSkuModeStep onPick={mode => { setNewSkuMode(mode); setStep('newsku-form') }} />
          )}
          {step === 'newsku-form' && (
            <NewSkuForm mode={newSkuMode} rows={rows} revisionCodes={revisionCodes} onSaved={handleSaved} onClose={onClose} />
          )}
          {step === 'wwrev-form' && (
            <WwRevForm
              rows={rows}
              revisionCodes={revisionCodes}
              currentIsoYear={currentIsoYear}
              currentWorkWeek={currentWorkWeek}
              onSaved={handleSaved}
              onClose={onClose}
            />
          )}
          {step === 'delete-pick' && (
            <DeleteFlow rows={rows} onSaved={handleSaved} onClose={onClose} />
          )}
        </div>
      </div>
    </div>
  )
}
