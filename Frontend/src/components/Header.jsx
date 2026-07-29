import { useState, useEffect, useRef } from 'react'
import crest from '../assets/bomguard-crest.png'
import ThemeToggle from './ThemeToggle'
import './Header.css'

export default function Header({ pages, activePage, onNavigate }) {
  const [open, setOpen] = useState(false)
  const [openDropdown, setOpenDropdown] = useState(null)
  const closeTimerRef = useRef(null)

  function clearCloseTimer() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  useEffect(() => clearCloseTimer, [])

  function closeMenu() {
    clearCloseTimer()
    setOpen(false)
    setOpenDropdown(null)
  }

  // The dropdown menu sits below the trigger with a gap (for visual spacing),
  // and it's absolutely positioned so it doesn't extend the trigger wrapper's
  // hoverable box — the cursor briefly leaves all elements while crossing that
  // gap. Closing on a delay (cancelled by re-entering the trigger or menu)
  // gives the mouse time to bridge it instead of slamming the menu shut.
  function openDropdownNow(id) {
    clearCloseTimer()
    setOpenDropdown(id)
  }

  function closeDropdownSoon() {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => setOpenDropdown(null), 300)
  }

  function selectPage(id) {
    return (e) => {
      e.preventDefault()
      onNavigate(id)
      closeMenu()
    }
  }

  // On hover-capable devices, mouseenter already opens the menu before the
  // click lands, so a naive toggle would immediately close what hover just
  // opened — set-open instead. Touch devices have no hover, so click there
  // still needs to toggle (open, then close on a second tap).
  function handleTriggerClick(id) {
    const supportsHover = window.matchMedia?.('(hover: hover)').matches
    return (e) => {
      e.preventDefault()
      if (supportsHover) {
        openDropdownNow(id)
      } else {
        clearCloseTimer()
        setOpenDropdown(cur => (cur === id ? null : id))
      }
    }
  }

  useEffect(() => {
    function handleDocumentClick(e) {
      if (!e.target.closest('.nav-dropdown')) setOpenDropdown(null)
    }
    document.addEventListener('click', handleDocumentClick)
    return () => document.removeEventListener('click', handleDocumentClick)
  }, [])

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
              {pages.map(page => {
                if (!page.children) {
                  return (
                    <a
                      key={page.id}
                      href="#"
                      className={page.id === activePage ? 'active' : undefined}
                      onClick={selectPage(page.id)}
                    >
                      {page.label}
                    </a>
                  )
                }

                const childActive = page.children.some(child => child.id === activePage)

                return (
                  <div
                    key={page.id}
                    className={`nav-dropdown${openDropdown === page.id ? ' open' : ''}`}
                    onMouseEnter={() => openDropdownNow(page.id)}
                    onMouseLeave={closeDropdownSoon}
                  >
                    <button
                      type="button"
                      className={`nav-dropdown-trigger${childActive ? ' active' : ''}`}
                      aria-expanded={openDropdown === page.id}
                      onClick={handleTriggerClick(page.id)}
                    >
                      {page.label}
                      <span className="caret" aria-hidden="true" />
                    </button>
                    <div className="nav-dropdown-menu">
                      {page.children.map(child => (
                        child.disabled ? (
                          <span key={child.id} className="disabled" aria-disabled="true">
                            {child.label}
                            {child.note && <em className="nav-dropdown-note">{child.note}</em>}
                          </span>
                        ) : (
                          <a
                            key={child.id}
                            href="#"
                            className={child.id === activePage ? 'active' : undefined}
                            onClick={selectPage(child.id)}
                          >
                            {child.label}
                          </a>
                        )
                      ))}
                    </div>
                  </div>
                )
              })}
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
                    <span className="line2 metal">Every revision deffended.</span>
                  </h1>
                  <p className="lede">
                    BOMGUARD validates, version-locks, and audits your bills of material —
                    so a wrong component, a stale revision, or an unapproved swap never
                    reaches the production floor.
                  </p>
                  <div className="hero-actions">
                    <a className="btn btn-gold" href="#" onClick={selectPage('msft-projects')}>MSFT Projects</a>
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
