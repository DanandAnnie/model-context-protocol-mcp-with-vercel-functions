import { z } from "zod";

export const rollDiceSchema = {
  sides: z.number().int().min(2),
};

export const getWeatherSchema = {
  latitude: z.number(),
  longitude: z.number(),
  city: z.string(),
};

export async function rollDice({ sides }: { sides: number }) {
  const value = 1 + Math.floor(Math.random() * sides);
  return {
    content: [{ type: "text" as const, text: `🎲 You rolled a ${value}!` }],
  };
}

export async function getWeather({
  latitude,
  longitude,
  city,
}: {
  latitude: number;
  longitude: number;
  city: string;
}) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weathercode,relativehumidity_2m&timezone=auto`;
  const response = await fetch(url);

  if (!response.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to fetch weather data for ${city}: ${response.status} ${response.statusText}`,
        },
      ],
      isError: true,
    };
  }

  let weatherData: any;
  try {
    weatherData = await response.json();
  } catch {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to parse weather data for ${city}: invalid JSON response`,
        },
      ],
      isError: true,
    };
  }

  if (!weatherData?.current?.temperature_2m || !weatherData?.current?.relativehumidity_2m) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Unexpected weather data format for ${city}`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `🌤️ Weather in ${city}: ${weatherData.current.temperature_2m}°C, Humidity: ${weatherData.current.relativehumidity_2m}%`,
      },
    ],
  };
}
