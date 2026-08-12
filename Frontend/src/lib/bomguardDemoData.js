// Hardcoded demo dataset for the BOM Workflow one-click pipeline. Presentation
// data only — the two records below are the exact rows provided for today's
// walkthrough. Everything downstream (cycle time / FPY series, AI narrative)
// is generated deterministically from these two records so the demo never
// depends on live SQL/Ollama reachability (both are known-unreliable from a
// laptop — see project memory on TPG/TPA SQL connectivity).

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatHMS(totalSeconds) {
  const s = Math.round(totalSeconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`
}

function isoDate(d) {
  return d.toISOString().slice(0, 10)
}

function mondayOfWeek(d) {
  const date = new Date(d)
  const day = date.getDay() || 7
  if (day !== 1) date.setDate(date.getDate() - (day - 1))
  return date
}

function isoWeekNumber(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
}

const HIST_LABELS = ['0-1h', '1-2h', '2-4h', '4-8h', '8-16h', '16-24h', '24h+']

// Deterministic (no Math.random) so the demo looks identical on every run —
// a fixed sine wave plus a small fixed-phase jitter term.
function wave(i, base, amplitude, freq = 0.55, phase = 0) {
  return base + amplitude * Math.sin(i * freq + phase) + (amplitude * 0.18) * Math.sin(i * 1.7 + phase * 2)
}

function buildDailyTrend(days, baseSeconds, amplitudeSeconds, seed) {
  const today = new Date()
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const medianSeconds = Math.max(300, wave(days - i, baseSeconds, amplitudeSeconds, 0.5, seed))
    const avgSeconds = medianSeconds * 1.22
    const sampleCount = Math.round(6 + Math.abs(wave(days - i, 4, 3, 0.8, seed + 1)))
    out.push({
      date: isoDate(d),
      medianSeconds,
      avgFormatted: formatHMS(avgSeconds),
      medianFormatted: formatHMS(medianSeconds),
      sampleCount,
    })
  }
  return out
}

function buildHistogram(sampleCount, skewLow, seed) {
  // skewLow=true concentrates counts in the earlier (faster) buckets.
  const weights = skewLow ? [0.34, 0.28, 0.19, 0.10, 0.06, 0.02, 0.01] : [0.08, 0.16, 0.27, 0.26, 0.15, 0.06, 0.02]
  return HIST_LABELS.map((label, i) => ({
    label,
    count: Math.max(0, Math.round(sampleCount * weights[i] + wave(i, 0, sampleCount * 0.02, 1, seed))),
  }))
}

function buildFpyWeeks(weekCount, basePct, amplitude, seed) {
  const today = new Date()
  const out = []
  for (let i = weekCount - 1; i >= 0; i--) {
    const d = mondayOfWeek(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i * 7))
    const pct = Math.min(99.8, Math.max(88, wave(weekCount - i, basePct, amplitude, 0.45, seed)))
    const total = Math.round(60 + Math.abs(wave(weekCount - i, 40, 20, 0.7, seed + 3)))
    const withoutFail = Math.round(total * (pct / 100))
    out.push({
      weekStart: isoDate(d),
      weekLabel: `WW${isoWeekNumber(d)}`,
      total,
      withoutFail,
      withFail: total - withoutFail,
      pctWithoutFail: pct,
      pctWithFail: 100 - pct,
    })
  }
  return out
}

function totalsFromWeeks(weeks) {
  const total = weeks.reduce((s, w) => s + w.total, 0)
  const withoutFail = weeks.reduce((s, w) => s + w.withoutFail, 0)
  const withFail = total - withoutFail
  return { total, withoutFail, withFail, pctWithoutFail: total ? (withoutFail / total) * 100 : 0 }
}

function buildFpyEnv(weekCount, basePct, amplitude, seed, stations) {
  const weeks = buildFpyWeeks(weekCount, basePct, amplitude, seed)
  const totals = totalsFromWeeks(weeks)
  const totalFails = Math.max(1, totals.withFail)
  const shares = stations.map((_, i) => 1 / (i + 1.6))
  const shareSum = shares.reduce((a, b) => a + b, 0)
  const topFailures = stations.map((station, i) => ({
    station,
    count: Math.max(1, Math.round((shares[i] / shareSum) * totalFails)),
  })).sort((a, b) => b.count - a.count)
  return { weeks, totals, topFailures }
}

const L11_MFG_STATIONS = ['PT', 'TN', 'QN', 'N1', 'RS']
const L11_MDAAS_STATIONS = ['MG', 'MD', 'M1', 'SU']
const L10_MFG_STATIONS = ['PT', 'TR', 'QN', 'N2']
const L10_MDAAS_STATIONS = ['MG', 'M1', 'PI']

// The two demo records — exact values as provided for today's walkthrough.
export const DEMO_RECORDS = [
  {
    sn: 'M1412849-001$Y5054',
    mo: '10209501',
    location: 'L11',
    description: 'L11 S2295 GEN9.5 EXO BALANCED_MSF-125266',
    status: 'MP',
    quantity: 15,
    platform: 'S2295 GEN9.5 EXO BALANCED',
    msfRef: 'MSF-125266',
  },
  {
    sn: 'M1412848-001$066',
    mo: '10209502',
    location: 'L10',
    description: 'L10 S2295 GEN9.5 EXO BALANCED_MSF-122048',
    status: 'MP',
    quantity: 300,
    platform: 'S2295 GEN9.5 EXO BALANCED',
    msfRef: 'MSF-122048',
  },
]

export function findDemoRecord(sn) {
  const key = (sn || '').trim().toUpperCase()
  return DEMO_RECORDS.find(r => r.sn.toUpperCase() === key) || null
}

// Real TPG Location data for M1412849-001$Y5054 (L11 chassis), pulled live
// from TPG's own Test BOM tab — the L10 blade (M1412848-001$066) populates
// 7 of its 16 blade slots. Reused as-is (not fabricated) for both demo
// records: for the L11 assembly it's its own Location detail; for the L10
// blade it's the real evidence of where that part is actually used.
const TPG_LOCATION_ROWS = [
  ['B01', 'NO_DEVICE', null],
  ['B02', 'NO_DEVICE', null],
  ['B03', 'M1412848-001$066', 'EXO-BALANCED-MBX-NON-HBI-GEN9.5_MSF-122048'],
  ['B04', 'NO_DEVICE', null],
  ['B05', 'M1412848-001$066', 'EXO-BALANCED-MBX-NON-HBI-GEN9.5_MSF-122048'],
  ['B06', 'NO_DEVICE', null],
  ['B07', 'M1412848-001$066', 'EXO-BALANCED-MBX-NON-HBI-GEN9.5_MSF-122048'],
  ['B08', 'NO_DEVICE', null],
  ['B09', 'M1412848-001$066', 'EXO-BALANCED-MBX-NON-HBI-GEN9.5_MSF-122048'],
  ['B10', 'NO_DEVICE', null],
  ['B11', 'M1412848-001$066', 'EXO-BALANCED-MBX-NON-HBI-GEN9.5_MSF-122048'],
  ['B12', 'NO_DEVICE', null],
  ['B13', 'M1412848-001$066', 'EXO-BALANCED-MBX-NON-HBI-GEN9.5_MSF-122048'],
  ['B14', 'NO_DEVICE', null],
  ['B15', 'M1412848-001$066', 'EXO-BALANCED-MBX-NON-HBI-GEN9.5_MSF-122048'],
  ['B16', 'NO_DEVICE', null],
].map(([location, childPartNumber, description]) => ({
  Location: location,
  Type: 'BLADE',
  Quantity: 1,
  Level: 'L11',
  ChildPartNumber: childPartNumber,
  ChildRevision: '*',
  Remark: 'Blade Slot',
  Description: description || 'NO DEVICE WAS INSTALLED',
}))

// Same shape POST /api/part-detail / buildPartDetail() returns, so the
// existing PartDetailTabs component renders it unmodified. CRD/FRU/Rack SKU
// aren't available for these two records in the current sample set, so
// those tabs fall back to PartDetailTabs' own "not found" messaging —
// exactly how it behaves for any real part without that data.
export function getTpgPartDetail(record) {
  const rows = record.location === 'L11'
    ? TPG_LOCATION_ROWS
    : TPG_LOCATION_ROWS.filter(r => r.ChildPartNumber === record.sn)
  return {
    partNumber: record.sn,
    location: { rows },
    crd: { specNumber: null, found: false, rows: [] },
    fru: { specNumber: null, found: false, rows: [] },
    rackSku: { itemNumber: record.sn.split('$')[0], found: false, row: null },
  }
}

// Small, fixed pool of engineering discipline names — same idea as the rest
// of the app: no owner/engineer assignment exists anywhere in this system, so
// this stays a deterministic role/team label, never a fabricated individual.
const OWNER_TEAM_POOL = ['Program Engineering', 'NPI Engineering', 'Sustaining Engineering']
function hashString(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return Math.abs(h)
}
export function deriveOwnerTeam(sn, location) {
  const team = OWNER_TEAM_POOL[hashString(sn) % OWNER_TEAM_POOL.length]
  return `${location} ${team} Team`
}

// Builds the full analytics payload for one demo record — same shape the
// real /api/ai-dashboard/predict endpoint returns, so the existing chart
// components (charts/CycleTimeFpyCharts.jsx) render it without modification.
export function buildDemoAnalytics(record) {
  const isL11 = record.location === 'L11'
  const days = 21
  const seed = isL11 ? 1.1 : 2.6

  const dailyTrend = buildDailyTrend(days, isL11 ? 7900 : 2500, isL11 ? 2200 : 600, seed)
  const medians = dailyTrend.map(d => d.medianSeconds)
  const avgSeconds = medians.reduce((a, b) => a + b, 0) / medians.length
  const sorted = [...medians].sort((a, b) => a - b)
  const medianSeconds = sorted[Math.floor(sorted.length / 2)]
  const sampleCount = dailyTrend.reduce((s, d) => s + d.sampleCount, 0)

  const cycleTimePt = {
    sampleCount,
    avgFormatted: formatHMS(avgSeconds),
    medianFormatted: formatHMS(medianSeconds),
    minFormatted: formatHMS(Math.min(...medians) * 0.85),
    maxFormatted: formatHMS(Math.max(...medians) * 1.6),
    dailyTrend,
    histogram: buildHistogram(sampleCount, isL11, seed),
  }

  const fpy = {
    MFG: buildFpyEnv(10, isL11 ? 96.4 : 96.9, 1.8, seed, isL11 ? L11_MFG_STATIONS : L10_MFG_STATIONS),
    MDAAS: buildFpyEnv(10, isL11 ? 97.1 : 97.6, 1.5, seed + 5, isL11 ? L11_MDAAS_STATIONS : L10_MDAAS_STATIONS),
  }

  const narrative = buildNarrative(record, cycleTimePt, fpy)

  return {
    model: 'GEN9',
    partNumber: record.sn,
    cycleTimePt,
    fpy,
    prediction: { available: true, narrative },
  }
}

function buildNarrative(record, cycleTimePt, fpy) {
  const mfgPct = fpy.MFG.totals.pctWithoutFail.toFixed(1)
  const mdaasPct = fpy.MDAAS.totals.pctWithoutFail.toFixed(1)
  const topMfg = fpy.MFG.topFailures[0]
  return [
    `${record.sn} (${record.platform}, ${record.location}) is tracking a ${cycleTimePt.medianFormatted} median PT cycle time across ${cycleTimePt.sampleCount} sampled units over the last ${cycleTimePt.dailyTrend.length} days, with an average of ${cycleTimePt.avgFormatted} — the gap between the two reflects the usual right-skew from a small number of longer test runs rather than a systemic slowdown.`,
    `First Pass Yield is holding at ${mfgPct}% for MFG and ${mdaasPct}% for MDAAS, both within normal range for a ${record.status} part at this volume. ${topMfg.station} is the leading MFG failure station this window (${topMfg.count} unit(s)), worth a quick check if it keeps climbing, but nothing in the current trend indicates a released-quality issue for MO ${record.mo}.`,
  ].join('\n\n')
}
