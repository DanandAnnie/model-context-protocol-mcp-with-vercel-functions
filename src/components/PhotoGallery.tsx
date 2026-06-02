import { useState } from 'react'
import { ChevronLeft, ChevronRight, Trash2, Star, Plus } from 'lucide-react'

interface PhotoGalleryProps {
  photos: string[]
  onAddPhoto?: (file: File) => void
  onDeletePhoto?: (index: number) => void
  onSetPrimary?: (index: number) => void
  uploading?: boolean
  label?: string
}

export default function PhotoGallery({
  photos,
  onAddPhoto,
  onDeletePhoto,
  onSetPrimary,
  uploading = false,
  label = 'Photos',
}: PhotoGalleryProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const fileInputRef = { current: null as HTMLInputElement | null }

  if (photos.length === 0 && !onAddPhoto) return null

  const safeIndex = Math.min(activeIndex, Math.max(0, photos.length - 1))

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-700">{label}</label>

      {photos.length > 0 && (
        <div className="relative">
          {/* Main image */}
          <div className="aspect-video bg-slate-100 rounded-xl overflow-hidden relative">
            <img
              src={photos[safeIndex]}
              alt={`Photo ${safeIndex + 1}`}
              className="w-full h-full object-contain"
            />

            {/* Navigation arrows */}
            {photos.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => setActiveIndex((i) => (i - 1 + photos.length) % photos.length)}
                  className="absolute left-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/40 text-white rounded-full hover:bg-black/60"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setActiveIndex((i) => (i + 1) % photos.length)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-black/40 text-white rounded-full hover:bg-black/60"
                >
                  <ChevronRight size={16} />
                </button>
              </>
            )}

            {/* Top actions */}
            <div className="absolute top-2 right-2 flex gap-1">
              {onSetPrimary && safeIndex !== 0 && (
                <button
                  type="button"
                  onClick={() => onSetPrimary(safeIndex)}
                  className="flex items-center gap-1 px-2 py-1 bg-blue-600/80 text-white text-xs rounded hover:bg-blue-600"
                >
                  <Star size={10} />
                  Set Primary
                </button>
              )}
              {onDeletePhoto && (
                <button
                  type="button"
                  onClick={() => {
                    onDeletePhoto(safeIndex)
                    setActiveIndex(0)
                  }}
                  className="p-1 bg-red-600/80 text-white rounded hover:bg-red-600"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>

            {/* Counter */}
            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2 py-0.5 bg-black/50 text-white text-xs rounded-full">
              {safeIndex + 1} / {photos.length}
              {safeIndex === 0 && ' (Primary)'}
            </div>
          </div>

          {/* Thumbnail strip */}
          {photos.length > 1 && (
            <div className="flex gap-1.5 mt-2 overflow-x-auto pb-1">
              {photos.map((url, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveIndex(i)}
                  className={`flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden border-2 transition-colors ${
                    i === safeIndex ? 'border-blue-500' : 'border-transparent hover:border-slate-300'
                  }`}
                >
                  <img src={url} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add more photos */}
      {onAddPhoto && (
        <div className="flex items-center gap-2">
          <label className="flex items-center justify-center gap-2 px-3 py-2 border-2 border-dashed border-slate-300 rounded-lg text-sm text-slate-500 hover:border-blue-400 hover:text-blue-600 cursor-pointer transition-colors flex-1">
            {uploading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
                Uploading...
              </>
            ) : (
              <>
                <Plus size={16} />
                Add Photo{photos.length === 0 ? '' : ' to Gallery'}
              </>
            )}
            <input
              ref={(el) => { fileInputRef.current = el }}
              type="file"
              accept="image/*"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onAddPhoto(file)
                e.target.value = ''
              }}
            />
          </label>
        </div>
      )}
    </div>
  )
}
