import { useState, useEffect, useCallback } from 'react'

const CHECK_INTERVAL = 30 * 60 * 1000 // 30 minutes
const BASE_URL = import.meta.env.BASE_URL || '/'

export function useAppUpdate() {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)

  const checkForUpdate = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}version.json?t=${Date.now()}`, {
        cache: 'no-store',
      })
      if (!res.ok) return

      const data = await res.json()
      const serverVersion = data.version as string

      const stored = localStorage.getItem('app_version')
      if (!stored) {
        // First load — store current version
        localStorage.setItem('app_version', serverVersion)
        setCurrentVersion(serverVersion)
        return
      }

      setCurrentVersion(stored)
      if (stored !== serverVersion) {
        localStorage.setItem('app_pending_version', serverVersion)
        setUpdateAvailable(true)
      }
    } catch {
      // Offline or fetch failed — skip
    }
  }, [])

  const applyUpdate = useCallback(() => {
    // Clear the SW cache and reload
    if ('caches' in window) {
      caches.keys().then((names) => {
        names.forEach((name) => caches.delete(name))
      })
    }
    // Update stored version before reload
    const serverVersion = localStorage.getItem('app_pending_version')
    if (serverVersion) {
      localStorage.setItem('app_version', serverVersion)
      localStorage.removeItem('app_pending_version')
    }
    window.location.reload()
  }, [])

  useEffect(() => {
    // Also listen for SW controller change (new SW activated)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        setUpdateAvailable(true)
      })
    }

    checkForUpdate()
    const interval = setInterval(checkForUpdate, CHECK_INTERVAL)
    return () => clearInterval(interval)
  }, [checkForUpdate])

  // On visibility change, check for update (user returns to app)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        checkForUpdate()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [checkForUpdate])

  return { updateAvailable, currentVersion, applyUpdate, checkForUpdate }
}
