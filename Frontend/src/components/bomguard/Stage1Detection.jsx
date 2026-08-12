import { useEffect, useState } from 'react'
import StateBox from '../StateBox'

// Stage 1 — BOM Detection. Live cascading Model Reference -> QVL scan against
// real SQL, same data source as TpgCheckPage.jsx (the manual TPG check tool):
// GET /api/models (SP_LocationTable_Model_Distinct) then POST /api/qvl-list
// (SP_QVL_Query_DESC) for the chosen Model Reference. "Detection" here means
// proving the live BOM source is reachable and has real part data under it,
// before the user commits to working on it.
export default function Stage1Detection({ value, onComplete }) {
  const [models, setModels] = useState([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState(null)
  const [selectedModel, setSelectedModel] = useState(value?.modelRef || '')

  const [qvlList, setQvlList] = useState(null)
  const [qvlLoading, setQvlLoading] = useState(false)
  const [qvlError, setQvlError] = useState(null)

  useEffect(() => {
    fetch('/api/models')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setModels(json.models)
        if (!selectedModel && json.models.length) setSelectedModel(json.models[0].modelRef)
      })
      .catch(e => setModelsError(e.message))
      .finally(() => setModelsLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const model = models.find(m => m.modelRef === selectedModel)
    if (!model) return
    setQvlLoading(true)
    setQvlError(null)
    setQvlList(null)
    fetch('/api/qvl-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelRef: model.modelRef, location: model.location }),
    })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setQvlList(json.qvlList)
      })
      .catch(e => setQvlError(e.message))
      .finally(() => setQvlLoading(false))
  }, [selectedModel, models])

  const model = models.find(m => m.modelRef === selectedModel)
  const canContinue = !!model && !!qvlList && qvlList.length > 0 && !qvlLoading

  return (
    <div className="mo-result">
      <h3>Stage 1 — BOM Detection</h3>
      <p className="filter-hint" style={{ marginBottom: '.9rem' }}>
        Scans the live Model Reference / QVL source to detect which BOM data is available to work from.
      </p>

      {modelsLoading && (
        <StateBox type="loading" title="Scanning for BOM sources…" message="Pulling the live Model Reference list." />
      )}
      {modelsError && <StateBox type="error" title="Detection Failed" message={modelsError} />}

      {!modelsLoading && !modelsError && (
        <>
          <div className="search-wrap">
            <span className="search-label">Model Reference</span>
            <select
              className="pn-select"
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
            >
              {models.map(m => (
                <option key={m.modelRef} value={m.modelRef}>{m.modelRef} ({m.location})</option>
              ))}
            </select>
            <span className="hint">{models.length} Model References detected live from SQL.</span>
          </div>

          {qvlLoading && <StateBox type="loading" title="Detecting BOM data…" message={`Scanning QVL for ${selectedModel}.`} />}
          {qvlError && <StateBox type="error" title="Detection Failed" message={qvlError} />}
          {!qvlLoading && !qvlError && qvlList && (
            <div className="stat-cards" style={{ marginTop: '.75rem' }}>
              <div className="stat-card info">
                <div className="val">{qvlList.length}</div>
                <div className="lbl">Part Numbers Detected</div>
              </div>
              <div className="stat-card info">
                <div className="val mono" style={{ fontSize: '1rem' }}>{model?.location || '—'}</div>
                <div className="lbl">Location</div>
              </div>
            </div>
          )}

          <button
            type="button"
            className="search-btn"
            style={{ marginTop: '1rem' }}
            disabled={!canContinue}
            onClick={() => onComplete({ modelRef: model.modelRef, location: model.location, qvlCount: qvlList.length })}
          >
            Continue to BOM Selection
          </button>
        </>
      )}
    </div>
  )
}
