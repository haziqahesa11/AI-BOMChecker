import { useState, useRef, useEffect } from 'react'

const MAX_RESULTS = 100

// Type-to-filter dropdown for large option lists (e.g. a 3000+ row QVL part
// list) where a plain <select>'s native jump-to-letter behavior isn't real
// search. Filters by substring match anywhere in the label, not just prefix.
export default function SearchableSelect({ options, value, onChange, placeholder = 'Search…', disabled = false }) {
  const [query, setQuery]           = useState('')
  const [open, setOpen]             = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const wrapRef = useRef(null)

  const selected = options.find(o => o.value === value)

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const filtered = query.trim()
    ? options.filter(o => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options
  const shown = filtered.slice(0, MAX_RESULTS)

  function selectOption(opt) {
    onChange(opt.value)
    setQuery('')
    setOpen(false)
  }

  function handleKeyDown(e) {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted(h => Math.min(h + 1, shown.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted(h => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown[highlighted]) selectOption(shown[highlighted])
    } else if (e.key === 'Escape') {
      setOpen(false)
      setQuery('')
    }
  }

  return (
    <div className="searchable-select" ref={wrapRef}>
      <input
        className="pn-select searchable-select-input"
        type="text"
        value={open ? query : (selected ? selected.label : '')}
        onChange={e => { setQuery(e.target.value); setOpen(true); setHighlighted(0) }}
        onFocus={() => { setOpen(true); setQuery('') }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck="false"
      />
      {open && (
        <div className="searchable-select-list">
          {shown.length === 0 && <div className="searchable-select-empty">No matches</div>}
          {shown.map((opt, i) => (
            <div
              key={opt.value}
              className={`searchable-select-option${i === highlighted ? ' highlighted' : ''}${opt.value === value ? ' selected' : ''}`}
              onClick={() => selectOption(opt)}
              onMouseEnter={() => setHighlighted(i)}
            >
              {opt.label}
            </div>
          ))}
          {filtered.length > MAX_RESULTS && (
            <div className="searchable-select-more">{filtered.length - MAX_RESULTS} more — keep typing to narrow down</div>
          )}
        </div>
      )}
    </div>
  )
}
