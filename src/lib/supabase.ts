import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const STORAGE_KEY_URL = 'staging-inv-supabase-url'
const STORAGE_KEY_KEY = 'staging-inv-supabase-key'

function getConfig() {
  // Runtime config from localStorage takes priority over build-time env vars
  const runtimeUrl = localStorage.getItem(STORAGE_KEY_URL)
  const runtimeKey = localStorage.getItem(STORAGE_KEY_KEY)

  const url = runtimeUrl || import.meta.env.VITE_SUPABASE_URL || ''
  const key = runtimeKey || import.meta.env.VITE_SUPABASE_ANON_KEY || ''

  return { url, key }
}

let _client: SupabaseClient | null = null
let _configuredUrl = ''
let _configuredKey = ''

function getClient(): SupabaseClient {
  const { url, key } = getConfig()

  // Recreate client if config changed
  if (!_client || url !== _configuredUrl || key !== _configuredKey) {
    _configuredUrl = url
    _configuredKey = key
    _client = createClient(
      url || 'https://placeholder.supabase.co',
      key || 'placeholder-key',
    )
  }

  return _client
}

// Proxy object so all existing code works without changes
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getClient()
    const value = (client as unknown as Record<string | symbol, unknown>)[prop]
    if (typeof value === 'function') {
      return value.bind(client)
    }
    return value
  },
})

export function isSupabaseConfigured(): boolean {
  const { url, key } = getConfig()
  return url !== '' && key !== ''
}

export function saveSupabaseConfig(url: string, key: string) {
  if (url) {
    localStorage.setItem(STORAGE_KEY_URL, url)
  } else {
    localStorage.removeItem(STORAGE_KEY_URL)
  }
  if (key) {
    localStorage.setItem(STORAGE_KEY_KEY, key)
  } else {
    localStorage.removeItem(STORAGE_KEY_KEY)
  }
  // Force client recreation on next access
  _client = null
}

export function getSupabaseConfig() {
  return {
    url: localStorage.getItem(STORAGE_KEY_URL) || '',
    key: localStorage.getItem(STORAGE_KEY_KEY) || '',
  }
}
