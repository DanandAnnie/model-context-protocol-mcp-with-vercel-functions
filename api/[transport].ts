import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { morningBriefing, rollDice, getWeather } from "../lib/tools";

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "morning_briefing",
      "Get a comprehensive morning briefing with weather, forecast, and day info for a given location",
      {
        latitude: z.number().describe("Latitude of the location"),
        longitude: z.number().describe("Longitude of the location"),
        city: z.string().describe("City name for display"),
      },
      async ({ latitude, longitude, city }) => {
        const text = await morningBriefing({ latitude, longitude, city });
        return { content: [{ type: "text", text }] };
      },
    );

    server.tool(
      "roll_dice",
      "Rolls an N-sided die",
      { sides: z.number().int().min(2) },
      async ({ sides }) => {
        const text = await rollDice({ sides });
        return { content: [{ type: "text", text }] };
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
        const text = await getWeather({ latitude, longitude, city });
        return { content: [{ type: "text", text }] };
      },
    );
  },
  {},
  {
    redisUrl: process.env.REDIS_URL || process.env.KV_URL,
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: false,
    disableSse: true,
  },
);

export { handler as GET, handler as POST, handler as DELETE };
