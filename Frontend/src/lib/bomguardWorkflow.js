// Pure helpers for the BOM Workflow page. No fetches, no side effects — every
// function here just transforms data the page has already pulled from real
// backend endpoints.

// Small, fixed pool of engineering discipline names — combined with the real
// QVL location (L10/L11) to produce a "Designated Owner" label per CPN
// bracket. No owner/engineer assignment exists anywhere in this system (see
// BackEnd — zero matches for owner/engineer), so this stays a role/team label,
// never a fabricated individual's name.
const OWNER_TEAM_POOL = ['Program Engineering', 'NPI Engineering', 'Sustaining Engineering', 'Design Engineering']

// Simple deterministic string hash (not cryptographic — just needs to be
// stable so the same CPN always maps to the same team).
function hashString(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

export function deriveOwnerTeam(cpn, location) {
  const team = OWNER_TEAM_POOL[hashString(cpn || '') % OWNER_TEAM_POOL.length]
  const loc = (location || '').trim().toUpperCase() || 'L10'
  return `${loc} ${team} Team`
}

// SysBom's ChildPartNumber and the Golden Template catalog's CPN both key off
// the bare part number before the "$subPN" suffix (same split('$')[0] idiom
// goldenTemplateService.js and partDetailService.js already use) — normalize
// both sides the same way before comparing.
function normalizePn(pn) {
  return (pn || '').trim().toUpperCase().split('$')[0]
}

// Three-way classification of a new-release MO's item list against the
// working BOM (golden template line items, possibly already MO-adjusted) —
// same MATCHED/BOM_ONLY/CRD_ONLY shape the existing /api/compare matcher
// uses, applied here to MO vs. golden BOM instead of BOM vs. CRD spec.
export function diffBomAgainstMo(workingBom, moItems) {
  const bomByPn = new Map(workingBom.map(row => [normalizePn(row.ChildPartNumber), row]))
  const seenPns = new Set()

  const matched = []
  const newInMo = []

  for (const item of moItems) {
    const key = normalizePn(item.cpn)
    if (!key) continue
    seenPns.add(key)
    const bomRow = bomByPn.get(key)
    if (bomRow) {
      const qtyChanged = Number(bomRow.Quantity) !== Number(item.quantity)
      matched.push({ moItem: item, bomRow, qtyChanged })
    } else {
      newInMo.push(item)
    }
  }

  const goldenOnly = workingBom.filter(row => !seenPns.has(normalizePn(row.ChildPartNumber)))

  return {
    matched,
    newInMo,
    goldenOnly,
    summary: {
      matchedCount: matched.length,
      changedQtyCount: matched.filter(m => m.qtyChanged).length,
      newCount: newInMo.length,
      goldenOnlyCount: goldenOnly.length,
    },
  }
}

// Merges a diff's detected changes into the working BOM — this is the "new
// part numbers overwrite the golden template based on needs" step, scoped
// entirely to the in-memory working draft (never the server-side golden
// template cache, never a database write).
export function applyMoDiffToBom(workingBom, diffResult) {
  const updated = workingBom.map(row => {
    const key = normalizePn(row.ChildPartNumber)
    const changedMatch = diffResult.matched.find(m => m.qtyChanged && normalizePn(m.bomRow.ChildPartNumber) === key)
    if (changedMatch) {
      return {
        ...row,
        Quantity: changedMatch.moItem.quantity,
        previousQuantity: row.Quantity,
        origin: 'mo-changed',
      }
    }
    const isGoldenOnly = diffResult.goldenOnly.some(g => normalizePn(g.ChildPartNumber) === key)
    if (isGoldenOnly) {
      return { ...row, flag: 'not-in-release' }
    }
    return row
  })

  const newRows = diffResult.newInMo.map(item => ({
    Location: null,
    Type: 'MO',
    Quantity: item.quantity,
    Level: null,
    ChildPartNumber: item.cpn,
    ChildRevision: null,
    Remark: 'Added from MO release',
    Description: item.description,
    origin: 'mo-new',
  }))

  return [...updated, ...newRows]
}
