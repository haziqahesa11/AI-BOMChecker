import { useState } from 'react'

const MO_CATEGORY_OPTIONS = ['L10', 'L11']

export default function MoLookupForm({ onLookup, loading }) {
  const [moNumber, setMoNumber] = useState('')
  const [moCategory, setMoCategory] = useState(MO_CATEGORY_OPTIONS[0])
  const [partNumber, setPartNumber] = useState('')

  function handleSubmit() {
    const trimmedMo = moNumber.trim()
    const trimmedPn = partNumber.trim()
    if (!trimmedMo || !trimmedPn) return
    onLookup(trimmedMo, moCategory, trimmedPn)
  }

  return (
    <div className="search-wrap">
      <span className="search-label">MO Number</span>
      <input
        className="pn-input"
        value={moNumber}
        onChange={e => setMoNumber(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleSubmit()}
        type="text"
        placeholder="e.g. 10206953"
        autoComplete="off"
        spellCheck="false"
      />
      <span className="search-label">MO Category</span>
      <select
        className="pn-select"
        value={moCategory}
        onChange={e => setMoCategory(e.target.value)}
      >
        {MO_CATEGORY_OPTIONS.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
      <span className="search-label">Part Number</span>
      <input
        className="pn-input"
        value={partNumber}
        onChange={e => setPartNumber(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleSubmit()}
        type="text"
        placeholder="e.g. B81.04E01.0001"
        autoComplete="off"
        spellCheck="false"
      />
      <button className="search-btn" onClick={handleSubmit} disabled={loading}>
        <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        Lookup
      </button>
      <span className="hint">MO Category selects the QVL Model Reference/Location (L10 → C2012_L10, L11 → C2012_L11). Part Number is checked against that QVL.</span>
    </div>
  )
}
