export function uniqSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  )
}

// Line-level fields (l11Msf, l11Sku, crdNumber, wtsTicket, latestIsoYear/WorkWeek/
// WeekLabel) are identical across every component row of the same line (denormalized
// via the backend's LEFT JOIN), so first-seen-per-line is safe here. Only used for
// line-level facts — never for component-level fields (l10Msf/l10Sku/currentCrdTe),
// which do vary per component.
export function uniqByLineId(rows) {
  const seen = new Map()
  for (const r of rows) {
    if (!seen.has(r.lineId)) seen.set(r.lineId, r)
  }
  return [...seen.values()]
}
