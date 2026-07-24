import { useState, useEffect } from 'react'
import PartDetailTabs from './PartDetailTabs'
import SearchableSelect from './SearchableSelect'

// Manual TPG check: cascading Model Reference -> Part Number selection,
// duplicating MonicaTPGenerator.exe's own Test BOM tab layout, then shows
// the same Location / CRD Cfg / FRU Spec / Rack SKU data it would. No MO
// Number or QVL flow needed. Exists because TPG itself can't reach SQL from
// a normal laptop (SSPI/domain-trust failure, see tools/monica-access/README.md);
// this reads the same tables directly.
export default function TpgCheckPage() {
  const [models, setModels]           = useState([])
  const [modelsError, setModelsError] = useState(null)
  const [selectedModel, setSelectedModel] = useState('')

  const [qvlList, setQvlList]     = useState([])
  const [qvlLoading, setQvlLoading] = useState(false)
  const [qvlError, setQvlError]   = useState(null)
  const [selectedPn, setSelectedPn] = useState('')

  const [partDetail, setPartDetail]             = useState(null)
  const [partDetailLoading, setPartDetailLoading] = useState(false)
  const [partDetailError, setPartDetailError]   = useState(null)

  // Full Model Reference list, live from SQL (SP_LocationTable_Model_Distinct)
  // — loaded once.
  useEffect(() => {
    fetch('/api/models')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setModels(json.models)
        if (json.models.length) setSelectedModel(json.models[0].modelRef)
      })
      .catch(e => setModelsError(e.message))
  }, [])

  // Model Reference change -> reload its QVL part list.
  useEffect(() => {
    const model = models.find(m => m.modelRef === selectedModel)
    if (!model) return
    setQvlLoading(true)
    setQvlError(null)
    setSelectedPn('')
    setPartDetail(null)
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

  // Part Number change -> reload its Location / CRD Cfg / FRU Spec / Rack SKU detail.
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

  return (
    <>
      <div className="search-wrap">
        <span className="search-label">Model Reference</span>
        <select
          className="pn-select"
          value={selectedModel}
          onChange={e => setSelectedModel(e.target.value)}
        >
          {models.map(m => (
            <option key={m.modelRef} value={m.modelRef}>{m.modelRef}</option>
          ))}
        </select>

        <span className="search-label">Part Number</span>
        <SearchableSelect
          options={qvlList.map(r => ({
            value: r.partNumber,
            label: r.partNumber + (r.description ? ` — ${r.description}` : ''),
          }))}
          value={selectedPn}
          onChange={setSelectedPn}
          placeholder={qvlLoading ? 'Loading…' : `Type to search ${qvlList.length} part numbers…`}
          disabled={qvlLoading || !qvlList.length}
        />
        <span className="hint">
          Model Reference selects the live QVL list ({models.length || '…'} models total); Part Number is checked against it.
        </span>
      </div>

      <div className="app-body">
        <main>
          {modelsError && (
            <div className="state-box error">
              <div className="icon">⚠️</div>
              <h3>Error loading models</h3>
              <p>{modelsError}</p>
            </div>
          )}
          {qvlError && (
            <div className="state-box error">
              <div className="icon">⚠️</div>
              <h3>Error loading QVL list</h3>
              <p>{qvlError}</p>
            </div>
          )}
          {!selectedPn && !modelsError && !qvlError && (
            <div className="state-box">
              <div className="icon">🔍</div>
              <h3>Select a Part Number to Begin</h3>
              <p>Pick a Model Reference, then a Part Number from its QVL list.</p>
            </div>
          )}
          {partDetailLoading && (
            <div className="state-box">
              <div className="spinner" />
              <h3>Loading part detail…</h3>
            </div>
          )}
          {!partDetailLoading && partDetailError && (
            <div className="state-box error">
              <div className="icon">⚠️</div>
              <h3>Error</h3>
              <p>{partDetailError}</p>
            </div>
          )}
          {!partDetailLoading && !partDetailError && partDetail && (
            <div className="mo-result">
              <h3>{partDetail.partNumber}</h3>
              <PartDetailTabs partDetail={partDetail} />
            </div>
          )}
        </main>
      </div>
    </>
  )
}
