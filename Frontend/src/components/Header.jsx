import { useState } from 'react'
import crest from '../assets/bomguard-crest.png'
import ThemeToggle from './ThemeToggle'
import './Header.css'

export default function Header({ pages, activePage, onNavigate }) {
  const [open, setOpen] = useState(false)

  function closeMenu() {
    setOpen(false)
  }

  function selectPage(id) {
    return (e) => {
      e.preventDefault()
      onNavigate(id)
      closeMenu()
    }
  }

  return (
    <div className="bomguard-header" role="banner">
      <div className="masthead">
        <nav className={`nav${open ? ' open' : ''}`} id="nav">
          <div className="container nav-inner">
            <a className="brand" href="#" aria-label="BOMGUARD home" onClick={selectPage('home')}>
              <img className="crest" src={crest} alt="" />
              <span className="wordmark">
                <span className="name metal">BOMGUARD</span>
                <span className="tag">Bill of Material Safeguard</span>
              </span>
            </a>

            <div className="nav-links" id="navLinks">
              {pages.map(page => (
                <a
                  key={page.id}
                  href="#"
                  className={page.id === activePage ? 'active' : undefined}
                  onClick={selectPage(page.id)}
                >
                  {page.label}
                </a>
              ))}
            </div>

            <ThemeToggle />

            <button
              className="hamburger"
              id="hamburger"
              aria-label="Toggle menu"
              aria-expanded={open}
              onClick={() => setOpen(o => !o)}
            >
              <span></span><span></span><span></span>
            </button>
          </div>
        </nav>

        {activePage === 'home' && (
          <div className="hero">
            <div className="container">
              <div className="hero-grid">
                <div className="hero-copy">
                  <span className="eyebrow">Bill of Material Integrity</span>
                  <h1>
                    <span className="metal">Every part accounted for.</span>
                    <span className="line2 metal">Every revision defended.</span>
                  </h1>
                  <p className="lede">
                    BOMGUARD validates, version-locks, and audits your bills of material —
                    so a wrong component, a stale revision, or an unapproved swap never
                    reaches the production floor.
                  </p>
                  <div className="hero-actions">
                    <a className="btn btn-gold" href="#" onClick={selectPage('bom')}>Request a demo</a>
                    <a className="btn btn-ghost" href="#" onClick={selectPage('bom')}>See how it works &nbsp;→</a>
                  </div>
                  <div className="trust">
                    <span className="dot" aria-hidden="true"></span>
                    Trusted to guard 2.4M+ line items across regulated supply chains
                  </div>
                </div>

                <div className="hero-crest">
                  <img src={crest} alt="BOMGUARD crest" />
                </div>
              </div>

              {/* signature divider */}
              <div className="rune-rule" aria-hidden="true">
                <span className="line"></span>
                <svg width="30" height="24" viewBox="0 0 60 48" fill="none" stroke="url(#bomguard-rune-g)" strokeWidth="3" strokeLinejoin="round">
                  <defs>
                    <linearGradient id="bomguard-rune-g" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#f4e3a1" /><stop offset="1" stopColor="#9a7420" />
                    </linearGradient>
                  </defs>
                  <path d="M30 4 L48 40 L12 40 Z" />
                  <path d="M22 8 L40 44 L4 44 Z" />
                  <path d="M38 8 L56 44 L20 44 Z" />
                </svg>
                <span className="line r"></span>
              </div>

              {/* stat strip */}
              <div className="strip">
                <div className="stat"><div className="k metal">99.98%</div><div className="l">Release accuracy after guardrails</div></div>
                <div className="stat"><div className="k metal">&lt; 30s</div><div className="l">Full-BOM validation, any size</div></div>
                <div className="stat"><div className="k metal">SOC 2 · ISO</div><div className="l">Audit-ready change history</div></div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
