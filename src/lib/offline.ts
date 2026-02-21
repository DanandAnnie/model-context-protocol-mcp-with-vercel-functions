import { openDB, type IDBPDatabase } from 'idb'
import type { Property, StorageUnit, Item, ItemImage, StagingHistory, StagingPayment } from './database.types'

const DB_NAME = 'staging-inventory'
const DB_VERSION = 2

interface OfflineDB {
  properties: { key: string; value: Property }
  storage_units: { key: string; value: StorageUnit }
  items: { key: string; value: Item }
  item_images: { key: string; value: ItemImage }
  staging_history: { key: string; value: StagingHistory }
  staging_payments: { key: string; value: StagingPayment }
  pending_sync: {
    key: string
    value: {
      id: string
      table: string
      action: 'insert' | 'update' | 'delete'
      data: Record<string, unknown>
      created_at: string
    }
  }
}

let dbPromise: Promise<IDBPDatabase<OfflineDB>> | null = null

export function getDB(): Promise<IDBPDatabase<OfflineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<OfflineDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('properties')) {
          db.createObjectStore('properties', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('storage_units')) {
          db.createObjectStore('storage_units', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('items')) {
          db.createObjectStore('items', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('item_images')) {
          db.createObjectStore('item_images', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('staging_history')) {
          db.createObjectStore('staging_history', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('staging_payments')) {
          db.createObjectStore('staging_payments', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('pending_sync')) {
          db.createObjectStore('pending_sync', { keyPath: 'id' })
        }
      },
    })
  }
  return dbPromise
}

export async function cacheData<T extends keyof OfflineDB>(
  store: T,
  data: OfflineDB[T]['value'][],
) {
  const db = await getDB()
  const tx = db.transaction(store, 'readwrite')
  // Do NOT await clear separately — it auto-commits the transaction.
  // Batch clear + puts + done in a single Promise.all.
  await Promise.all([
    tx.store.clear(),
    ...data.map((item) => tx.store.put(item)),
    tx.done,
  ])
}

export async function getCachedData<T extends keyof OfflineDB>(
  store: T,
): Promise<OfflineDB[T]['value'][]> {
  const db = await getDB()
  return db.getAll(store)
}

export async function addPendingSync(
  table: string,
  action: 'insert' | 'update' | 'delete',
  data: Record<string, unknown>,
) {
  const db = await getDB()
  await db.put('pending_sync', {
    id: crypto.randomUUID(),
    table,
    action,
    data,
    created_at: new Date().toISOString(),
  })
}

export async function getPendingSyncs() {
  const db = await getDB()
  return db.getAll('pending_sync')
}

export async function clearPendingSync(id: string) {
  const db = await getDB()
  await db.delete('pending_sync', id)
}

const INIT_KEY = 'staging-inventory-initialized'

export function isStoreInitialized(store: string): boolean {
  return localStorage.getItem(`${INIT_KEY}:${store}`) === 'true'
}

export function markStoreInitialized(store: string): void {
  localStorage.setItem(`${INIT_KEY}:${store}`, 'true')
}
