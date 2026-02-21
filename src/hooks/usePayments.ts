import { useState, useEffect, useCallback } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { cacheData, getCachedData } from '../lib/offline'
import type { StagingPayment, StagingPaymentInsert } from '../lib/database.types'

export function usePayments(propertyId?: string) {
  const [payments, setPayments] = useState<StagingPayment[]>([])
  const [loading, setLoading] = useState(true)

  const fetchPayments = useCallback(async () => {
    setLoading(true)

    if (!isSupabaseConfigured()) {
      const cached = await getCachedData('staging_payments')
      const filtered = propertyId
        ? cached.filter((p) => p.property_id === propertyId)
        : cached
      setPayments(filtered)
      setLoading(false)
      return
    }

    try {
      let query = supabase.from('staging_payments').select('*').order('payment_date', { ascending: false })
      if (propertyId) query = query.eq('property_id', propertyId)

      const { data, error } = await query
      if (error) throw error
      setPayments(data || [])
      if (data) {
        // Merge into cache (don't overwrite other properties' payments)
        const allCached = await getCachedData('staging_payments')
        const otherPayments = propertyId
          ? allCached.filter((p) => p.property_id !== propertyId)
          : []
        await cacheData('staging_payments', [...otherPayments, ...data])
      }
    } catch {
      const cached = await getCachedData('staging_payments')
      const filtered = propertyId
        ? cached.filter((p) => p.property_id === propertyId)
        : cached
      setPayments(filtered)
    } finally {
      setLoading(false)
    }
  }, [propertyId])

  useEffect(() => { fetchPayments() }, [fetchPayments])

  const addPayment = async (payment: StagingPaymentInsert) => {
    const newPayment: StagingPayment = {
      ...payment,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
    }

    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('staging_payments')
      await cacheData('staging_payments', [...allCached, newPayment])
      setPayments((prev) => [newPayment, ...prev])
      return newPayment
    }

    const { data, error } = await supabase
      .from('staging_payments')
      .insert(payment)
      .select()
      .single()

    if (error) throw error
    await fetchPayments()
    return data
  }

  const deletePayment = async (id: string) => {
    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('staging_payments')
      await cacheData('staging_payments', allCached.filter((p) => p.id !== id))
      setPayments((prev) => prev.filter((p) => p.id !== id))
      return
    }

    const { error } = await supabase.from('staging_payments').delete().eq('id', id)
    if (error) throw error
    await fetchPayments()
  }

  return { payments, loading, addPayment, deletePayment, refetch: fetchPayments }
}
