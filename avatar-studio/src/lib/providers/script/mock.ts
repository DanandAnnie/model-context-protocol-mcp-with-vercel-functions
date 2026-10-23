import type { ScriptProvider } from "../types";

/** Template-based script writer used when no LLM key is configured. */
export class MockScriptProvider implements ScriptProvider {
  readonly name = "mock";
  async generate({ topic, tone, lengthSec, audience }: { topic: string; tone: string; lengthSec: number; audience?: string }) {
    const who = audience ? ` for ${audience}` : "";
    const sentences = [
      `Hi there! Today I want to talk about ${topic}${who}.`,
      `Here is the short version: ${topic} matters because it changes how you get results day to day.`,
      `First, understand the problem you are solving. Second, pick one clear action. Third, measure what happens.`,
      `If you take one thing away, let it be this: start small and stay consistent.`,
      `Thanks for watching. If this was useful, share it with someone who needs it.`,
    ];
    const target = Math.max(2, Math.min(sentences.length, Math.round(lengthSec / 12)));
    const body = sentences.slice(0, target).join(" ");
    return tone === "formal" ? body.replace("Hi there!", "Hello.") : body;
  }
}
