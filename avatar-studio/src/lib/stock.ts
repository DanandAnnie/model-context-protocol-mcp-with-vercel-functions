import type { Avatar, Voice } from "./types";

/**
 * Built-in illustrated avatars so the product is fully browsable with no API
 * keys. Each portrait is a generated SVG (no third-party image hosting).
 */
const PALETTE: Array<[string, string]> = [
  ["#6366f1", "#a855f7"],
  ["#0ea5e9", "#22d3ee"],
  ["#f97316", "#f43f5e"],
  ["#10b981", "#84cc16"],
  ["#ec4899", "#f59e0b"],
  ["#8b5cf6", "#3b82f6"],
  ["#14b8a6", "#6366f1"],
  ["#ef4444", "#f97316"],
];

export function portraitSvg(name: string, index: number): string {
  const [a, b] = PALETTE[index % PALETTE.length];
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 400">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect width="320" height="400" fill="url(#g)"/>
  <circle cx="160" cy="150" r="64" fill="rgba(255,255,255,0.92)"/>
  <path d="M60 400 C60 300 100 260 160 260 C220 260 260 300 260 400 Z" fill="rgba(255,255,255,0.92)"/>
  <text x="160" y="168" font-family="Inter, system-ui, sans-serif" font-size="48" font-weight="700" text-anchor="middle" fill="${a}">${initials}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const STOCK_NAMES: Array<{ name: string; gender: Avatar["gender"]; tags: string[] }> = [
  { name: "Ava Chen", gender: "female", tags: ["business", "studio"] },
  { name: "Marcus Hill", gender: "male", tags: ["business", "casual"] },
  { name: "Sofia Reyes", gender: "female", tags: ["marketing", "upbeat"] },
  { name: "Daniel Okafor", gender: "male", tags: ["training", "formal"] },
  { name: "Priya Nair", gender: "female", tags: ["education", "friendly"] },
  { name: "Lucas Meyer", gender: "male", tags: ["tech", "casual"] },
  { name: "Hana Sato", gender: "female", tags: ["product", "studio"] },
  { name: "Omar Haddad", gender: "male", tags: ["sales", "energetic"] },
];

/** Public-domain sample clip that stands in for a presenter's preview video in demo mode. */
export const SAMPLE_PREVIEW_VIDEO = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4";

export const STOCK_AVATARS: Avatar[] = STOCK_NAMES.map((p, i) => ({
  id: `stock_${i + 1}`,
  name: p.name,
  imageUrl: portraitSvg(p.name, i),
  // Like a provider's library, some presenters come with a short preview clip the tiles play on hover.
  ...(i < 2 ? { previewVideoUrl: SAMPLE_PREVIEW_VIDEO } : {}),
  source: "stock",
  provider: "mock",
  gender: p.gender,
  tags: p.tags,
}));

export const STOCK_VOICES: Voice[] = [
  { id: "stock_voice_1", name: "Emma", provider: "mock", language: "en-US", gender: "female", tags: ["warm", "narration"] },
  { id: "stock_voice_2", name: "James", provider: "mock", language: "en-US", gender: "male", tags: ["confident", "sales"] },
  { id: "stock_voice_3", name: "Olivia", provider: "mock", language: "en-GB", gender: "female", tags: ["calm", "training"] },
  { id: "stock_voice_4", name: "Mateo", provider: "mock", language: "es-ES", gender: "male", tags: ["friendly"] },
  { id: "stock_voice_5", name: "Lea", provider: "mock", language: "fr-FR", gender: "female", tags: ["bright"] },
  { id: "stock_voice_6", name: "Kenji", provider: "mock", language: "ja-JP", gender: "male", tags: ["measured"] },
];

export const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: "English", label: "English" },
  { code: "Spanish", label: "Spanish" },
  { code: "French", label: "French" },
  { code: "German", label: "German" },
  { code: "Portuguese", label: "Portuguese" },
  { code: "Italian", label: "Italian" },
  { code: "Japanese", label: "Japanese" },
  { code: "Korean", label: "Korean" },
  { code: "Chinese", label: "Chinese (Mandarin)" },
  { code: "Hindi", label: "Hindi" },
  { code: "Arabic", label: "Arabic" },
  { code: "Dutch", label: "Dutch" },
];
