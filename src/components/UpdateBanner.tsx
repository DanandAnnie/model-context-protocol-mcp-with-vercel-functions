import { RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import { useAppUpdate } from '../hooks/useAppUpdate'

export default function UpdateBanner() {
  const { updateAvailable, applyUpdate } = useAppUpdate()
  const [dismissed, setDismissed] = useState(false)

  if (!updateAvailable || dismissed) return null

  return (
    <div className="bg-violet-600 text-white px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
      <span className="flex items-center gap-2">
        <RefreshCw size={14} className="animate-spin-slow" />
        A new version is available!
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={applyUpdate}
          className="px-3 py-1 bg-white text-violet-700 rounded-md text-xs font-semibold hover:bg-violet-50 transition-colors"
        >
          Update Now
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="p-1 hover:bg-violet-500 rounded transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
