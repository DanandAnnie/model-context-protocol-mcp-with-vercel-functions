// Saving an uploaded audio file as one of the account's audio clips, in the browser: an MP3 the clips route takes as it is
// is kept as it is; anything else is converted to the 16 kHz mono WAV the editor saves for audio scenes.
import { toWavDataUrl } from "./wav-client";
import { MAX_CLIP_SECONDS } from "./types";

/** Largest file the clips route takes (3 MB, which fits one request once base64-encoded). */
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

/** An MP3's length from its metadata, or null when the browser cannot tell (it is then converted instead). */
function mp3Seconds(file: File): Promise<number | null> {
  const url = URL.createObjectURL(file);
  return new Promise<number | null>((resolve) => {
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    audio.onerror = () => resolve(null);
    audio.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

const asDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The file could not be read"));
    reader.readAsDataURL(file);
  });

/**
 * The clip to save for an uploaded file. An MP3 the server takes as it is (up to 3 MB and 90 seconds) is kept as it is,
 * as a clip can become a whole soundtrack; anything else is converted in the browser to the 16 kHz mono WAV the editor
 * saves for audio scenes. `what` names the audio and `longAdvice` says what to do with one too long, in the page's words.
 */
export async function clipBody(file: File, name: string, what = "the audio", longAdvice = "trim it"): Promise<{ name: string; audio: string; durationSec?: number }> {
  if (file.type === "audio/mpeg" && file.size <= MAX_UPLOAD_BYTES) {
    const seconds = await mp3Seconds(file);
    if (seconds !== null && seconds <= MAX_CLIP_SECONDS) return { name, audio: (await asDataUrl(file)).replace(/^data:[^;,]*/, "data:audio/mpeg"), durationSec: Math.max(0.1, Math.round(seconds * 10) / 10) };
    if (seconds !== null) throw new Error(`${what[0].toUpperCase()}${what.slice(1)} can be at most ${MAX_CLIP_SECONDS} seconds long; ${longAdvice}`);
  }
  try {
    const { dataUrl } = await toWavDataUrl(file);
    return { name, audio: dataUrl };
  } catch (err) {
    // The converter's advice is for scenes; the page's own replaces it.
    if (err instanceof Error && /at most \d+ seconds/.test(err.message)) throw new Error(`${what[0].toUpperCase()}${what.slice(1)} can be at most ${MAX_CLIP_SECONDS} seconds long; ${longAdvice}`);
    throw err;
  }
}

