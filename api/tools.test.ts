import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import {
  rollDice,
  rollDiceSchema,
  getWeather,
  getWeatherSchema,
} from "./tools.js";

// ─── roll_dice schema validation ─────────────────────────────────────────────

describe("rollDiceSchema", () => {
  const schema = z.object(rollDiceSchema);

  it("accepts valid integer >= 2", () => {
    expect(schema.parse({ sides: 6 })).toEqual({ sides: 6 });
    expect(schema.parse({ sides: 2 })).toEqual({ sides: 2 });
    expect(schema.parse({ sides: 100 })).toEqual({ sides: 100 });
  });

  it("rejects sides < 2", () => {
    expect(() => schema.parse({ sides: 1 })).toThrow();
    expect(() => schema.parse({ sides: 0 })).toThrow();
    expect(() => schema.parse({ sides: -5 })).toThrow();
  });

  it("rejects non-integer numbers", () => {
    expect(() => schema.parse({ sides: 3.5 })).toThrow();
  });

  it("rejects non-number types", () => {
    expect(() => schema.parse({ sides: "six" })).toThrow();
    expect(() => schema.parse({ sides: true })).toThrow();
    expect(() => schema.parse({})).toThrow();
  });
});

// ─── getWeatherSchema validation ─────────────────────────────────────────────

describe("getWeatherSchema", () => {
  const schema = z.object(getWeatherSchema);

  it("accepts valid inputs", () => {
    expect(
      schema.parse({ latitude: 40.7, longitude: -74.0, city: "New York" }),
    ).toEqual({ latitude: 40.7, longitude: -74.0, city: "New York" });
  });

  it("rejects non-number latitude/longitude", () => {
    expect(() =>
      schema.parse({ latitude: "40", longitude: -74, city: "NYC" }),
    ).toThrow();
    expect(() =>
      schema.parse({ latitude: 40, longitude: "bad", city: "NYC" }),
    ).toThrow();
  });

  it("rejects non-string city", () => {
    expect(() =>
      schema.parse({ latitude: 40, longitude: -74, city: 123 }),
    ).toThrow();
  });

  it("rejects missing fields", () => {
    expect(() => schema.parse({ latitude: 40 })).toThrow();
    expect(() => schema.parse({})).toThrow();
  });
});

// ─── rollDice function ───────────────────────────────────────────────────────

describe("rollDice", () => {
  it("returns a value between 1 and sides (inclusive)", async () => {
    for (let i = 0; i < 50; i++) {
      const result = await rollDice({ sides: 6 });
      const text = result.content[0].text;
      const match = text.match(/You rolled a (\d+)/);
      expect(match).not.toBeNull();
      const value = Number(match![1]);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
    }
  });

  it("works with minimum sides (2)", async () => {
    const result = await rollDice({ sides: 2 });
    const match = result.content[0].text.match(/You rolled a (\d+)/);
    const value = Number(match![1]);
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(2);
  });

  it("returns correct MCP response structure", async () => {
    const result = await rollDice({ sides: 6 });
    expect(result).toHaveProperty("content");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toHaveProperty("type", "text");
    expect(result.content[0]).toHaveProperty("text");
  });

  it("produces a deterministic result with mocked Math.random", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = await rollDice({ sides: 6 });
    expect(result.content[0].text).toBe("🎲 You rolled a 4!");
    vi.restoreAllMocks();
  });

  it("handles boundary values of Math.random", async () => {
    // Math.random() = 0 should give 1
    vi.spyOn(Math, "random").mockReturnValue(0);
    let result = await rollDice({ sides: 6 });
    expect(result.content[0].text).toBe("🎲 You rolled a 1!");

    // Math.random() just below 1 should give sides
    vi.spyOn(Math, "random").mockReturnValue(0.9999999);
    result = await rollDice({ sides: 6 });
    expect(result.content[0].text).toBe("🎲 You rolled a 6!");

    vi.restoreAllMocks();
  });
});

// ─── getWeather function ─────────────────────────────────────────────────────

describe("getWeather", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns formatted weather on success", async () => {
    const mockData = {
      current: {
        temperature_2m: 22.5,
        relativehumidity_2m: 65,
        weathercode: 0,
      },
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await getWeather({
      latitude: 40.7,
      longitude: -74.0,
      city: "New York",
    });

    expect(result.content[0].text).toBe(
      "🌤️ Weather in New York: 22.5°C, Humidity: 65%",
    );
    expect(result).not.toHaveProperty("isError");
  });

  it("constructs the correct API URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 20, relativehumidity_2m: 50 },
      }),
    } as Response);

    await getWeather({ latitude: 51.5, longitude: -0.12, city: "London" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.12&current=temperature_2m,weathercode,relativehumidity_2m&timezone=auto",
    );
  });

  it("returns error on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    const result = await getWeather({
      latitude: 40.7,
      longitude: -74.0,
      city: "New York",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to fetch weather data");
    expect(result.content[0].text).toContain("500");
  });

  it("returns error on invalid JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    } as Response);

    const result = await getWeather({
      latitude: 40.7,
      longitude: -74.0,
      city: "New York",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("invalid JSON response");
  });

  it("returns error on unexpected data shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: "data" }),
    } as Response);

    const result = await getWeather({
      latitude: 40.7,
      longitude: -74.0,
      city: "New York",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unexpected weather data format");
  });

  it("returns error when current data is partially missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ current: { temperature_2m: 20 } }),
    } as Response);

    const result = await getWeather({
      latitude: 40.7,
      longitude: -74.0,
      city: "Tokyo",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unexpected weather data format");
  });

  it("returns correct MCP response structure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 15, relativehumidity_2m: 80 },
      }),
    } as Response);

    const result = await getWeather({
      latitude: 48.8,
      longitude: 2.35,
      city: "Paris",
    });

    expect(result).toHaveProperty("content");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toHaveProperty("type", "text");
  });
});

// ─── server.ts exports ──────────────────────────────────────────────────────

describe("server exports", () => {
  it("exports GET, POST, and DELETE handlers", async () => {
    const server = await import("./server.js");
    expect(typeof server.GET).toBe("function");
    expect(typeof server.POST).toBe("function");
    expect(typeof server.DELETE).toBe("function");
  });
});
