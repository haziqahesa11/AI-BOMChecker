import { useState } from 'react'
import Stepper from './bomguard/Stepper'
import Stage1Detection from './bomguard/Stage1Detection'
import Stage2Selection from './bomguard/Stage2Selection'
import Stage3Preparation from './bomguard/Stage3Preparation'
import Stage4Creation from './bomguard/Stage4Creation'
import Stage5Detection from './bomguard/Stage5Detection'
import Stage6Analytics from './bomguard/Stage6Analytics'
import Stage7Print from './bomguard/Stage7Print'
import Stage8Upload from './bomguard/Stage8Upload'

const STEPS = [
  { id: 'detect', label: 'Detection' },
  { id: 'select', label: 'Selection' },
  { id: 'prepare', label: 'Preparation' },
  { id: 'create', label: 'Creation' },
  { id: 'detections', label: 'Detections' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'print', label: 'Printing' },
  { id: 'upload', label: 'Upload' },
]

// Orchestrates the full 8-stage BOM Workflow: BOM detection -> BOM selection
// (with designated owner) -> preparation -> creation from the Golden Template
// -> detection/comparison against a release MO -> analytics/AI -> printing ->
// upload. Every stage pulls real data from the app's existing read-only
// endpoints; only Stage 5's diff and Stage 8's submit involve any new logic,
// and Stage 8 is structurally incapable of writing to a real database (see
// its own comment). All state here is plain React state — nothing is
// persisted, so navigating away and back always starts fresh at Stage 1.
export default function BomguardWorkflowPage() {
  const [currentStep, setCurrentStep] = useState('detect')
  const [completedIds, setCompletedIds] = useState([])

  const [detection, setDetection] = useState(null)
  const [selection, setSelection] = useState(null)
  const [preparedDetail, setPreparedDetail] = useState(null)
  const [workingBom, setWorkingBom] = useState(null)
  const [moNumber, setMoNumber] = useState(null)

  function advance(id, apply) {
    apply()
    setCompletedIds(prev => (prev.includes(currentStep) ? prev : [...prev, currentStep]))
    setCurrentStep(id)
  }

  // Jumping back to an earlier completed step un-marks every step after it —
  // each stage component re-fetches on mount, so resuming forward from here
  // always recomputes fresh rather than carrying stale merged data.
  function handleStepSelect(id) {
    const idx = STEPS.findIndex(s => s.id === id)
    setCompletedIds(prev => prev.filter(cid => STEPS.findIndex(s => s.id === cid) < idx))
    setCurrentStep(id)
  }

  return (
    <div className="app-body">
      <main>
        <Stepper steps={STEPS} currentId={currentStep} completedIds={completedIds} onSelect={handleStepSelect} />

        {currentStep === 'detect' && (
          <Stage1Detection
            value={detection}
            onComplete={data => advance('select', () => setDetection(data))}
          />
        )}

        {currentStep === 'select' && (
          <Stage2Selection
            detection={detection}
            value={selection}
            onComplete={data => advance('prepare', () => setSelection(data))}
          />
        )}

        {currentStep === 'prepare' && (
          <Stage3Preparation
            selection={selection}
            onComplete={data => advance('create', () => setPreparedDetail(data))}
          />
        )}

        {currentStep === 'create' && (
          <Stage4Creation
            selection={selection}
            preparedDetail={preparedDetail}
            onComplete={bom => advance('detections', () => setWorkingBom(bom))}
          />
        )}

        {currentStep === 'detections' && (
          <Stage5Detection
            detection={detection}
            selection={selection}
            workingBom={workingBom}
            onComplete={data => advance('analytics', () => {
              setWorkingBom(data.workingBom)
              setMoNumber(data.moNumber)
            })}
          />
        )}

        {currentStep === 'analytics' && (
          <Stage6Analytics
            selection={selection}
            onComplete={() => advance('print', () => {})}
          />
        )}

        {currentStep === 'print' && (
          <Stage7Print
            detection={detection}
            selection={selection}
            moNumber={moNumber}
            workingBom={workingBom}
            onComplete={() => advance('upload', () => {})}
          />
        )}

        {currentStep === 'upload' && (
          <Stage8Upload
            detection={detection}
            selection={selection}
            moNumber={moNumber}
            workingBom={workingBom}
            onComplete={() => setCompletedIds(prev => (prev.includes('upload') ? prev : [...prev, 'upload']))}
          />
        )}
      </main>
    </div>
  )
}
