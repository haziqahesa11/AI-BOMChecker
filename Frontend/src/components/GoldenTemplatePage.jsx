import { useState, useEffect, useMemo } from 'react'
import StateBox from './StateBox'
import PartDetailTabs from './PartDetailTabs'
import SearchableSelect from './SearchableSelect'

// Golden Template: pick a Reference Number (Model Reference), pick one of its
// Customer Part Numbers, then Generate to see that CPN's Location / CRD Cfg /
// FRU Spec / Rack SKU data — same PartDetailTabs TpgCheckPage uses, but
// resolved per CPN (bare CPN first, falling back to a known encoded variant
// — see BackEnd/services/goldenTemplateService.js). Deliberately shows
// nothing but the two pickers until Generate is clicked, so the user never
// has to scan a huge list to find what they need.
export default function GoldenTemplatePage() {
  const [catalog, setCatalog]             = useState(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError]   = useState(null)
  const [refreshing, setRefreshing]       = useState(false)

  const [selectedModelRef, setSelectedModelRef] = useState('')
  const [selectedCpn, setSelectedCpn]           = useState('')

  const [generated, setGenerated]         = useState(null) // { cpn, modelRefs }
  const [detail, setDetail]               = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError]     = useState(null)

  useEffect(() => {
    fetch('/api/golden-template/catalog')
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setCatalog(json)
      })
      .catch(e => setCatalogError(e.message))
      .finally(() => setCatalogLoading(false))
  }, [])

  function refreshCatalog() {
    setRefreshing(true)
    setCatalogError(null)
    fetch('/api/golden-template/catalog/refresh', { method: 'POST' })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setCatalog(json)
        // Groupings/variants may have changed — clear any in-progress picks/result.
        setSelectedModelRef('')
        setSelectedCpn('')
        setGenerated(null)
        setDetail(null)
      })
      .catch(e => setCatalogError(e.message))
      .finally(() => setRefreshing(false))
  }

  const modelRefOptions = useMemo(() => {
    if (!catalog) return []
    const set = new Set()
    catalog.entries.forEach(e => e.modelRefs.forEach(m => set.add(m)))
    return [...set].sort()
  }, [catalog])

  const cpnOptions = useMemo(() => {
    if (!catalog || !selectedModelRef) return []
    return catalog.entries.filter(e => e.modelRefs.includes(selectedModelRef))
  }, [catalog, selectedModelRef])

  // Reference Number is the upstream pick — changing it invalidates whatever
  // CPN was chosen for the previous one.
  useEffect(() => {
    setSelectedCpn('')
  }, [selectedModelRef])

  function handleGenerate() {
    const entry = cpnOptions.find(e => e.cpn === selectedCpn)
    if (!entry) return
    setGenerated({ cpn: entry.cpn, modelRefs: entry.modelRefs })
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    fetch('/api/golden-template/cpn-detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cpn: entry.cpn, variants: entry.variants }),
    })
      .then(async res => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
        setDetail(json)
      })
      .catch(e => setDetailError(e.message))
      .finally(() => setDetailLoading(false))
  }

  return (
    <>
      <div className="search-wrap">
        <span className="search-label">Reference Number</span>
        <select
          className="pn-select"
          value={selectedModelRef}
          onChange={e => setSelectedModelRef(e.target.value)}
          disabled={catalogLoading || !modelRefOptions.length}
        >
          <option value="">{catalogLoading ? 'Loading…' : 'Select…'}</option>
          {modelRefOptions.map(m => <option key={m} value={m}>{m}</option>)}
        </select>

        <span className="search-label">Customer Part Number</span>
        <SearchableSelect
          options={cpnOptions.map(e => ({
            value: e.cpn,
            label: `${e.cpn} (${e.variantCount} variant${e.variantCount === 1 ? '' : 's'})`,
          }))}
          value={selectedCpn}
          onChange={setSelectedCpn}
          placeholder={!selectedModelRef ? 'Select a Reference Number first…' : `Type to search ${cpnOptions.length} CPNs…`}
          disabled={!selectedModelRef || !cpnOptions.length}
        />

        <button
          className="filter-btn"
          disabled={!selectedModelRef || !selectedCpn || detailLoading}
          onClick={handleGenerate}
        >
          {detailLoading ? 'Generating…' : `Generate Golden ${selectedCpn || 'Template'}`}
        </button>

        <button
          className="filter-btn"
          style={{ marginLeft: 'auto' }}
          onClick={refreshCatalog}
          disabled={refreshing || catalogLoading}
        >
          {refreshing ? 'Refreshing…' : 'Refresh Catalog'}
        </button>

        {catalog && (
          <span className="hint">
            {catalog.cpnCount} CPNs across {catalog.modelCount} Model References — last built {new Date(catalog.builtAt).toLocaleString()}
          </span>
        )}
      </div>

      <div className="app-body">
        <main>
          {catalogLoading && <StateBox type="loading" title="Loading Reference Number / CPN catalog…" />}
          {!catalogLoading && catalogError && <StateBox type="error" message={catalogError} />}

          {!catalogLoading && !catalogError && !generated && (
            <StateBox
              type="empty"
              title="Select a Reference Number and Customer Part Number"
              message="Then click Generate Golden Template to view its Location / CRD Cfg / FRU Spec / Rack SKU data."
            />
          )}

          {generated && detailLoading && (
            <StateBox type="loading" title={`Generating Golden Template for ${generated.cpn}…`} />
          )}
          {generated && !detailLoading && detailError && <StateBox type="error" message={detailError} />}

          {generated && !detailLoading && !detailError && detail && (
            <div className="mo-result">
              <h3>Golden Template — {generated.cpn}</h3>
              <div style={{ margin: '0 0 .75rem' }}>
                {generated.modelRefs.map(m => (
                  <span key={m} className="badge-grey" style={{ marginRight: '.3rem' }}>{m}</span>
                ))}
                {detail.resolvedFrom && (
                  <span className="badge-warn" style={{ marginLeft: '.3rem' }}>
                    Fallback: resolved via {detail.resolvedFrom}
                  </span>
                )}
              </div>
              <PartDetailTabs partDetail={detail} />
            </div>
          )}
        </main>
      </div>
    </>
  )
}
