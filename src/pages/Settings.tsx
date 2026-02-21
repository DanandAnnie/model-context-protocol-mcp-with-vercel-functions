import { useState } from 'react'
import { Settings as SettingsIcon, Cloud, CloudOff, Check, AlertTriangle, Smartphone } from 'lucide-react'
import { isSupabaseConfigured, saveSupabaseConfig, getSupabaseConfig, supabase } from '../lib/supabase'

export default function Settings() {
  const existing = getSupabaseConfig()
  const [url, setUrl] = useState(existing.url)
  const [key, setKey] = useState(existing.key)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const connected = isSupabaseConfigured()

  const handleSave = async () => {
    if (!url.trim() || !key.trim()) {
      // Disconnecting
      saveSupabaseConfig('', '')
      setStatus('idle')
      window.location.reload()
      return
    }

    setTesting(true)
    setStatus('idle')
    setErrorMsg('')

    try {
      // Save config first so the client uses the new credentials
      saveSupabaseConfig(url.trim(), key.trim())

      // Test the connection
      const { error } = await supabase.from('properties').select('id').limit(1)

      if (error) {
        // If the table doesn't exist, that's OK — they just need to run the migration
        if (error.message.includes('does not exist')) {
          setStatus('error')
          setErrorMsg('Connected, but tables not found. Run the SQL migration in your Supabase SQL Editor (see supabase/migrations/001_initial_schema.sql).')
          return
        }
        throw error
      }

      setStatus('success')
      // Reload to re-initialize all hooks with Supabase
      setTimeout(() => window.location.reload(), 1500)
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Failed to connect. Check your URL and key.')
      // Revert config on failure
      saveSupabaseConfig(existing.url, existing.key)
    } finally {
      setTesting(false)
    }
  }

  const handleDisconnect = () => {
    saveSupabaseConfig('', '')
    setUrl('')
    setKey('')
    setStatus('idle')
    window.location.reload()
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <SettingsIcon size={24} />
          Settings
        </h1>
        <p className="text-slate-500 text-sm mt-1">Configure cloud sync for cross-device access</p>
      </div>

      {/* Sync status */}
      <div className={`rounded-xl border p-4 flex items-center gap-3 ${
        connected
          ? 'bg-green-50 border-green-200'
          : 'bg-amber-50 border-amber-200'
      }`}>
        {connected ? (
          <>
            <Cloud size={20} className="text-green-600" />
            <div>
              <p className="text-sm font-medium text-green-800">Cloud Sync Active</p>
              <p className="text-xs text-green-600">Changes sync across all your devices in real-time</p>
            </div>
          </>
        ) : (
          <>
            <CloudOff size={20} className="text-amber-600" />
            <div>
              <p className="text-sm font-medium text-amber-800">Local Only</p>
              <p className="text-xs text-amber-600">Data is stored on this device only. Connect Supabase to sync across devices.</p>
            </div>
          </>
        )}
      </div>

      {/* Cross-device instructions */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Smartphone size={16} />
          Sync Android & iOS
        </h2>
        <div className="text-sm text-slate-600 space-y-3">
          <p>To sync between your Android and iOS devices, you need a free Supabase database:</p>
          <ol className="list-decimal list-inside space-y-2 text-sm">
            <li>Go to <strong>supabase.com</strong> and create a free account</li>
            <li>Click <strong>"New Project"</strong> and wait for it to set up (~2 min)</li>
            <li>Go to <strong>SQL Editor</strong> and paste the migration SQL from <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">supabase/migrations/001_initial_schema.sql</code></li>
            <li>Go to <strong>Database &gt; Replication</strong> and enable Realtime for: properties, items, storage_units</li>
            <li>Go to <strong>Settings &gt; API</strong> and copy the <strong>Project URL</strong> and <strong>anon public key</strong></li>
            <li>Paste them below and tap <strong>Connect</strong></li>
            <li><strong>Do the same on your other device</strong> — paste the same URL and key</li>
          </ol>
        </div>
      </div>

      {/* Supabase config form */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700">Supabase Connection</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Project URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-project.supabase.co"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Anon Public Key</label>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIs..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-xs"
            />
          </div>
        </div>

        {status === 'success' && (
          <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 rounded-lg p-3">
            <Check size={16} />
            Connected! Reloading...
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg p-3">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleSave}
            disabled={testing || (!url.trim() && !key.trim())}
            className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {testing ? (
              <>
                <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />
                Testing...
              </>
            ) : (
              <>
                <Cloud size={16} />
                Connect
              </>
            )}
          </button>
          {connected && (
            <button
              onClick={handleDisconnect}
              className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
