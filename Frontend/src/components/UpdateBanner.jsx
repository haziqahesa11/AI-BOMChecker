import { useEffect, useRef, useState } from 'react'
import './UpdateBanner.css'

const POLL_INTERVAL_MS = 60000

export default function UpdateBanner() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const baselineBuildId = useRef(null)

  useEffect(() => {
    async function checkVersion() {
      try {
        const res = await fetch('/api/version')
        if (!res.ok) return
        const { buildId } = await res.json()
        if (baselineBuildId.current === null) {
          baselineBuildId.current = buildId
        } else if (buildId !== baselineBuildId.current) {
          setUpdateAvailable(true)
        }
      } catch {
        // transient network error — skip this tick, don't flag a false update
      }
    }

    checkVersion()
    const id = setInterval(checkVersion, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

  if (!updateAvailable) return null

  return (
    <div className="update-banner" role="status">
      <span>A new version of BOMGUARD is available.</span>
      <button type="button" onClick={() => window.location.reload()}>
        Refresh Now
      </button>
    </div>
  )
}
