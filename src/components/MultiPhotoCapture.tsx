import { useState, useRef, useCallback } from 'react'
import { Camera, Upload, X, Image as ImageIcon, Plus } from 'lucide-react'

interface MultiPhotoCaptureProps {
  onPhotosChange: (files: File[]) => void
  existingPhotos?: string[]
  onRemoveExisting?: (index: number) => void
  label?: string
  maxPhotos?: number
}

export default function MultiPhotoCapture({
  onPhotosChange,
  existingPhotos = [],
  onRemoveExisting,
  label = 'Photos',
  maxPhotos = 20,
}: MultiPhotoCaptureProps) {
  const [newPhotos, setNewPhotos] = useState<{ file: File; preview: string }[]>([])
  const [showCamera, setShowCamera] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
  const totalPhotos = existingPhotos.length + newPhotos.length
  const canAdd = totalPhotos < maxPhotos

  const addFiles = useCallback((files: File[]) => {
    const remaining = maxPhotos - existingPhotos.length - newPhotos.length
    const toAdd = files.slice(0, remaining)
    const withPreviews = toAdd.map((file) => ({
      file,
      preview: URL.createObjectURL(file),
    }))
    const updated = [...newPhotos, ...withPreviews]
    setNewPhotos(updated)
    onPhotosChange(updated.map((p) => p.file))
  }, [newPhotos, existingPhotos.length, maxPhotos, onPhotosChange])

  const startCamera = useCallback(async () => {
    if (isMobile) {
      cameraInputRef.current?.click()
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
      setShowCamera(true)
    } catch {
      cameraInputRef.current?.click()
    }
  }, [isMobile])

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    setShowCamera(false)
  }, [])

  const capturePhoto = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.drawImage(video, 0, 0)
    canvas.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' })
        addFiles([file])
      }
    }, 'image/jpeg', 0.85)

    stopCamera()
  }, [addFiles, stopCamera])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) addFiles(files)
    e.target.value = ''
  }

  const removeNewPhoto = (index: number) => {
    const updated = newPhotos.filter((_, i) => i !== index)
    setNewPhotos(updated)
    onPhotosChange(updated.map((p) => p.file))
  }

  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-2">{label}</label>
      <canvas ref={canvasRef} className="hidden" />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileSelect}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileSelect}
      />

      {showCamera && (
        <div className="relative rounded-xl overflow-hidden bg-black mb-3">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full aspect-video object-cover"
          />
          <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-4">
            <button
              type="button"
              onClick={capturePhoto}
              className="w-14 h-14 rounded-full bg-white shadow-lg flex items-center justify-center hover:scale-105 transition-transform"
            >
              <Camera size={24} className="text-slate-800" />
            </button>
            <button
              type="button"
              onClick={stopCamera}
              className="w-10 h-10 rounded-full bg-red-500 text-white flex items-center justify-center"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      {/* Photo grid */}
      {(existingPhotos.length > 0 || newPhotos.length > 0) && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 mb-3">
          {/* Existing photos */}
          {existingPhotos.map((url, i) => (
            <div key={`existing-${i}`} className="relative aspect-square rounded-lg overflow-hidden group">
              <img src={url} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" />
              {i === 0 && (
                <span className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-blue-600 text-white text-[10px] font-medium rounded">
                  Primary
                </span>
              )}
              {onRemoveExisting && (
                <button
                  type="button"
                  onClick={() => onRemoveExisting(i)}
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
          {/* New photos */}
          {newPhotos.map((p, i) => (
            <div key={`new-${i}`} className="relative aspect-square rounded-lg overflow-hidden group">
              <img src={p.preview} alt={`New photo ${i + 1}`} className="w-full h-full object-cover" />
              {existingPhotos.length === 0 && i === 0 && (
                <span className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-blue-600 text-white text-[10px] font-medium rounded">
                  Primary
                </span>
              )}
              <button
                type="button"
                onClick={() => removeNewPhoto(i)}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {/* Add more button */}
          {canAdd && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="aspect-square rounded-lg border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-1 text-slate-400 hover:border-blue-400 hover:text-blue-500 transition-colors"
            >
              <Plus size={20} />
              <span className="text-[10px]">Add</span>
            </button>
          )}
        </div>
      )}

      {/* Empty state */}
      {existingPhotos.length === 0 && newPhotos.length === 0 && !showCamera && (
        <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center">
          <ImageIcon size={40} className="mx-auto text-slate-300 mb-3" />
          <p className="text-sm text-slate-500 mb-1">Add photos</p>
          <p className="text-xs text-slate-400 mb-4">Take or upload multiple photos</p>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              onClick={startCamera}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
            >
              <Camera size={16} />
              Take Photo
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2 bg-[#1a1a32] text-slate-700 text-sm rounded-lg hover:bg-[#252545]"
            >
              <Upload size={16} />
              Upload
            </button>
          </div>
        </div>
      )}

      {/* Action buttons when photos exist */}
      {(existingPhotos.length > 0 || newPhotos.length > 0) && canAdd && !showCamera && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={startCamera}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700"
          >
            <Camera size={14} />
            Take Photo
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a32] text-slate-700 text-xs font-medium rounded-lg hover:bg-[#252545]"
          >
            <Upload size={14} />
            Upload
          </button>
          <span className="text-xs text-slate-400 self-center ml-auto">
            {totalPhotos}/{maxPhotos} photos
          </span>
        </div>
      )}
    </div>
  )
}
