"use client";
// Browser-side audio conversion for audio scenes. Recordings (WebM/Opus in Chrome, MP4 in Safari)
// and uploads (MP3, M4A, WAV, ...) are decoded by the browser and re-encoded as mono 16-bit PCM
// WAV, which every renderer accepts and whose length the server can read from the header.

/** Sample rate of converted clips: clear speech, and a five-minute clip (9.6 MB) stays under the 10 MB cap. */
export const CLIP_SAMPLE_RATE = 16_000;

/** Encodes mono samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const out = new Uint8Array(44 + dataSize);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  tag(36, "data");
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Decodes any audio the browser can play and returns it as a WAV data URL with its length in seconds. */
export async function toWavDataUrl(blob: Blob): Promise<{ dataUrl: string; seconds: number }> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error("This browser cannot read that audio file; try MP3, WAV, or M4A");
  } finally {
    void ctx.close();
  }
  // Mix down to mono and resample in one offline render.
  const frames = Math.max(1, Math.ceil(decoded.duration * CLIP_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, CLIP_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const wav = encodeWav(rendered.getChannelData(0), CLIP_SAMPLE_RATE);
  let binary = "";
  for (let i = 0; i < wav.length; i += 0x8000) binary += String.fromCharCode(...wav.subarray(i, i + 0x8000));
  return { dataUrl: `data:audio/wav;base64,${btoa(binary)}`, seconds: rendered.duration };
}
