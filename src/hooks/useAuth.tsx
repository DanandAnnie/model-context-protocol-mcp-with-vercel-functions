import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type { User, Session } from '@supabase/supabase-js'

interface Profile {
  id: string
  email: string
  display_name: string
  team_id: string
  role: string
  created_at: string
}

interface Team {
  id: string
  name: string
  invite_code: string
  created_at: string
}

interface AuthState {
  user: User | null
  profile: Profile | null
  team: Team | null
  session: Session | null
  loading: boolean
  isAuthenticated: boolean
  /** True when Supabase isn't configured — app runs in local-only mode */
  isLocalMode: boolean
  signUp: (email: string, password: string, displayName?: string) => Promise<{ error: string | null }>
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  joinTeam: (inviteCode: string) => Promise<{ error: string | null }>
  updateProfile: (updates: Partial<Pick<Profile, 'display_name'>>) => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [team, setTeam] = useState<Team | null>(null)
  const [loading, setLoading] = useState(true)

  const isLocalMode = !isSupabaseConfigured()

  const fetchProfile = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()
    if (data) {
      setProfile(data)
      // Fetch team
      if (data.team_id) {
        const { data: teamData } = await supabase
          .from('teams')
          .select('*')
          .eq('id', data.team_id)
          .single()
        if (teamData) setTeam(teamData)
      }
    }
  }, [])

  useEffect(() => {
    if (isLocalMode) {
      setLoading(false)
      return
    }

    // Get initial session
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s)
      setUser(s?.user ?? null)
      if (s?.user) {
        fetchProfile(s.user.id).finally(() => setLoading(false))
      } else {
        setLoading(false)
      }
    })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      setUser(s?.user ?? null)
      if (s?.user) {
        fetchProfile(s.user.id)
      } else {
        setProfile(null)
        setTeam(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [isLocalMode, fetchProfile])

  const signUp = async (email: string, password: string, displayName?: string) => {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName || email.split('@')[0] },
      },
    })
    if (error) return { error: error.message }
    return { error: null }
  }

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { error: error.message }
    return { error: null }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setSession(null)
    setProfile(null)
    setTeam(null)
  }

  const joinTeam = async (inviteCode: string) => {
    if (!user) return { error: 'Not logged in' }

    // Find team by invite code
    const { data: targetTeam, error: findErr } = await supabase
      .from('teams')
      .select('id, name')
      .eq('invite_code', inviteCode.trim().toLowerCase())
      .single()

    if (findErr || !targetTeam) return { error: 'Invalid invite code' }

    // Update profile to join that team
    const { error: updateErr } = await supabase
      .from('profiles')
      .update({ team_id: targetTeam.id, role: 'member' })
      .eq('id', user.id)

    if (updateErr) return { error: updateErr.message }

    await fetchProfile(user.id)
    return { error: null }
  }

  const updateProfile = async (updates: Partial<Pick<Profile, 'display_name'>>) => {
    if (!user) return
    await supabase.from('profiles').update(updates).eq('id', user.id)
    await fetchProfile(user.id)
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        team,
        session,
        loading,
        isAuthenticated: isLocalMode || !!user,
        isLocalMode,
        signUp,
        signIn,
        signOut,
        joinTeam,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
