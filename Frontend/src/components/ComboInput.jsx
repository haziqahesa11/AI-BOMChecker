import { useState, useEffect, useRef } from 'react'

// Free-text input + type-ahead suggestion dropdown, sourced from a fixed
// `options` list. Typing narrows the suggestions to matching existing
// values, but the value is never constrained to them — picking a suggestion
// just fills the field faster. Extracted from CrdTrackerPage's original
// inline `ColumnFilter` so both the table's column filters and the Update
// form's "dropdown or typable" fields share one implementation.
export default function ComboInput({ value, onChange, options, placeholder, required = false }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    function onClickOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const q = (value || '').trim().toLowerCase()
  const suggestions = (q ? options.filter(o => o.toLowerCase().includes(q)) : options).slice(0, 20)

  return (
    <div className="col-filter" ref={wrapRef}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={e => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
      />
      {open && suggestions.length > 0 && (
        <ul className="col-filter-suggest">
          {suggestions.map(s => (
            <li key={s} onMouseDown={() => { onChange(s); setOpen(false) }}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
