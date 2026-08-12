// Reusable horizontal step indicator. No existing component in this codebase
// shows done/current/upcoming state (`.tabs`/`.tab-btn` is the closest visual
// precedent but has no such semantics — see CrdUpdateModal.jsx's `step`
// string pattern for the closest behavioral precedent, generalized here).
// Clicking a completed step jumps back to it; upcoming steps aren't
// clickable — the flow can't be skipped ahead.
export default function Stepper({ steps, currentId, completedIds, onSelect }) {
  const currentIdx = steps.findIndex(s => s.id === currentId)

  return (
    <div className="wizard-steps no-print">
      {steps.map((step, i) => {
        const done = completedIds.includes(step.id)
        const current = step.id === currentId
        const state = current ? 'current' : done ? 'done' : 'upcoming'
        return (
          <div className="wizard-step-wrap" key={step.id}>
            <button
              type="button"
              className={`wizard-step ${state}`}
              disabled={!done && !current}
              onClick={() => done && onSelect(step.id)}
            >
              <span className="wizard-step-node">{done && !current ? '✓' : i + 1}</span>
              <span className="wizard-step-label">{step.label}</span>
            </button>
            {i < steps.length - 1 && (
              <span className={`wizard-step-connector ${i < currentIdx ? 'done' : ''}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}
