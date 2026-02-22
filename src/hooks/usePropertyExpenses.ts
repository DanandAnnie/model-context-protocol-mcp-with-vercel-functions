import { useState, useEffect, useCallback } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { cacheData, getCachedData } from '../lib/offline'
import type { PropertyExpense, PropertyExpenseInsert } from '../lib/database.types'

export function usePropertyExpenses(propertyId?: string) {
  const [expenses, setExpenses] = useState<PropertyExpense[]>([])
  const [loading, setLoading] = useState(true)

  const fetchExpenses = useCallback(async () => {
    setLoading(true)

    if (!isSupabaseConfigured()) {
      const cached = await getCachedData('property_expenses')
      const filtered = propertyId
        ? cached.filter((e) => e.property_id === propertyId)
        : cached
      setExpenses(filtered)
      setLoading(false)
      return
    }

    try {
      let query = supabase
        .from('property_expenses')
        .select('*')
        .order('expense_date', { ascending: false })
      if (propertyId) query = query.eq('property_id', propertyId)

      const { data, error } = await query
      if (error) throw error
      setExpenses(data || [])
      if (data) {
        const allCached = await getCachedData('property_expenses')
        const otherExpenses = propertyId
          ? allCached.filter((e) => e.property_id !== propertyId)
          : []
        await cacheData('property_expenses', [...otherExpenses, ...data])
      }
    } catch {
      const cached = await getCachedData('property_expenses')
      const filtered = propertyId
        ? cached.filter((e) => e.property_id === propertyId)
        : cached
      setExpenses(filtered)
    } finally {
      setLoading(false)
    }
  }, [propertyId])

  useEffect(() => { fetchExpenses() }, [fetchExpenses])

  const addExpense = async (expense: PropertyExpenseInsert) => {
    const newExpense: PropertyExpense = {
      ...expense,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('property_expenses')
      await cacheData('property_expenses', [...allCached, newExpense])
      setExpenses((prev) => [newExpense, ...prev])
      return newExpense
    }

    const { data, error } = await supabase
      .from('property_expenses')
      .insert(expense)
      .select()
      .single()

    if (error) throw error
    await fetchExpenses()
    return data
  }

  const updateExpense = async (id: string, updates: Partial<PropertyExpenseInsert>) => {
    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('property_expenses')
      const updated = allCached.map((e) =>
        e.id === id ? { ...e, ...updates, updated_at: new Date().toISOString() } : e,
      )
      await cacheData('property_expenses', updated)
      setExpenses((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, ...updates, updated_at: new Date().toISOString() } : e,
        ),
      )
      return
    }

    const { error } = await supabase
      .from('property_expenses')
      .update(updates)
      .eq('id', id)

    if (error) throw error
    await fetchExpenses()
  }

  const deleteExpense = async (id: string) => {
    if (!isSupabaseConfigured()) {
      const allCached = await getCachedData('property_expenses')
      await cacheData('property_expenses', allCached.filter((e) => e.id !== id))
      setExpenses((prev) => prev.filter((e) => e.id !== id))
      return
    }

    const { error } = await supabase
      .from('property_expenses')
      .delete()
      .eq('id', id)

    if (error) throw error
    await fetchExpenses()
  }

  return { expenses, loading, addExpense, updateExpense, deleteExpense, refetch: fetchExpenses }
}
