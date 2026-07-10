import { useState } from 'react'

const PN_OPTIONS = ['L10', 'L11']

export default function MoLookupForm({ onLookup, loading }) {
  const [moNumber, setMoNumber] = useState('')
  const [pnNumber, setPnNumber] = useState(PN_OPTIONS[0])

  function handleSubmit() {
    const trimmed = moNumber.trim()
    if (!trimmed) return
    onLookup(trimmed, pnNumber)
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
      <span className="search-label">PN Number</span>
      <select
        className="pn-select"
        value={pnNumber}
        onChange={e => setPnNumber(e.target.value)}
      >
        {PN_OPTIONS.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
      <button className="search-btn" onClick={handleSubmit} disabled={loading}>
        <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        Lookup
      </button>
      <span className="hint">Enter the MO Number and press Enter or click Lookup. PN Number will drive additional logic starting Phase 2.</span>
    </div>
  )
}
