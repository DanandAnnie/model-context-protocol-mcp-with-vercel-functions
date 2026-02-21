import { useState, useRef, useCallback } from 'react'
import { Camera, Upload, X, Image as ImageIcon } from 'lucide-react'

interface PhotoCaptureProps {
  onCapture: (file: File) => void
  currentImage?: string | null
}

export default function PhotoCapture({ onCapture, currentImage }: PhotoCaptureProps) {
  const [preview, setPreview] = useState<string | null>(currentImage || null)
  const [showCamera, setShowCamera] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

  const startCamera = useCallback(async () => {
    // On mobile, use native camera input (more reliable than getUserMedia)
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
      // Fall back to native camera input if getUserMedia fails
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
        setPreview(URL.createObjectURL(blob))
        onCapture(file)
      }
    }, 'image/jpeg', 0.85)

    stopCamera()
  }, [onCapture, stopCamera])

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPreview(URL.createObjectURL(file))
    onCapture(file)
    // Reset so same file can be selected again
    e.target.value = ''
  }

  const clearImage = () => {
    setPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (cameraInputRef.current) cameraInputRef.current.value = ''
  }

  return (
    <div>
      <canvas ref={canvasRef} className="hidden" />
      {/* File picker input (gallery/files) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileSelect}
      />
      {/* Camera capture input (opens native camera on mobile) */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileSelect}
      />

      {showCamera ? (
        <div className="relative rounded-xl overflow-hidden bg-black">
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
      ) : preview ? (
        <div className="relative rounded-xl overflow-hidden">
          <img src={preview} alt="Captured" className="w-full aspect-video object-cover" />
          <button
            type="button"
            onClick={clearImage}
            className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center">
          <ImageIcon size={40} className="mx-auto text-slate-300 mb-3" />
          <p className="text-sm text-slate-500 mb-4">Add a photo of the item</p>
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
              className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 text-sm rounded-lg hover:bg-slate-200"
            >
              <Upload size={16} />
              Upload
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
