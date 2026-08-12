import { useState } from 'react'
import StateBox from '../StateBox'

// Shared Cycle Time / First Pass Yield chart set, extracted from AiDashboardPage.jsx
// so BomguardWorkflowPage's analytics stage can reuse the exact same charts instead
// of duplicating ~250 lines of hand-rolled SVG. Behavior/props unchanged from the
// original inline versions.

// GEN token vocabulary, matching FirstPassYieldPage.jsx's MODELS — Cycle Time and
// First Pass Yield are both scoped by this token, not the QVL Model Reference
// /api/models returns (see BackEnd/services/aiPredictionService.js's top comment).
// BSL/other stages are deferred by design; only PT (Power On Test, L11/rack test)
// and the MFG/MDAAS environments are covered for now.
export const MODELS = ['GEN9', 'GEN8']
export const ENVIRONMENTS = ['MFG', 'MDAAS']

// Projected 7 more data points (days for Cycle Time, weeks for FPY) past the last
// real one — a short-range continuation, not a long-horizon forecast.
export const PROJECTION_STEPS = 7

// ────────────────────────────────────────────────────────────────────────
// Least-squares linear fit over `values` (evenly-spaced periods — day or week
// index, not calendar time), extended `steps` points past the last real one.
// This is the whole "predictive" model: no library, no training, just the
// straight line a spreadsheet's trendline would draw — rendered as a visually
// distinct dashed continuation (see each chart below), never blended into the
// real series or presented as more certain than it is.
// ────────────────────────────────────────────────────────────────────────
// Picks which of n indices get an axis label: every `step`-th one, plus the last
// index always (so the axis never ends mid-gap) — but drops any step-picked index
// that lands within `step` of that forced-last one. Without that drop, a step-picked
// index can end up right next to the always-shown last index (e.g. step-picked 30 of
// 32, forced-last 31) and the two labels visually collide instead of usefully
// covering different parts of the axis.
export function thinnedLabelIndices(n, step) {
  const idx = new Set()
  for (let i = 0; i < n; i += step) idx.add(i)
  const last = n - 1
  for (const i of idx) {
    if (i !== last && last - i < step) idx.delete(i)
  }
  idx.add(last)
  return idx
}

export function linearProjection(values, steps) {
  const n = values.length
  if (n < 2) return []
  const xs = values.map((_, i) => i)
  const sumX = xs.reduce((a, b) => a + b, 0)
  const sumY = values.reduce((a, b) => a + b, 0)
  const sumXY = xs.reduce((s, x, i) => s + x * values[i], 0)
  const sumXX = xs.reduce((s, x) => s + x * x, 0)
  const denom = n * sumXX - sumX * sumX
  if (denom === 0) return []
  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  return Array.from({ length: steps }, (_, i) => slope * (n + i) + intercept)
}

export function CycleTimeStatsTable({ stats }) {
  return (
    <table className="fpy-summary-table">
      <thead>
        <tr><th>Samples</th><th>Average</th><th>Median</th><th>Min</th><th>Max</th></tr>
      </thead>
      <tbody>
        <tr>
          <td className="mono">{stats.sampleCount}</td>
          <td className="mono">{stats.avgFormatted ?? '—'}</td>
          <td className="mono">{stats.medianFormatted ?? '—'}</td>
          <td className="mono">{stats.minFormatted ?? '—'}</td>
          <td className="mono">{stats.maxFormatted ?? '—'}</td>
        </tr>
      </tbody>
    </table>
  )
}

export function FpyStatsTable({ fpy }) {
  return (
    <table className="fpy-summary-table">
      <thead>
        <tr><th>Environment</th><th>Total</th><th>Without Fail</th><th>With Fail</th><th>FPY %</th></tr>
      </thead>
      <tbody>
        {ENVIRONMENTS.map(env => {
          const t = fpy[env].totals
          return (
            <tr key={env}>
              <td>{env}</td>
              <td className="mono">{t.total}</td>
              <td className="mono" style={{ color: 'var(--pass-fg)' }}>{t.withoutFail}</td>
              <td className="mono" style={{ color: 'var(--fail-fg)' }}>{t.withFail}</td>
              <td className="mono">{t.pctWithoutFail.toFixed(2)}%</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Cycle Time — PT Daily Trend. Single series (daily median PT duration, in
// hours) — no legend box, per the single-series rule FirstPassYieldPage.jsx's
// own WeeklyTrendChart already documents. Median, not mean: PT durations are
// heavily right-skewed in the real data (confirmed this session — mean
// 04:29:42 vs. median 02:13:13 on one real sample), so a daily mean is easily
// dragged around by one long outlier in a way the median isn't — exactly the
// robustness a trend/projection line needs. Dashed tail = linearProjection
// over the real medians, same hue, lighter + dashed, labeled "Projected".
// ────────────────────────────────────────────────────────────────────────
export function CycleTimeTrendChart({ dailyTrend }) {
  const [hoverIdx, setHoverIdx] = useState(null)
  const width = 720, height = 260
  const padL = 44, padR = 16, padT = 20, padB = 36
  const plotW = width - padL - padR
  const plotH = height - padT - padB

  if (dailyTrend.length < 2) {
    return <p className="filter-hint">Not enough daily data yet to chart a trend.</p>
  }

  const medianHours = dailyTrend.map(d => d.medianSeconds / 3600)
  const projectedHours = linearProjection(medianHours, PROJECTION_STEPS).map(v => Math.max(0, v))
  const allPoints = [...medianHours, ...projectedHours]
  const total = allPoints.length
  const maxHours = Math.max(...allPoints) * 1.1 || 1

  const xStep = plotW / (total - 1)
  const xAt = i => padL + i * xStep
  const yAt = h => padT + plotH * (1 - h / maxHours)

  const realCount = medianHours.length
  const realLine = medianHours.map((h, i) => `${xAt(i)},${yAt(h)}`).join(' ')
  // The dashed segment starts at the last real point so it reads as a continuation,
  // not a gap.
  const projLine = [medianHours[realCount - 1], ...projectedHours]
    .map((h, i) => `${xAt(realCount - 1 + i)},${yAt(h)}`)
    .join(' ')

  const gridCount = 4
  const gridVals = Array.from({ length: gridCount + 1 }, (_, i) => (maxHours / gridCount) * i)

  // Thin labels against the pixel width the REAL data actually spans, not the full
  // plot width — the projected tail eats into plotW too, so using plotW here would
  // under-thin the real labels and collide the last few against each other right
  // where the dashed segment begins.
  const realPlotW = xAt(realCount - 1) - xAt(0)
  const maxLabels = Math.max(2, Math.floor(realPlotW / 55))
  const labelStep = Math.max(1, Math.ceil(dailyTrend.length / maxLabels))
  const labelIndices = thinnedLabelIndices(dailyTrend.length, labelStep)

  function handleMove(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * width
    let idx = Math.round((relX - padL) / xStep)
    idx = Math.max(0, Math.min(realCount - 1, idx))
    setHoverIdx(idx)
  }

  const hovered = hoverIdx != null ? dailyTrend[hoverIdx] : null

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label="Cycle Time PT stage daily median trend, with a short projected continuation"
      >
        {gridVals.map(v => (
          <g key={v}>
            <line x1={padL} x2={width - padR} y1={yAt(v)} y2={yAt(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 8} y={yAt(v)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="var(--muted)">{v.toFixed(1)}h</text>
          </g>
        ))}

        <polyline points={realLine} fill="none" stroke="var(--info-fg)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={projLine} fill="none" stroke="var(--info-fg)" strokeWidth="2" strokeDasharray="5 4" opacity="0.55" strokeLinejoin="round" strokeLinecap="round" />
        <text x={xAt(total - 1)} y={yAt(projectedHours[projectedHours.length - 1]) - 8} textAnchor="end" fontSize="10" fill="var(--info-fg)" opacity="0.75">Projected</text>

        {dailyTrend.map((d, i) => (
          labelIndices.has(i) && (
            <text key={d.date} x={xAt(i)} y={height - padB + 16} textAnchor="middle" fontSize="9" fill="var(--muted)">
              {d.date.slice(5)}
            </text>
          )
        ))}

        {dailyTrend.map((d, i) => (
          <circle key={d.date} cx={xAt(i)} cy={yAt(medianHours[i])} r={i === hoverIdx ? 5 : 3} fill="var(--info-fg)" stroke="var(--surface)" strokeWidth="2" />
        ))}

        {hoverIdx != null && (
          <line x1={xAt(hoverIdx)} x2={xAt(hoverIdx)} y1={padT} y2={height - padB} stroke="var(--border2)" strokeWidth="1" />
        )}
      </svg>

      {hovered && (
        <div className="fpy-tooltip" style={{ left: `${(xAt(hoverIdx) / width) * 100}%` }}>
          <div className="fpy-tooltip-title">{hovered.date}</div>
          <div><strong>{hovered.medianFormatted}</strong> median PT time</div>
          <div className="filter-hint">avg {hovered.avgFormatted} · {hovered.sampleCount} sample(s)</div>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Cycle Time — PT Duration Distribution. Fixed hour-wide buckets from the
// backend (BackEnd/services/cycleTimeStats.js's stageHistogram) — answers
// "how skewed is this, really" now visually, not just in the AI narrative's
// words. Single series, no legend.
// ────────────────────────────────────────────────────────────────────────
export function CycleTimeHistogramChart({ histogram }) {
  const [hoverIdx, setHoverIdx] = useState(null)
  const width = 720, height = 240
  const padL = 40, padR = 16, padT = 20, padB = 36
  const plotW = width - padL - padR
  const plotH = height - padT - padB

  const total = histogram.reduce((s, b) => s + b.count, 0)
  if (total === 0) {
    return <p className="filter-hint">No measured PT durations in this window.</p>
  }

  const maxCount = Math.max(...histogram.map(b => b.count)) || 1
  const bandW = plotW / histogram.length
  const barW = Math.min(48, bandW * 0.6)
  const xCenter = i => padL + bandW * i + bandW / 2
  const yAt = c => padT + plotH * (1 - c / maxCount)

  const gridCount = 4
  const gridVals = Array.from({ length: gridCount + 1 }, (_, i) => Math.round((maxCount / gridCount) * i))

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Cycle Time PT stage duration distribution">
        {gridVals.map(v => (
          <g key={v}>
            <line x1={padL} x2={width - padR} y1={yAt(v)} y2={yAt(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 8} y={yAt(v)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="var(--muted)">{v}</text>
          </g>
        ))}

        {histogram.map((b, i) => (
          <g key={b.label} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)} style={{ cursor: 'default' }}>
            <rect
              x={xCenter(i) - barW / 2}
              y={yAt(b.count)}
              width={barW}
              height={Math.max(0, yAt(0) - yAt(b.count))}
              rx="4"
              fill="var(--info-fg)"
              opacity={hoverIdx === i ? 1 : 0.85}
            />
            <rect x={padL + bandW * i} y={padT} width={bandW} height={plotH} fill="transparent" />
            <text x={xCenter(i)} y={height - padB + 16} textAnchor="middle" fontSize="10" fill="var(--muted)">{b.label}</text>
          </g>
        ))}
      </svg>

      {hoverIdx != null && (
        <div className="fpy-tooltip" style={{ left: `${(xCenter(hoverIdx) / width) * 100}%` }}>
          <div className="fpy-tooltip-title">{histogram[hoverIdx].label}</div>
          <div><strong>{histogram[hoverIdx].count}</strong> unit(s) — {((histogram[hoverIdx].count / total) * 100).toFixed(1)}% of {total}</div>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// First Pass Yield — Weekly Trend, MFG vs MDAAS on one 0-100% axis (both are
// the same metric — yield % — so comparing them directly on one chart is the
// more useful form than two single-series charts). Two categorical series ->
// legend required, fixed order (MFG = --series1-fg, MDAAS = --series2-fg —
// see index.css for why this pair, not --info-fg/--purple-fg, was chosen:
// that pair fails the dataviz skill's own CVD-safety validator). Population
// is identical per week across environments by construction (see
// firstPassYieldService.js), so both series share the same week axis safely.
// ────────────────────────────────────────────────────────────────────────
export function FpyTrendChart({ fpy }) {
  const [hoverIdx, setHoverIdx] = useState(null)
  const width = 720, height = 260
  const padL = 40, padR = 16, padT = 20, padB = 36
  const plotW = width - padL - padR
  const plotH = height - padT - padB

  const weeks = fpy.MFG.weeks
  if (weeks.length < 2) {
    return <p className="filter-hint">Not enough weekly data yet to chart a trend.</p>
  }
  const mdaasByWeek = new Map(fpy.MDAAS.weeks.map(w => [w.weekStart, w]))

  const mfgPct = weeks.map(w => w.pctWithoutFail)
  const mdaasPct = weeks.map(w => (mdaasByWeek.get(w.weekStart)?.pctWithoutFail ?? w.pctWithoutFail))

  const mfgProjected = linearProjection(mfgPct, PROJECTION_STEPS).map(v => Math.min(100, Math.max(0, v)))
  const mdaasProjected = linearProjection(mdaasPct, PROJECTION_STEPS).map(v => Math.min(100, Math.max(0, v)))

  const realCount = weeks.length
  const total = realCount + PROJECTION_STEPS
  const xStep = plotW / (total - 1)
  const xAt = i => padL + i * xStep
  const yAt = pct => padT + plotH * (1 - pct / 100)

  function seriesLines(realVals, projVals) {
    const real = realVals.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ')
    const proj = [realVals[realCount - 1], ...projVals].map((v, i) => `${xAt(realCount - 1 + i)},${yAt(v)}`).join(' ')
    return { real, proj }
  }
  const mfgLines = seriesLines(mfgPct, mfgProjected)
  const mdaasLines = seriesLines(mdaasPct, mdaasProjected)

  const gridPcts = [0, 25, 50, 75, 100]
  // Same fix as CycleTimeTrendChart: thin against the pixel width the real weeks
  // actually span, not the full (real + projected) plot width, or the last couple
  // of week labels collide right where the dashed projection begins.
  const realPlotW = xAt(realCount - 1) - xAt(0)
  const maxLabels = Math.max(2, Math.floor(realPlotW / 45))
  const labelStep = Math.max(1, Math.ceil(weeks.length / maxLabels))
  const labelIndices = thinnedLabelIndices(weeks.length, labelStep)

  function handleMove(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * width
    let idx = Math.round((relX - padL) / xStep)
    idx = Math.max(0, Math.min(realCount - 1, idx))
    setHoverIdx(idx)
  }

  const hovered = hoverIdx != null ? weeks[hoverIdx] : null

  return (
    <div style={{ position: 'relative' }}>
      <div className="fpy-legend">
        <span><i className="fpy-swatch" style={{ background: 'var(--series1-fg)' }} /> MFG</span>
        <span><i className="fpy-swatch" style={{ background: 'var(--series2-fg)' }} /> MDAAS</span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label="First Pass Yield weekly trend, MFG vs MDAAS, with a short projected continuation"
      >
        {gridPcts.map(p => (
          <g key={p}>
            <line x1={padL} x2={width - padR} y1={yAt(p)} y2={yAt(p)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 8} y={yAt(p)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="var(--muted)">{p}%</text>
          </g>
        ))}

        <polyline points={mfgLines.real} fill="none" stroke="var(--series1-fg)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={mfgLines.proj} fill="none" stroke="var(--series1-fg)" strokeWidth="2" strokeDasharray="5 4" opacity="0.55" />
        <polyline points={mdaasLines.real} fill="none" stroke="var(--series2-fg)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={mdaasLines.proj} fill="none" stroke="var(--series2-fg)" strokeWidth="2" strokeDasharray="5 4" opacity="0.55" />
        <text x={xAt(total - 1)} y={padT + 10} textAnchor="end" fontSize="10" fill="var(--muted)">Projected →</text>

        {weeks.map((w, i) => (
          labelIndices.has(i) && (
            <text key={w.weekStart} x={xAt(i)} y={height - padB + 16} textAnchor="middle" fontSize="9.5" fill="var(--muted)">{w.weekLabel}</text>
          )
        ))}

        {weeks.map((w, i) => (
          <g key={w.weekStart}>
            <circle cx={xAt(i)} cy={yAt(mfgPct[i])} r={i === hoverIdx ? 5 : 3} fill="var(--series1-fg)" stroke="var(--surface)" strokeWidth="2" />
            <circle cx={xAt(i)} cy={yAt(mdaasPct[i])} r={i === hoverIdx ? 5 : 3} fill="var(--series2-fg)" stroke="var(--surface)" strokeWidth="2" />
          </g>
        ))}

        {hoverIdx != null && (
          <line x1={xAt(hoverIdx)} x2={xAt(hoverIdx)} y1={padT} y2={height - padB} stroke="var(--border2)" strokeWidth="1" />
        )}
      </svg>

      {hovered && (
        <div className="fpy-tooltip" style={{ left: `${(xAt(hoverIdx) / width) * 100}%` }}>
          <div className="fpy-tooltip-title">{hovered.weekLabel} <span className="filter-hint">({hovered.weekStart})</span></div>
          <div><span style={{ color: 'var(--series1-fg)' }}>●</span> MFG: <strong>{mfgPct[hoverIdx].toFixed(2)}%</strong></div>
          <div><span style={{ color: 'var(--series2-fg)' }}>●</span> MDAAS: <strong>{mdaasPct[hoverIdx].toFixed(2)}%</strong></div>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Top Failures Pareto — same shape as FirstPassYieldPage.jsx's TopFailuresChart
// (bars = station's share of THIS environment's fails, line = cumulative %,
// one 0-100% axis, no invented dual-axis alignment), parameterized per
// environment. Kept as separate charts per environment rather than one
// combined chart: MFG_STAGES/MDAAS_STAGES (firstPassYieldService.js) are
// disjoint station vocabularies, so a combined ranking would misleadingly
// imply one shared population.
// ────────────────────────────────────────────────────────────────────────
export function FailuresParetoChart({ topFailures, envLabel }) {
  const [hoverIdx, setHoverIdx] = useState(null)
  const TOP_N = 8
  const total = topFailures.reduce((s, f) => s + f.count, 0)
  const shown = topFailures.slice(0, TOP_N)
  let running = 0
  const rows = shown.map(f => {
    const pct = total ? (f.count / total) * 100 : 0
    running += pct
    return { ...f, pct, cumPct: running }
  })

  if (!rows.length) {
    return <StateBox type="empty" title={`No Failures — ${envLabel}`} message="No failing units were found for this selection." />
  }

  const width = 720, height = 260
  const padL = 40, padR = 16, padT = 20, padB = 68
  const plotW = width - padL - padR
  const plotH = height - padT - padB
  const bandW = plotW / rows.length
  const barW = Math.min(24, bandW * 0.55)
  const xCenter = i => padL + bandW * i + bandW / 2
  const yAt = pct => padT + plotH * (1 - pct / 100)
  const gridPcts = [0, 25, 50, 75, 100]

  const linePoints = rows.map((r, i) => `${xCenter(i)},${yAt(r.cumPct)}`).join(' ')
  const hovered = hoverIdx != null ? rows[hoverIdx] : null

  return (
    <div style={{ position: 'relative' }}>
      <div className="fpy-legend">
        <span><i className="fpy-swatch" style={{ background: 'var(--fail-fg)' }} /> % of {envLabel} fails at station</span>
        <span><i className="fpy-linekey" style={{ background: 'var(--info-fg)' }} /> Cumulative %</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={`Top failure stations, ${envLabel}, Pareto view`}>
        {gridPcts.map(p => (
          <g key={p}>
            <line x1={padL} x2={width - padR} y1={yAt(p)} y2={yAt(p)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 8} y={yAt(p)} textAnchor="end" dominantBaseline="middle" fontSize="10" fill="var(--muted)">{p}%</text>
          </g>
        ))}

        {rows.map((r, i) => (
          <g key={r.station} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)} style={{ cursor: 'default' }}>
            <rect x={xCenter(i) - barW / 2} y={yAt(r.pct)} width={barW} height={Math.max(0, yAt(0) - yAt(r.pct))} rx="4" fill="var(--fail-fg)" opacity={hoverIdx === i ? 1 : 0.85} />
            <rect x={padL + bandW * i} y={padT} width={bandW} height={plotH} fill="transparent" />
            <text x={xCenter(i)} y={height - padB + 12} textAnchor="end" fontSize="9.5" fill="var(--muted)" transform={`rotate(-40 ${xCenter(i)} ${height - padB + 12})`}>
              {r.station.length > 16 ? r.station.slice(0, 15) + '…' : r.station}
            </text>
          </g>
        ))}

        <polyline points={linePoints} fill="none" stroke="var(--info-fg)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {rows.map((r, i) => (
          <circle key={r.station} cx={xCenter(i)} cy={yAt(r.cumPct)} r={i === hoverIdx ? 5 : 4} fill="var(--info-fg)" stroke="var(--surface)" strokeWidth="2" />
        ))}
      </svg>

      {hovered && (
        <div className="fpy-tooltip" style={{ left: `${(xCenter(hoverIdx) / width) * 100}%` }}>
          <div className="fpy-tooltip-title">{hovered.station}</div>
          <div><strong>{hovered.count}</strong> unit(s) — {hovered.pct.toFixed(1)}% of {envLabel} fails</div>
          <div className="filter-hint">Cumulative: {hovered.cumPct.toFixed(1)}%</div>
        </div>
      )}

      {topFailures.length > TOP_N && (
        <p className="filter-hint" style={{ marginTop: '.5rem' }}>Showing top {TOP_N} of {topFailures.length} stations.</p>
      )}
    </div>
  )
}

export function PredictionPanel({ prediction }) {
  if (prediction.available) {
    return (
      <div className="mo-result">
        <h3>AI Prediction</h3>
        <p style={{ whiteSpace: 'pre-wrap' }}>{prediction.narrative}</p>
      </div>
    )
  }
  return (
    <StateBox
      type="error"
      title="AI Narrative Unavailable"
      message={`${prediction.reason} — the stats above are still real and current; only the generated narrative is missing.`}
    />
  )
}
