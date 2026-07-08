import { useEffect, useRef } from 'react'

const CIRCUMFERENCE = 339.3

export default function Gauge({ score, status }) {
  const fillRef = useRef(null)
  const pctRef = useRef(null)

  const color = status === 'PASS' ? '#22c55e' : status === 'WARNING' ? '#f59e0b' : '#ef4444'

  useEffect(() => {
    requestAnimationFrame(() => {
      if (fillRef.current) {
        fillRef.current.style.strokeDashoffset = CIRCUMFERENCE * (1 - score / 100)
      }
      if (pctRef.current) {
        pctRef.current.textContent = score.toFixed(1) + '%'
      }
    })
  }, [score])

  return (
    <div className="gauge-wrap">
      <svg width="140" height="140" viewBox="0 0 140 140" style={{ transform: 'rotate(-90deg)' }}>
        <circle className="gauge-bg" cx="70" cy="70" r="54" />
        <circle
          ref={fillRef}
          className="gauge-fill"
          cx="70" cy="70" r="54"
          stroke={color}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE}
        />
      </svg>
      <div className="gauge-text">
        <span ref={pctRef} className="gauge-pct" style={{ color }}>—</span>
        <span className="gauge-sub">match score</span>
      </div>
    </div>
  )
}
