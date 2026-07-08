import { useEffect } from 'react'

export default function RowDetailModal({ item, onClose }) {
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  if (!item) return null

  const statusClass =
    item.status === 'PASS'     ? 'badge-pass' :
    item.status === 'FAIL'     ? 'badge-fail' :
    item.status === 'NO_MATCH' ? 'badge-grey' : 'badge-warn'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>

        <div className="modal-header">
          <span className="modal-title">
            {item.bomLocation || item.crdItem || 'Detail'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
            <span className={statusClass}>{item.status}</span>
            <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="modal-body">
          {item.type === 'MATCHED' && (
            <>
              <div className="modal-section">
                <div className="modal-section-title">BOM Data</div>
                <div className="modal-fields">
                  <div className="modal-field">
                    <div className="k">Location</div>
                    <div className="v">{item.bomLocation || '—'}</div>
                  </div>
                  <div className="modal-field">
                    <div className="k">Child Part Number</div>
                    <div className="v">{item.bomChildPN || '—'}</div>
                  </div>
                  <div className="modal-field">
                    <div className="k">Child Revision</div>
                    <div className="v">{item.bomChildRev || '—'}</div>
                  </div>
                  <div className="modal-field">
                    <div className="k">BOM Version</div>
                    <div className="v">{item.bomVersion || '—'}</div>
                  </div>
                </div>
              </div>

              <div className="modal-section">
                <div className="modal-section-title">CRD Spec</div>
                <div className="modal-fields">
                  <div className="modal-field">
                    <div className="k">Item</div>
                    <div className="v">{item.crdItem || '—'}</div>
                  </div>
                  <div className="modal-field">
                    <div className="k">Group</div>
                    <div className="v">{item.crdGroup || '—'}</div>
                  </div>
                  <div className="modal-field">
                    <div className="k">Version</div>
                    <div className="v">{item.crdVersion || '—'}</div>
                  </div>
                  <div className="modal-field">
                    <div className="k">Notes</div>
                    <div className="v">{item.crdNotes || '—'}</div>
                  </div>
                </div>
              </div>

              <div className="modal-section">
                <div className="modal-section-title">Match Analysis</div>
                <div className="modal-fields">
                  <div className="modal-field">
                    <div className="k">Location Score</div>
                    <div className="v">{item.locationScore}%</div>
                  </div>
                  <div className="modal-field">
                    <div className="k">Version Score</div>
                    <div className="v" style={{
                      color: item.versionScore >= 90
                        ? 'var(--pass-fg)'
                        : item.versionScore >= 70
                        ? 'var(--warn-fg)'
                        : 'var(--fail-fg)'
                    }}>
                      {item.versionScore}%
                    </div>
                  </div>
                  <div className="modal-field" style={{ gridColumn: '1/-1' }}>
                    <div className="k">Verdict</div>
                    <div className="v">{item.statusDetail || '—'}</div>
                  </div>
                </div>
              </div>
            </>
          )}

          {item.type === 'BOM_ONLY' && (
            <div className="modal-section">
              <div className="modal-section-title">BOM-Only Item</div>
              <div className="modal-fields">
                <div className="modal-field">
                  <div className="k">Location</div>
                  <div className="v">{item.bomLocation || '—'}</div>
                </div>
                <div className="modal-field">
                  <div className="k">Child Part Number</div>
                  <div className="v">{item.bomChildPN || '—'}</div>
                </div>
                <div className="modal-field">
                  <div className="k">Child Revision</div>
                  <div className="v">{item.bomChildRev || '—'}</div>
                </div>
                <div className="modal-field">
                  <div className="k">BOM Version</div>
                  <div className="v">{item.bomVersion || '—'}</div>
                </div>
              </div>
              <div className="modal-note">
                No matching CRD spec entry found for this BOM item.
              </div>
            </div>
          )}

          {item.type === 'CRD_ONLY' && (
            <div className="modal-section">
              <div className="modal-section-title">CRD-Only Item</div>
              <div className="modal-fields">
                <div className="modal-field">
                  <div className="k">Item</div>
                  <div className="v">{item.crdItem || '—'}</div>
                </div>
                <div className="modal-field">
                  <div className="k">Group</div>
                  <div className="v">{item.crdGroup || '—'}</div>
                </div>
                <div className="modal-field">
                  <div className="k">Version</div>
                  <div className="v">{item.crdVersion || '—'}</div>
                </div>
                <div className="modal-field">
                  <div className="k">Notes</div>
                  <div className="v">{item.crdNotes || '—'}</div>
                </div>
              </div>
              <div className="modal-note">
                No matching BOM entry found for this CRD spec.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
