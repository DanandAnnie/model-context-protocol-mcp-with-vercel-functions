// Weather tile data — Open-Meteo (no API key required, global coverage).
//
// GET /api/weather?lat=37.0965&lon=-113.5684
// Defaults to St. George, UT (Red Rock Real Estate's footprint).
// Returns current conditions plus 5-day daily forecast in Fahrenheit.

import { getAuthState } from "./services/auth.js";

const DEFAULT_LAT = 37.0965;   // St. George, UT
const DEFAULT_LON = -113.5684;

async function handler(req: Request): Promise<Response> {
  const auth = getAuthState(req);
  if (auth.required && !auth.authenticated) {
    return json(401, { error: "authentication required" });
  }

  const url = new URL(req.url);
  const lat = num(url.searchParams.get("lat"), DEFAULT_LAT);
  const lon = num(url.searchParams.get("lon"), DEFAULT_LON);
  const place = url.searchParams.get("place") || undefined;

  const apiUrl =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,sunrise,sunset` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=5`;

  try {
    const r = await fetch(apiUrl);
    if (!r.ok) return json(502, { error: `open-meteo ${r.status}` });
    const data: any = await r.json();

    return json(200, {
      lat,
      lon,
      place,
      timezone: data.timezone,
      current: {
        temperature_f: round(data.current?.temperature_2m),
        feels_like_f: round(data.current?.apparent_temperature),
        wind_mph: round(data.current?.wind_speed_10m),
        humidity: data.current?.relative_humidity_2m,
        code: data.current?.weather_code,
        condition: weatherCodeToText(data.current?.weather_code),
        emoji: weatherCodeToEmoji(data.current?.weather_code),
        observed_at: data.current?.time,
      },
      daily: (data.daily?.time || []).map((t: string, i: number) => ({
        date: t,
        high_f: round(data.daily.temperature_2m_max?.[i]),
        low_f: round(data.daily.temperature_2m_min?.[i]),
        precip_pct: data.daily.precipitation_probability_max?.[i] ?? null,
        sunrise: data.daily.sunrise?.[i],
        sunset: data.daily.sunset?.[i],
        code: data.daily.weather_code?.[i],
        condition: weatherCodeToText(data.daily.weather_code?.[i]),
        emoji: weatherCodeToEmoji(data.daily.weather_code?.[i]),
      })),
    });
  } catch (e: any) {
    return json(500, { error: e?.message ?? String(e) });
  }
}

function num(s: string | null, fallback: number): number {
  if (s == null || s === "") return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function round(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.round(n);
}

// WMO weather interpretation codes — open-meteo.com/en/docs#weather_variable
function weatherCodeToText(code: number | undefined): string {
  if (code == null) return "Unknown";
  const map: Record<number, string> = {
    0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow",
    77: "Snow grains",
    80: "Rain showers", 81: "Heavy showers", 82: "Violent showers",
    85: "Light snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Severe thunderstorm",
  };
  return map[code] ?? `Code ${code}`;
}

function weatherCodeToEmoji(code: number | undefined): string {
  if (code == null) return "❓";
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "🌨️";
  if (code >= 80 && code <= 82) return "🌧️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

export { handler as GET };
