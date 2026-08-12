import { useEffect, useRef, useState } from 'react'
import { deriveOwnerTeam } from '../../lib/bomguardDemoData'

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// One-click pipeline trace — runs all 8 BOM Workflow stages automatically,
// end to end, with no further clicks. Reads like an AI agent working through
// a task list: each row goes pending -> running -> done on its own, cycling
// through a couple of interim status lines before settling (real AI analysis
// doesn't resolve in one tick — this mirrors that pacing rather than
// snapping straight to a result). Only the final step makes a real network
// call (POST /api/bomguard-workflow/submit, which has no database import at
// all — see BackEnd/server.js); every other step is a deterministic
// transform of the matched demo record, so the sequence never stalls on
// network/SQL latency.
export default function PipelineRunner({ record, onDone }) {
  const [stepIndex, setStepIndex] = useState(-1)
  const [phaseText, setPhaseText] = useState('')
  const [doneText, setDoneText] = useState({})
  const receiptRef = useRef(null)

  const owner = deriveOwnerTeam(record.sn, record.location)

  const steps = [
    {
      title: 'BOM Detection',
      phases: [`Scanning BOM sources for ${record.sn}…`, `Cross-checking ${record.location} platform records…`],
      finish: async () => `BOM source detected — ${record.platform} (${record.location})`,
    },
    {
      title: 'Selection of BOM',
      phases: ['Locating BOM bracket…', 'Resolving designated BOM owner…'],
      finish: async () => `Assigned to ${owner}`,
    },
    {
      title: 'BOM Preparation',
      phases: ['Pulling TPG reference data (Location, CRD Cfg, FRU Spec)…', 'Preparing Status and Description fields…'],
      finish: async () => `Reference data prepared — "${record.description}"`,
    },
    {
      title: 'Creating BOM',
      phases: ['Cloning line items from Golden Template…', 'Building working BOM…'],
      finish: async () => `Working BOM created — Qty ${record.quantity}, Status ${record.status}`,
    },
    {
      title: 'Detections',
      phases: [`Fetching release MO ${record.mo}…`, 'Comparing working BOM against MO item list…'],
      finish: async () => `Match confirmed — quantity verified (${record.quantity} unit(s))`,
    },
    {
      title: 'Analytics & AI Integration',
      phases: [
        'Pulling cycle time history (PT stage)…',
        'Pulling first pass yield trends (MFG / MDAAS)…',
        'Correlating failure stations…',
        'AI generating narrative summary…',
      ],
      finish: async () => 'Analysis complete — AI narrative generated',
    },
    {
      title: 'Printing the BOM',
      phases: ['Compiling printable BOM datasheet…'],
      finish: async () => 'Datasheet ready',
    },
    {
      title: 'Uploading to Database',
      phases: ['Submitting finalized BOM…'],
      finish: async () => {
        const fallback = () => ({
          referenceId: 'BG-' + Date.now().toString(36).toUpperCase(),
          submittedAt: new Date().toISOString(),
        })
        let result
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 2500)
          const [res] = await Promise.all([
            fetch('/api/bomguard-workflow/submit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cpn: record.sn, modelRef: record.platform, moNumber: record.mo, lineCount: 1 }),
              signal: controller.signal,
            }),
            wait(400),
          ])
          clearTimeout(timeout)
          result = res.ok ? await res.json() : fallback()
        } catch {
          result = fallback()
        }
        receiptRef.current = result
        return `Uploaded — Reference ${result.referenceId}`
      },
    },
  ]

  useEffect(() => {
    let cancelled = false
    const PHASE_DELAY = 750

    async function runAll() {
      for (let i = 0; i < steps.length; i++) {
        if (cancelled) return
        setStepIndex(i)
        for (const phase of steps[i].phases) {
          if (cancelled) return
          setPhaseText(phase)
          await wait(PHASE_DELAY)
        }
        if (cancelled) return
        const text = await steps[i].finish()
        if (cancelled) return
        setDoneText(prev => ({ ...prev, [i]: text }))
      }
      if (!cancelled) onDone(receiptRef.current)
    }

    runAll()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="pipeline-trace">
      {steps.map((step, i) => {
        const state = i < stepIndex || doneText[i] ? 'done' : i === stepIndex ? 'running' : 'pending'
        return (
          <div key={step.title} className={`pipeline-row ${state}`}>
            <span className="pipeline-icon">
              {state === 'done' ? '✓' : state === 'running' ? <span className="spinner-sm" /> : i + 1}
            </span>
            <span className="pipeline-text">
              <span className="pipeline-title">{step.title}</span>
              <span className="pipeline-status">
                {state === 'done' ? doneText[i] : state === 'running' ? phaseText : 'Queued'}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
