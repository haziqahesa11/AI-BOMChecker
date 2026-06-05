export default function Header() {
  return (
    <header>
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect width="28" height="28" rx="6" fill="rgba(0,214,143,.08)" stroke="rgba(0,214,143,.2)" strokeWidth="1" />
        <rect x="5" y="7" width="8" height="5" rx="1" fill="rgba(0,214,143,.75)" />
        <rect x="15" y="7" width="8" height="5" rx="1" fill="rgba(59,130,246,.75)" />
        <rect x="5" y="15" width="18" height="2" rx="1" fill="rgba(255,255,255,.2)" />
        <rect x="5" y="19" width="12" height="2" rx="1" fill="rgba(255,255,255,.1)" />
      </svg>
      <h1>AURA-T</h1>
      <span className="sub">BOM vs CRD</span>
      <span className="badge">Wiwynn</span>
    </header>
  )
}
