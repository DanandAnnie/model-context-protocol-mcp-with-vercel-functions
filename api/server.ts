import { createMcpHandler } from "mcp-handler";
import {
  rollDice,
  rollDiceSchema,
  getWeather,
  getWeatherSchema,
} from "./tools.js";

const handler = createMcpHandler((server) => {
  server.tool("roll_dice", "Rolls an N-sided die", rollDiceSchema, rollDice);
  server.tool(
    "get_weather",
    "Get the current weather at a location",
    getWeatherSchema,
    getWeather,
  );
});

export { handler as GET, handler as POST, handler as DELETE };
