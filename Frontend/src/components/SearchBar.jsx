import { useState } from 'react'

export default function SearchBar({ onSearch, loading }) {
  const [pn, setPn] = useState('')

  function handleSearch() {
    const trimmed = pn.trim()
    if (!trimmed) return
    onSearch(trimmed)
  }

  return (
    <div className="search-wrap">
      <span className="search-label">Part Number</span>
      <input
        className="pn-input"
        value={pn}
        onChange={e => setPn(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && handleSearch()}
        type="text"
        placeholder="e.g. M1390373-001$018"
        autoComplete="off"
        spellCheck="false"
      />
      <button className="search-btn" onClick={handleSearch} disabled={loading}>
        <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        Search &amp; Compare
      </button>
      <span className="hint">Enter the BOM Parent Part Number to verify against CRD specifications</span>
    </div>
  )
}
