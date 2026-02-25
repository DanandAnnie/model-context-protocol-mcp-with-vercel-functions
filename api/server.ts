import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

function describeWeatherCode(code: number): string {
  return WEATHER_CODE_DESCRIPTIONS[code] ?? `Unknown (code ${code})`;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

const handler = createMcpHandler((server) => {
  server.tool(
    "morning_briefing",
    "Get a comprehensive morning briefing with weather, forecast, and day info for a given location",
    {
      latitude: z.number().describe("Latitude of the location"),
      longitude: z.number().describe("Longitude of the location"),
      city: z.string().describe("City name for display"),
    },
    async ({ latitude, longitude, city }) => {
      const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
      weatherUrl.searchParams.set("latitude", String(latitude));
      weatherUrl.searchParams.set("longitude", String(longitude));
      weatherUrl.searchParams.set(
        "current",
        "temperature_2m,apparent_temperature,weather_code,relative_humidity_2m,wind_speed_10m,uv_index",
      );
      weatherUrl.searchParams.set(
        "daily",
        "temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,weather_code",
      );
      weatherUrl.searchParams.set("forecast_days", "3");
      weatherUrl.searchParams.set("timezone", "auto");

      const response = await fetch(weatherUrl.toString());
      const data = await response.json();

      const current = data.current;
      const daily = data.daily;

      const now = new Date();
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      const dayOfYear = Math.ceil(
        (now.getTime() - startOfYear.getTime()) / 86400000,
      );
      const isLeapYear =
        (now.getFullYear() % 4 === 0 && now.getFullYear() % 100 !== 0) ||
        now.getFullYear() % 400 === 0;
      const totalDays = isLeapYear ? 366 : 365;
      const daysRemaining = totalDays - dayOfYear;

      const dateStr = now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      const lines: string[] = [];
      lines.push(`Good morning! Here's your briefing for ${dateStr}.`);
      lines.push(`Day ${dayOfYear} of ${totalDays} (${daysRemaining} days remaining this year).`);
      lines.push("");

      lines.push(`--- Current Weather in ${city} ---`);
      lines.push(`Conditions: ${describeWeatherCode(current.weather_code)}`);
      lines.push(`Temperature: ${current.temperature_2m}°C (feels like ${current.apparent_temperature}°C)`);
      lines.push(`Humidity: ${current.relative_humidity_2m}%`);
      lines.push(`Wind: ${current.wind_speed_10m} km/h`);
      lines.push(`UV Index: ${current.uv_index}`);

      if (daily?.sunrise?.[0]) {
        lines.push(`Sunrise: ${formatTime(daily.sunrise[0])} | Sunset: ${formatTime(daily.sunset[0])}`);
      }
      lines.push("");

      lines.push("--- 3-Day Forecast ---");
      const dayNames = ["Today", "Tomorrow", "Day After"];
      for (let i = 0; i < 3 && i < (daily?.time?.length ?? 0); i++) {
        const precip = daily.precipitation_probability_max[i];
        lines.push(
          `${dayNames[i]} (${daily.time[i]}): ${describeWeatherCode(daily.weather_code[i])}, ` +
            `${daily.temperature_2m_min[i]}–${daily.temperature_2m_max[i]}°C, ` +
            `${precip}% chance of rain`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  server.tool(
    "roll_dice",
    "Rolls an N-sided die",
    { sides: z.number().int().min(2) },
    async ({ sides }) => {
      const value = 1 + Math.floor(Math.random() * sides);
      return {
        content: [{ type: "text", text: `🎲 You rolled a ${value}!` }],
      };
    },
  );

  server.tool(
    "get_weather",
    "Get the current weather at a location",
    {
      latitude: z.number(),
      longitude: z.number(),
      city: z.string(),
    },
    async ({ latitude, longitude, city }) => {
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,relative_humidity_2m&timezone=auto`,
      );
      const weatherData = await response.json();
      return {
        content: [
          {
            type: "text",
            text: `🌤️ Weather in ${city}: ${weatherData.current.temperature_2m}°C, Humidity: ${weatherData.current.relative_humidity_2m}%`,
          },
        ],
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
