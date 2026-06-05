import Gauge from '../Gauge'

function DistChart({ pass, fail, bomOnly, crdOnly }) {
  const total = pass + fail + bomOnly + crdOnly || 1
  const bars = [
    { label: 'Pass',     value: pass,    color: 'var(--pass-fg)', pct: (pass / total) * 100 },
    { label: 'Fail',     value: fail,    color: 'var(--fail-fg)', pct: (fail / total) * 100 },
    { label: 'BOM Only', value: bomOnly, color: '#60a5fa',         pct: (bomOnly / total) * 100 },
    { label: 'CRD Only', value: crdOnly, color: '#a78bfa',         pct: (crdOnly / total) * 100 },
  ]

  return (
    <div className="dist-chart">
      <div className="dist-chart-title">Anomaly Distribution</div>
      {bars.map(b => (
        <div key={b.label} className="dist-bar-row">
          <div className="dist-bar-label">{b.label}</div>
          <div className="dist-bar-track">
            <div
              className="dist-bar-fill"
              style={{ width: `${b.pct}%`, background: b.color }}
            />
          </div>
          <div className="dist-bar-val" style={{ color: b.value > 0 ? b.color : 'var(--muted)' }}>
            {b.value}
          </div>
        </div>
      ))}
    </div>
  )
}

export default function OverviewPanel({ data: d }) {
  const pillClass =
    d.overallStatus === 'PASS'    ? 'badge-pass' :
    d.overallStatus === 'WARNING' ? 'badge-warn' : 'badge-fail'

  return (
    <>
      <div className="meta-row">
        <div className="item">
          <span className="k">BOM Part Number</span>
          <span className="v">{d.partNumber}</span>
        </div>
        <div className="item">
          <span className="k">CRD Spec Number</span>
          <span className="v">{d.crdPN}</span>
        </div>
        <div className="item">
          <span className="k">BOM Rows</span>
          <span className="v">{d.bomData.length}</span>
        </div>
        <div className="item">
          <span className="k">CRD Lines</span>
          <span className="v">{d.crdData.length}</span>
        </div>
      </div>

      <div className="overview-grid">
        <div className="score-card">
          <div className="label">Configuration Score</div>
          <Gauge score={d.overallScore} status={d.overallStatus} />
          <span className={`${pillClass} status-pill`}>{d.overallStatus}</span>
          <div style={{ marginTop: '.6rem', fontSize: '.72rem', color: 'var(--muted)' }}>
            Threshold: ≥ 90% = PASS
          </div>
        </div>

        <div>
          <div className="stat-cards">
            <div className="stat-card info">
              <div className="val">{d.totalMatched}</div>
              <div className="lbl">Pairs Compared</div>
            </div>
            <div className="stat-card pass">
              <div className="val" style={{ color: 'var(--pass-fg)' }}>{d.passCount}</div>
              <div className="lbl">Passed (≥90%)</div>
            </div>
            <div className="stat-card fail">
              <div className="val" style={{ color: 'var(--fail-fg)' }}>{d.failCount}</div>
              <div className="lbl">Failed (&lt;90%)</div>
            </div>
            <div className="stat-card warn">
              <div className="val" style={{ color: 'var(--warn-fg)' }}>{d.bomOnlyCount}</div>
              <div className="lbl">BOM Only</div>
            </div>
            <div className="stat-card warn">
              <div className="val" style={{ color: 'var(--warn-fg)' }}>{d.crdOnlyCount}</div>
              <div className="lbl">CRD Only</div>
            </div>
          </div>

          <DistChart
            pass={d.passCount}
            fail={d.failCount}
            bomOnly={d.bomOnlyCount}
            crdOnly={d.crdOnlyCount}
          />
        </div>
      </div>
    </>
  )
}
