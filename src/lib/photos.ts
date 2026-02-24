/**
 * Local photo storage helpers.
 * Stores additional photos as base64 JSON arrays in localStorage,
 * keyed by entity type and ID.
 */

type EntityType = 'item' | 'property' | 'storage'

function storageKey(entityType: EntityType, entityId: string): string {
  return `photos_${entityType}_${entityId}`
}

export function getAdditionalPhotos(entityType: EntityType, entityId: string): string[] {
  try {
    const stored = localStorage.getItem(storageKey(entityType, entityId))
    if (stored) return JSON.parse(stored)
  } catch { /* empty */ }
  return []
}

export function saveAdditionalPhotos(entityType: EntityType, entityId: string, photos: string[]): void {
  localStorage.setItem(storageKey(entityType, entityId), JSON.stringify(photos))
}

export function addAdditionalPhoto(entityType: EntityType, entityId: string, base64: string): string[] {
  const photos = getAdditionalPhotos(entityType, entityId)
  photos.push(base64)
  saveAdditionalPhotos(entityType, entityId, photos)
  return photos
}

export function removeAdditionalPhoto(entityType: EntityType, entityId: string, index: number): string[] {
  const photos = getAdditionalPhotos(entityType, entityId)
  photos.splice(index, 1)
  saveAdditionalPhotos(entityType, entityId, photos)
  return photos
}

export function setAsPrimaryPhoto(
  entityType: EntityType,
  entityId: string,
  index: number,
): { newPrimary: string; additionalPhotos: string[] } | null {
  // index is in the combined array where 0 = primary photo_url
  // So index 1+ refers to additionalPhotos[index-1]
  const photos = getAdditionalPhotos(entityType, entityId)
  const additionalIndex = index - 1
  if (additionalIndex < 0 || additionalIndex >= photos.length) return null
  const newPrimary = photos[additionalIndex]
  photos.splice(additionalIndex, 1)
  saveAdditionalPhotos(entityType, entityId, photos)
  return { newPrimary, additionalPhotos: photos }
}

/**
 * Get all photos for an entity (primary + additional).
 * The primary photo_url is first in the array.
 */
export function getAllPhotos(entityType: EntityType, entityId: string, primaryPhotoUrl?: string): string[] {
  const photos: string[] = []
  if (primaryPhotoUrl) photos.push(primaryPhotoUrl)
  photos.push(...getAdditionalPhotos(entityType, entityId))
  return photos
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
