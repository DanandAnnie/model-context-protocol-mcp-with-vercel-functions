// Browser-side helpers for calling the app's own API.
export class ApiError extends Error {
  /** `body` is the parsed error response, for routes that return a record alongside the error (e.g. a failed render). */
  constructor(message: string, public status: number, public issues?: unknown, public body?: Record<string, unknown>) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError((body.error as string) ?? `Request failed (${res.status})`, res.status, body.issues, body);
  }
  return body as T;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Rough spoken duration estimate: ~2.5 words per second at 1.0x. */
export function estimateSeconds(text: string, speed = 1): number {
  return Math.round(wordCount(text) / 2.5 / speed);
}

/** True when a hex color is dark enough to need light text on top of it. */
export function isDarkHex(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

export function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}
