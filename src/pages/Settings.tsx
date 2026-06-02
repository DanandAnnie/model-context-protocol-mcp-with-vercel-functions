import { useState } from 'react'
import {
  Settings as SettingsIcon, Cloud, CloudOff, Check, AlertTriangle,
  Smartphone, Brain, Eye, Building2, Download, Upload,
  Users, Copy, UserPlus, FileSpreadsheet, HardDrive, Mail, Loader2, LogOut,
} from 'lucide-react'
import { isSupabaseConfigured, saveSupabaseConfig, getSupabaseConfig, supabase } from '../lib/supabase'
import { getAnthropicKey, saveAnthropicKey, isAIConfigured } from '../lib/ai'
import {
  isGoogleConfigured, isGoogleClientIdSet, getGoogleClientId, saveGoogleClientId,
  signInWithGoogle, clearGoogleToken, getGoogleEmail,
} from '../lib/google'
import { getCachedData, cacheData } from '../lib/offline'
import { useAuth } from '../hooks/useAuth'

interface BusinessProfile {
  businessName: string
  ownerName: string
  taxId: string
  fiscalYearEnd: string // MM-DD format
  phone: string
  email: string
}

function getBusinessProfile(): BusinessProfile {
  try {
    const stored = localStorage.getItem('staging_business_profile')
    if (stored) return JSON.parse(stored)
  } catch { /* empty */ }
  return { businessName: '', ownerName: '', taxId: '', fiscalYearEnd: '12-31', phone: '', email: '' }
}

function saveBusinessProfile(profile: BusinessProfile) {
  localStorage.setItem('staging_business_profile', JSON.stringify(profile))
}

export default function Settings() {
  const { profile: authProfile, team, isLocalMode, joinTeam, updateProfile } = useAuth()

  const existing = getSupabaseConfig()
  const [url, setUrl] = useState(existing.url)
  const [key, setKey] = useState(existing.key)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  // AI settings
  const [aiKey, setAiKey] = useState(getAnthropicKey())
  const [aiSaved, setAiSaved] = useState(false)

  // Team settings
  const [inviteCode, setInviteCode] = useState('')
  const [joinError, setJoinError] = useState('')
  const [joinSuccess, setJoinSuccess] = useState('')
  const [codeCopied, setCodeCopied] = useState(false)
  const [editName, setEditName] = useState(authProfile?.display_name || '')
  const [nameSaved, setNameSaved] = useState(false)

  // Business profile
  const [profile, setProfile] = useState<BusinessProfile>(getBusinessProfile)
  const [profileSaved, setProfileSaved] = useState(false)

  // Google integration
  const [googleClientId, setGoogleClientId] = useState(getGoogleClientId())
  const [googleConnecting, setGoogleConnecting] = useState(false)
  const [googleError, setGoogleError] = useState('')
  const [googleSaved, setGoogleSaved] = useState(false)
  const googleConnected = isGoogleConfigured()
  const googleEmail = getGoogleEmail()

  const handleGoogleConnect = async () => {
    setGoogleConnecting(true)
    setGoogleError('')
    try {
      await signInWithGoogle()
      window.location.reload()
    } catch (err) {
      setGoogleError(err instanceof Error ? err.message : 'Google sign-in failed')
    } finally {
      setGoogleConnecting(false)
    }
  }

  const handleGoogleDisconnect = () => {
    clearGoogleToken()
    window.location.reload()
  }

  // Data management
  const [exportStatus, setExportStatus] = useState<string | null>(null)

  const connected = isSupabaseConfigured()

  const handleSave = async () => {
    if (!url.trim() || !key.trim()) {
      saveSupabaseConfig('', '')
      setStatus('idle')
      window.location.reload()
      return
    }

    setTesting(true)
    setStatus('idle')
    setErrorMsg('')

    try {
      saveSupabaseConfig(url.trim(), key.trim())
      const { error } = await supabase.from('properties').select('id').limit(1)

      if (error) {
        if (error.message.includes('does not exist')) {
          setStatus('error')
          setErrorMsg('Connected, but tables not found. Run the SQL migration in your Supabase SQL Editor (see supabase/migrations/001_initial_schema.sql).')
          return
        }
        throw error
      }

      setStatus('success')
      setTimeout(() => window.location.reload(), 1500)
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Failed to connect. Check your URL and key.')
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

  const handleSaveProfile = () => {
    saveBusinessProfile(profile)
    setProfileSaved(true)
    setTimeout(() => setProfileSaved(false), 2000)
  }

  const handleExportData = async () => {
    setExportStatus('Exporting...')
    try {
      const [properties, storageUnits, items, payments, expenses] = await Promise.all([
        getCachedData('properties'),
        getCachedData('storage_units'),
        getCachedData('items'),
        getCachedData('staging_payments'),
        getCachedData('property_expenses'),
      ])

      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        businessProfile: getBusinessProfile(),
        data: { properties, storageUnits, items, payments, expenses },
      }

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
      const downloadUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = downloadUrl
      a.download = `staging-inventory-backup-${new Date().toISOString().split('T')[0]}.json`
      a.click()
      URL.revokeObjectURL(downloadUrl)
      setExportStatus('Exported!')
      setTimeout(() => setExportStatus(null), 2000)
    } catch {
      setExportStatus('Export failed')
      setTimeout(() => setExportStatus(null), 3000)
    }
  }

  const handleImportData = async (file: File) => {
    setExportStatus('Importing...')
    try {
      const text = await file.text()
      const importData = JSON.parse(text)

      if (!importData.version || !importData.data) {
        throw new Error('Invalid backup file format')
      }

      const { properties, storageUnits, items, payments, expenses } = importData.data

      if (properties) await cacheData('properties', properties)
      if (storageUnits) await cacheData('storage_units', storageUnits)
      if (items) await cacheData('items', items)
      if (payments) await cacheData('staging_payments', payments)
      if (expenses) await cacheData('property_expenses', expenses)

      if (importData.businessProfile) {
        saveBusinessProfile(importData.businessProfile)
        setProfile(importData.businessProfile)
      }

      setExportStatus('Imported! Reloading...')
      setTimeout(() => window.location.reload(), 1500)
    } catch {
      setExportStatus('Import failed — invalid file')
      setTimeout(() => setExportStatus(null), 3000)
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <SettingsIcon size={24} />
          Settings
        </h1>
        <p className="text-slate-500 text-sm mt-1">Configure your staging business and sync settings</p>
      </div>

      {/* Business Profile */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Building2 size={16} />
          Business Profile
        </h2>
        <p className="text-xs text-slate-500">
          Used for tax reports and exported documents.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-slate-700 mb-1">Business Name</label>
            <input
              value={profile.businessName}
              onChange={(e) => setProfile({ ...profile, businessName: e.target.value })}
              placeholder="e.g. Elegant Staging Co."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Owner Name</label>
            <input
              value={profile.ownerName}
              onChange={(e) => setProfile({ ...profile, ownerName: e.target.value })}
              placeholder="e.g. Jane Smith"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Tax ID / EIN</label>
            <input
              value={profile.taxId}
              onChange={(e) => setProfile({ ...profile, taxId: e.target.value })}
              placeholder="e.g. 12-3456789"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
            <input
              value={profile.phone}
              onChange={(e) => setProfile({ ...profile, phone: e.target.value })}
              placeholder="e.g. (555) 123-4567"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
            <input
              type="email"
              value={profile.email}
              onChange={(e) => setProfile({ ...profile, email: e.target.value })}
              placeholder="e.g. jane@staging.com"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Fiscal Year End</label>
            <select
              value={profile.fiscalYearEnd}
              onChange={(e) => setProfile({ ...profile, fiscalYearEnd: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="12-31">December 31 (Calendar Year)</option>
              <option value="03-31">March 31</option>
              <option value="06-30">June 30</option>
              <option value="09-30">September 30</option>
            </select>
          </div>
        </div>

        {profileSaved && (
          <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 rounded-lg p-3">
            <Check size={16} />
            Business profile saved!
          </div>
        )}

        <button
          onClick={handleSaveProfile}
          className="w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 flex items-center justify-center gap-2"
        >
          <Building2 size={16} />
          Save Profile
        </button>
      </div>

      {/* Team & Account */}
      {!isLocalMode && authProfile && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <Users size={16} />
            Team & Account
          </h2>
          <p className="text-xs text-slate-500">
            Share your invite code with Annie or anyone else so they can sign up and join your workspace.
          </p>

          {/* Display name */}
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-500 mb-1">Display Name</label>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={async () => {
                await updateProfile({ display_name: editName })
                setNameSaved(true)
                setTimeout(() => setNameSaved(false), 2000)
              }}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
            >
              {nameSaved ? 'Saved!' : 'Update'}
            </button>
          </div>

          {/* Team info */}
          {team && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
              <div>
                <p className="text-xs text-blue-500 font-medium uppercase tracking-wide">Your Team</p>
                <p className="text-sm font-semibold text-blue-900">{team.name}</p>
              </div>
              <div>
                <p className="text-xs text-blue-500 font-medium uppercase tracking-wide mb-1">Invite Code</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-white border border-blue-200 rounded-lg text-sm font-mono text-blue-800 tracking-widest">
                    {team.invite_code}
                  </code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(team.invite_code)
                      setCodeCopied(true)
                      setTimeout(() => setCodeCopied(false), 2000)
                    }}
                    className="px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 flex items-center gap-1.5"
                  >
                    <Copy size={14} />
                    {codeCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
              <p className="text-xs text-blue-500">
                Anyone with this code can sign up and join your team to share inventory, properties, and deals.
              </p>
            </div>
          )}

          {/* Join a different team */}
          <div className="border-t border-slate-100 pt-4">
            <p className="text-xs font-medium text-slate-500 mb-2 flex items-center gap-1.5">
              <UserPlus size={12} />
              Join Another Team
            </p>
            <div className="flex items-end gap-2">
              <input
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Paste invite code..."
                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={async () => {
                  setJoinError('')
                  setJoinSuccess('')
                  const { error: err } = await joinTeam(inviteCode)
                  if (err) {
                    setJoinError(err)
                  } else {
                    setJoinSuccess('Joined! Reloading...')
                    setTimeout(() => window.location.reload(), 1500)
                  }
                }}
                disabled={!inviteCode.trim()}
                className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                Join
              </button>
            </div>
            {joinError && <p className="text-xs text-red-600 mt-1">{joinError}</p>}
            {joinSuccess && <p className="text-xs text-green-600 mt-1">{joinSuccess}</p>}
          </div>
        </div>
      )}

      {/* Data Management */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Download size={16} />
          Data Backup & Restore
        </h2>
        <p className="text-xs text-slate-500">
          Export all your data as a JSON backup file, or restore from a previous backup.
        </p>

        {exportStatus && (
          <div className="flex items-center gap-2 text-sm text-blue-600 bg-blue-50 rounded-lg p-3">
            <Check size={16} />
            {exportStatus}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleExportData}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-green-600 text-white text-sm rounded-lg font-medium hover:bg-green-700"
          >
            <Download size={16} />
            Export Backup
          </button>
          <label className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-amber-600 text-white text-sm rounded-lg font-medium hover:bg-amber-700 cursor-pointer">
            <Upload size={16} />
            Import Backup
            <input
              type="file"
              accept=".json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleImportData(file)
                e.target.value = ''
              }}
            />
          </label>
        </div>
      </div>

      {/* Google Integration */}
      <div className={`rounded-xl border p-4 flex items-center gap-3 ${
        googleConnected
          ? 'bg-blue-50 border-blue-200'
          : 'bg-slate-50 border-slate-200'
      }`}>
        {googleConnected ? (
          <>
            <div className="flex items-center gap-2">
              <FileSpreadsheet size={20} className="text-blue-600" />
              <div>
                <p className="text-sm font-medium text-blue-800">Google Connected</p>
                <p className="text-xs text-blue-600">{googleEmail || 'Sheets, Drive & Gmail enabled'}</p>
              </div>
            </div>
          </>
        ) : (
          <>
            <FileSpreadsheet size={20} className="text-slate-400" />
            <div>
              <p className="text-sm font-medium text-slate-700">Google Integration</p>
              <p className="text-xs text-slate-500">Connect to export to Sheets, backup to Drive, and email reports</p>
            </div>
          </>
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <FileSpreadsheet size={16} />
          Google Integration
        </h2>
        <div className="text-sm text-slate-600 space-y-2">
          <p>Connect Google to enable these features:</p>
          <ul className="text-xs text-slate-500 space-y-1.5 ml-1">
            <li className="flex items-center gap-2">
              <FileSpreadsheet size={12} className="text-green-600" />
              <span><strong>Google Sheets</strong> — Export inventory, properties & financials to a spreadsheet</span>
            </li>
            <li className="flex items-center gap-2">
              <HardDrive size={12} className="text-blue-600" />
              <span><strong>Google Drive</strong> — Back up item & property photos to your Drive</span>
            </li>
            <li className="flex items-center gap-2">
              <Mail size={12} className="text-red-500" />
              <span><strong>Gmail</strong> — Email inventory reports and property summaries</span>
            </li>
          </ul>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Google OAuth Client ID</label>
          <input
            value={googleClientId}
            onChange={(e) => { setGoogleClientId(e.target.value); setGoogleSaved(false) }}
            placeholder="xxxxxxxxxxxx.apps.googleusercontent.com"
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-xs"
          />
          <p className="text-xs text-slate-400 mt-1">
            Create at <strong>console.cloud.google.com</strong> &gt; APIs &amp; Services &gt; Credentials &gt; OAuth 2.0 Client ID.
            Enable Sheets, Drive, and Gmail APIs.
          </p>
        </div>

        {googleSaved && (
          <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 rounded-lg p-3">
            <Check size={16} />
            Client ID saved!
          </div>
        )}

        {googleError && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg p-3">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{googleError}</span>
          </div>
        )}

        <div className="flex gap-3">
          {!googleConnected ? (
            <>
              <button
                onClick={() => {
                  saveGoogleClientId(googleClientId.trim())
                  setGoogleSaved(true)
                  setTimeout(() => setGoogleSaved(false), 2000)
                }}
                disabled={!googleClientId.trim()}
                className="px-4 py-2.5 border border-slate-200 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                Save Client ID
              </button>
              <button
                onClick={handleGoogleConnect}
                disabled={googleConnecting || !isGoogleClientIdSet()}
                className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {googleConnecting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <FileSpreadsheet size={16} />
                    Sign in with Google
                  </>
                )}
              </button>
            </>
          ) : (
            <>
              <div className="flex-1 flex items-center gap-2 text-sm text-blue-700 bg-blue-50 rounded-lg px-3 py-2.5">
                <Check size={16} />
                Connected as {googleEmail}
              </div>
              <button
                onClick={handleGoogleDisconnect}
                className="flex items-center gap-1.5 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50"
              >
                <LogOut size={14} />
                Disconnect
              </button>
            </>
          )}
        </div>
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

      {/* AI Item Identification */}
      <div className={`rounded-xl border p-4 flex items-center gap-3 ${
        isAIConfigured()
          ? 'bg-purple-50 border-purple-200'
          : 'bg-slate-50 border-slate-200'
      }`}>
        {isAIConfigured() ? (
          <>
            <Eye size={20} className="text-purple-600" />
            <div>
              <p className="text-sm font-medium text-purple-800">AI Identification Active</p>
              <p className="text-xs text-purple-600">Take photos to auto-identify and categorize items</p>
            </div>
          </>
        ) : (
          <>
            <Brain size={20} className="text-slate-400" />
            <div>
              <p className="text-sm font-medium text-slate-700">AI Item Identification</p>
              <p className="text-xs text-slate-500">Add an Anthropic API key to identify items from photos</p>
            </div>
          </>
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Brain size={16} />
          AI Configuration
        </h2>
        <div className="text-sm text-slate-600 space-y-2">
          <p>
            Connect your Anthropic API key to enable AI-powered item identification.
            Take a photo of items and AI will automatically identify, name, categorize, and estimate the value of each item.
          </p>
          <p className="text-xs text-slate-400">
            Your key is stored locally on this device only. Get a key at <strong>console.anthropic.com</strong>
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Anthropic API Key</label>
          <input
            type="password"
            value={aiKey}
            onChange={(e) => { setAiKey(e.target.value); setAiSaved(false) }}
            placeholder="sk-ant-..."
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 font-mono text-xs"
          />
        </div>

        {aiSaved && (
          <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 rounded-lg p-3">
            <Check size={16} />
            AI key saved! You can now use AI identification on the Scan Receipt page.
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => {
              saveAnthropicKey(aiKey.trim())
              setAiSaved(true)
              setTimeout(() => setAiSaved(false), 3000)
            }}
            disabled={!aiKey.trim()}
            className="flex-1 py-2.5 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <Brain size={16} />
            Save AI Key
          </button>
          {isAIConfigured() && (
            <button
              onClick={() => {
                saveAnthropicKey('')
                setAiKey('')
                setAiSaved(false)
              }}
              className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
